import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

export const DEFAULT_EXPECTED_STAGING = 'https://staging-modern.veloratrade.ir';
export const PRODUCTION_HOSTS = new Set(['veloratrade.ir', 'www.veloratrade.ir']);
export const KEY = 'FRONTEND_URL';

export type Severity = 'BLOCK' | 'WARN';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
}

export interface EvaluationResult {
  passed: boolean;
  appEnv: string;
  isProduction: boolean;
  expectedOrigin: string;
  findings: Finding[];
  blockingCount: number;
}

export function parseEnvFile(filePath: string): Record<string, string> {
  const data: Record<string, string> = {};
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cannot read env file: File not found at ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;

    const eqIdx = line.indexOf('=');
    const key = line.substring(0, eqIdx).trim();
    let value = line.substring(eqIdx + 1).trim();

    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
      value = value.substring(1, value.length - 1);
    }

    data[key] = value;
  }

  return data;
}

export function evaluateFrontendUrl(
  value: string | undefined,
  expected: string,
  isProduction: boolean,
): Finding[] {
  const findings: Finding[] = [];
  const defaultSev: Severity = isProduction ? 'WARN' : 'BLOCK';

  // Rule 1 / FU-000: Missing or empty
  if (!value || value.trim() === '') {
    findings.push({
      code: 'FU-000',
      severity: defaultSev,
      message: `${KEY} is missing or empty. Every link becomes a relative URL and same-origin security policy rejects cookie state.`,
    });
    return findings;
  }

  const raw = value.trim();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    findings.push({
      code: 'FU-001',
      severity: defaultSev,
      message: `${KEY} is malformed: it could not be parsed as a URL.`,
    });
    return findings;
  }

  // Rule 6 / FU-001: Missing scheme or host
  if (!parsed.protocol || !parsed.hostname) {
    findings.push({
      code: 'FU-001',
      severity: defaultSev,
      message: `${KEY} is malformed: it must be an absolute origin URL.`,
    });
    return findings;
  }

  // Rule 7a / FU-002: Scheme must be https (unless local dev/test on localhost)
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && (!isLocalhost || isProduction)) {
    findings.push({
      code: 'FU-002',
      severity: defaultSev,
      message: `${KEY} scheme must be https. Non-https origins cannot satisfy Secure cookie contracts.`,
    });
  }

  // Rule 7b / FU-003: Bare origin required (no path except /, no query, no hash, no creds)
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    findings.push({
      code: 'FU-003',
      severity: defaultSev,
      message: `${KEY} must be a bare origin with no path or trailing slash.`,
    });
  }
  if (parsed.search) {
    findings.push({
      code: 'FU-003',
      severity: defaultSev,
      message: `${KEY} must not contain a query string.`,
    });
  }
  if (parsed.hash) {
    findings.push({
      code: 'FU-003',
      severity: defaultSev,
      message: `${KEY} must not contain a URL fragment/hash.`,
    });
  }
  if (parsed.username || parsed.password) {
    findings.push({
      code: 'FU-003',
      severity: defaultSev,
      message: `${KEY} must not embed credentials.`,
    });
  }

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');

  // Rule 2 / FU-004: Never production domain outside production
  if (!isProduction && PRODUCTION_HOSTS.has(host)) {
    findings.push({
      code: 'FU-004',
      severity: 'BLOCK',
      message: `${KEY} points at the PRODUCTION domain while APP_ENV is not production. Staging users would receive production verification links.`,
    });
  }

  // Rule 3 / FU-005: Match expected staging origin if in staging mode
  let expectedHost = '';
  try {
    expectedHost = new URL(expected).hostname.toLowerCase();
  } catch {
    expectedHost = expected.toLowerCase();
  }

  if (!isProduction && !PRODUCTION_HOSTS.has(host) && !isLocalhost && host !== expectedHost) {
    findings.push({
      code: 'FU-005',
      severity: defaultSev,
      message: `${KEY} host does not match the expected staging origin (${expected}).`,
    });
  }

  // Rule 8 / FU-006: Non-default port check
  if (parsed.port && parsed.port !== '443' && parsed.port !== '80') {
    if (!isLocalhost) {
      findings.push({
        code: 'FU-006',
        severity: defaultSev,
        message: `${KEY} specifies a non-default port component.`,
      });
    }
  }

  return findings;
}

export function runGuard(
  envData: Record<string, string>,
  opts: {
    appEnvOverride?: string;
    expectedOrigin?: string;
    strictProduction?: boolean;
  } = {},
): EvaluationResult {
  const appEnv = (opts.appEnvOverride || envData.APP_ENV || 'production').trim().toLowerCase();
  let isProduction = !['dev', 'development', 'staging', 'stage', 'test'].includes(appEnv);
  if (opts.strictProduction) {
    isProduction = false;
  }

  const expectedOrigin = opts.expectedOrigin || DEFAULT_EXPECTED_STAGING;
  const rawValue = envData[KEY];

  const findings = evaluateFrontendUrl(rawValue, expectedOrigin, isProduction);
  const blockingCount = findings.filter((f) => f.severity === 'BLOCK').length;

  return {
    passed: blockingCount === 0,
    appEnv,
    isProduction,
    expectedOrigin,
    findings,
    blockingCount,
  };
}

export function main(args: string[] = process.argv.slice(2)): number {
  let envData: Record<string, string> | null = null;
  let appEnvOverride: string | undefined;
  let expectedOrigin = DEFAULT_EXPECTED_STAGING;
  let strictProduction = false;
  let sourceSpecified = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--env-file' && i + 1 < args.length) {
      try {
        envData = parseEnvFile(args[++i]);
        sourceSpecified = true;
      } catch (err) {
        console.error(`ERROR: ${(err as Error).message}`);
        return 2;
      }
    } else if (arg === '--from-env') {
      envData = { ...process.env as Record<string, string> };
      sourceSpecified = true;
    } else if (arg === '--app-env' && i + 1 < args.length) {
      appEnvOverride = args[++i];
    } else if (arg === '--expect' && i + 1 < args.length) {
      expectedOrigin = args[++i];
    } else if (arg === '--strict-production') {
      strictProduction = true;
    }
  }

  // Require mandatory source selection (--from-env OR --env-file <path>) matching PHP contract
  if (!sourceSpecified || !envData) {
    console.error('ERROR: Either --from-env or --env-file <path> must be specified as input source.');
    return 2;
  }

  const res = runGuard(envData, { appEnvOverride, expectedOrigin, strictProduction });

  console.log('VELORA FRONTEND_URL guard');
  console.log(`  APP_ENV        : ${res.appEnv}`);
  console.log(`  mode           : ${res.isProduction ? 'production (advisory)' : 'non-production (blocking)'}`);
  console.log(`  expected origin: ${res.expectedOrigin}`);
  console.log('  note           : variable values are never printed.\n');

  if (res.findings.length === 0) {
    console.log('  ✅ PASS — FRONTEND_URL is explicitly defined and matches the staging contract.');
    return 0;
  }

  for (const f of res.findings) {
    const icon = f.severity === 'BLOCK' ? '❌' : '⚠️';
    console.log(`  ${icon} [${f.code}] ${f.severity}: ${f.message}`);
  }
  console.log();

  if (!res.passed) {
    console.log(`RESULT: FAIL — ${res.blockingCount} blocking finding(s).`);
    return 1;
  }

  console.log('RESULT: PASS (advisory findings only; production behavior left unchanged).');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  process.exit(main());
}
