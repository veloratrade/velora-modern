/**
 * VELORA SECRET SCAN — committed-secret / forbidden-file / real-user-data scan.
 *
 * Semantic port of the PHP `secret-scan` job
 * (`.github/workflows/csp-guard.yml`, job `secret-scan`):
 *   1. Forbidden files must never be committed.
 *   2. Real user data (password hashes, public-mail addresses) must never
 *      appear in SQL/dump files, even in a private repo.
 * Modern-native extension (rule set 3): high-precision committed-secret
 * patterns for the credential types this repository actually handles
 * (Railway/Resend/Gemini/GitHub/Slack tokens, private keys, AWS keys,
 * password-style assignments). The PHP repo never scanned for these; the
 * responsibility (leak prevention) is preserved and strengthened, not copied.
 *
 * Output discipline (hard rule): findings print REPOSITORY PATH + LINE NUMBER
 * + RULE ID only. Matched secret VALUES are never printed, logged, or
 * persisted. A finding line must be safe to paste into a public log.
 *
 * Exit codes: 0 = clean, 1 = findings (fail-closed), 2 = usage error.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export interface SecretFinding {
  /** Repository-relative path. */
  file: string;
  /** 1-based line number (0 when the finding is file-level, e.g. forbidden name). */
  line: number;
  /** Stable rule identifier, e.g. `FORBIDDEN_FILE`, `SQL_BCRYPT_HASH`, `AWS_KEY`. */
  rule: string;
  /** Human-readable note. MUST NOT contain the matched value. */
  note: string;
}

export interface ScanResult {
  clean: boolean;
  findings: SecretFinding[];
  filesScanned: number;
}

/** Forbidden committed filenames (PHP rule 1, adapted: `.env.example` stays allowed). */
const FORBIDDEN_BASENAMES = new Set(['.env', 'id_rsa', 'id_ed25519']);
const FORBIDDEN_EXTENSIONS = new Set(['.pem', '.key', '.sqlite', '.sqlite3', '.p12', '.pfx']);

function isForbiddenFile(relPath: string): boolean {
  const base = path.basename(relPath);
  if (base === '.env.example') return false;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  const ext = path.extname(base).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(ext)) return true;
  return false;
}

const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
  'live.com',
]);

const EMAIL_RE = /[\w.%-]+@[\w.-]+\.[a-z]{2,}/gi;
const BCRYPT_RE = /\$2[aby]\$\d{2}\$/g;

/** Obvious placeholder/dummy markers: values containing these never count as secrets. */
const PLACEHOLDER_MARKERS = [
  'your-',
  'your_',
  'example',
  'changeme',
  'change-me',
  'placeholder',
  'xxx',
  'test-test',
  '***',
  '...',
  '<',
  '>',
];

function looksPlaceholder(value: string): boolean {
  const low = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((m) => low.includes(m));
}

/**
 * Textbook dummy passwords used across the test suite (`Password123!`,
 * `SecurePass123`, ...). A value counts as a dummy only when it is ENTIRELY
 * one of these well-known stems plus optional digits and one trailing symbol —
 * anything else (mixed case mid-string, longer entropy) is still flagged.
 */
const DUMMY_PASSWORD_RE =
  /^(?:qwerty|letmein|p@ssw0rd|(?:another|new|wrong|old|test|my|sample|dummy|fake|mock|user|correct|incorrect|valid|invalid|strong|weak|good|bad)?(?:secure)?(?:pass|password|pwd)\d*)$/;

/**
 * Validation/API message strings stored under password-named keys
 * (`newPassword: 'New password must differ...'`) are user-facing sentences,
 * not credentials. A value counts as a message when it contains sentence
 * glue words. Real secrets (even passphrases) that happen to contain these
 * words would be skipped — accepted residual risk, documented here; the
 * key-pattern rules (AWS/Resend/GitHub/...) have no such guard.
 */
const MESSAGE_GLUE_WORDS = [
  ' is ',
  ' are ',
  ' was ',
  ' must ',
  ' should ',
  ' the ',
  ' a ',
  ' an ',
  ' your ',
  ' you ',
  ' from ',
  ' with ',
  'incorrect',
  'different',
  'invalid',
  'required',
  'missing',
  'please',
  'error',
  'failed',
];

function looksMessageString(value: string): boolean {
  const low = ` ${value.toLowerCase()} `;
  return MESSAGE_GLUE_WORDS.some((w) => low.includes(w));
}

function looksDummyPassword(value: string): boolean {
  const low = value.toLowerCase().replace(/[!@#$%^&*]+$/, '');
  return DUMMY_PASSWORD_RE.test(low);
}

/**
 * Dummy credential pairs in connection strings (`root:root`, `user:pass`,
 * ...) are skipped ONLY on loopback hosts. Any credentialed URL pointing at a
 * non-loopback host is always flagged, even with dummy-looking credentials
 * (it proves the pattern of committing credentialed URLs).
 */
const DUMMY_DB_CREDENTIALS = new Set([
  'root',
  'user',
  'test',
  'admin',
  'pass',
  'password',
  'toor',
  'db',
  'app',
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function looksDummyLocalConnection(lineText: string): boolean {
  // NOTE: evaluated against the FULL line, because the detection match itself
  // ends at '@' and does not include the host part.
  const m =
    /(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis(?:s)?):\/\/([^/\s:]*):([^/\s@]+)@([^/\s:]+)/i.exec(
      lineText,
    );
  if (!m) return false;
  const [, user, pass, host] = m;
  return (
    LOOPBACK_HOSTS.has(host.toLowerCase()) &&
    (user === '' || DUMMY_DB_CREDENTIALS.has(user.toLowerCase())) &&
    DUMMY_DB_CREDENTIALS.has(pass.toLowerCase())
  );
}

interface SecretPattern {
  rule: string;
  note: string;
  regex: RegExp;
  /** When true, placeholder-looking matches are skipped (default true). */
  skipPlaceholders?: boolean;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    rule: 'PRIVATE_KEY',
    note: 'private key material must never be committed',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    skipPlaceholders: false,
  },
  {
    rule: 'AWS_KEY',
    note: 'AWS access key id pattern',
    regex: /\bAKIA[0-9A-Z]{16}\b/,
    skipPlaceholders: false,
  },
  {
    rule: 'RESEND_KEY',
    note: 'Resend API key pattern',
    regex: /\bre_[A-Za-z0-9_-]{16,}\b/,
  },
  {
    rule: 'ANTHROPIC_KEY',
    note: 'Anthropic API key pattern',
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,
  },
  {
    rule: 'GEMINI_KEY',
    note: 'Google API key pattern',
    regex: /\bAIza[0-9A-Za-z_-]{30,}\b/,
  },
  {
    rule: 'GITHUB_TOKEN',
    note: 'GitHub token pattern',
    regex: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,})\b/,
    skipPlaceholders: false,
  },
  {
    rule: 'SLACK_TOKEN',
    note: 'Slack token pattern',
    regex: /\bxox[bpras]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    rule: 'PASSWORD_ASSIGNMENT',
    note: 'password/secret assigned a literal value (use env + placeholder)',
    regex:
      /(?:password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*['"]([^'"]{8,})['"]/i,
  },
  {
    rule: 'CONNECTION_STRING_SECRET',
    note: 'connection string with embedded credentials',
    regex: /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis(?:s)?):\/\/[^/\s:]*:[^/\s@]+@/i,
  },
];

const SCAN_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.md',
  '.txt',
  '.sh',
  '.sql',
  '.dump',
  '.env.example',
]);

function shouldScanContent(relPath: string): boolean {
  const base = path.basename(relPath);
  if (base === '.env.example') return true;
  const ext = path.extname(base).toLowerCase();
  return SCAN_EXTENSIONS.has(ext);
}

function scanSqlUserData(relPath: string, content: string, findings: SecretFinding[]): void {
  const bcryptHits = content.match(BCRYPT_RE) ?? [];
  if (bcryptHits.length > 0) {
    findings.push({
      file: relPath,
      line: 0,
      rule: 'SQL_BCRYPT_HASH',
      note: `real password hashes in SQL/dump (${bcryptHits.length} occurrence(s)) — backups never belong in git`,
    });
  }
  const mails = new Set<string>();
  for (const m of content.match(EMAIL_RE) ?? []) {
    const domain = m.split('@')[1].toLowerCase();
    if (PUBLIC_MAIL_DOMAINS.has(domain)) mails.add(domain);
  }
  if (mails.size > 0) {
    findings.push({
      file: relPath,
      line: 0,
      rule: 'SQL_PUBLIC_MAIL',
      note: `real public-mail addresses in SQL/dump (domain(s): ${[...mails].sort().join(', ')})`,
    });
  }
}

function scanSecretPatterns(relPath: string, lines: string[], findings: SecretFinding[]): void {
  lines.forEach((lineText, idx) => {
    const trimmed = lineText.trim();
    const isCommentLine = trimmed.startsWith('#') || trimmed.startsWith('//');
    for (const pattern of SECRET_PATTERNS) {
      // Documented dummy credentials in full-line comments (e.g. the commented
      // `DATABASE_URL=mysql://root:password@localhost/...` template in
      // `.env.example`) are not leaks. Real key material is flagged even in
      // comments: commenting out a live key does not un-commit it.
      if (
        isCommentLine &&
        (pattern.rule === 'PASSWORD_ASSIGNMENT' || pattern.rule === 'CONNECTION_STRING_SECRET')
      ) {
        continue;
      }
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(lineText);
      if (!match) continue;
      const matched = match[1] ?? match[0];
      if (pattern.skipPlaceholders !== false && looksPlaceholder(matched)) continue;
      if (
        pattern.rule === 'PASSWORD_ASSIGNMENT' &&
        (looksDummyPassword(match[1] ?? '') || looksMessageString(match[1] ?? ''))
      ) {
        continue;
      }
      if (pattern.rule === 'CONNECTION_STRING_SECRET' && looksDummyLocalConnection(lineText)) {
        continue;
      }
      findings.push({ file: relPath, line: idx + 1, rule: pattern.rule, note: pattern.note });
    }
  });
}

/**
 * Scan a list of repo-relative files. `readFile` is injectable for tests so no
 * fixture secrets ever touch the real repository.
 */
export function scanFiles(
  relPaths: string[],
  readFile: (relPath: string) => string | null,
): ScanResult {
  const findings: SecretFinding[] = [];
  let filesScanned = 0;
  for (const relPath of relPaths) {
    if (relPath.startsWith('.git/') || relPath.includes('node_modules/')) continue;
    if (isForbiddenFile(relPath)) {
      findings.push({
        file: relPath,
        line: 0,
        rule: 'FORBIDDEN_FILE',
        note: 'forbidden filename must never be committed',
      });
      continue;
    }
    if (!shouldScanContent(relPath)) continue;
    const content = readFile(relPath);
    if (content === null) continue;
    filesScanned += 1;
    const ext = path.extname(relPath).toLowerCase();
    if (ext === '.sql' || ext === '.dump') {
      scanSqlUserData(relPath, content, findings);
    }
    scanSecretPatterns(relPath, content.split('\n'), findings);
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { clean: findings.length === 0, findings, filesScanned };
}

export function getTrackedFiles(rootDir: string = ROOT): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf-8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function scanRepo(rootDir: string = ROOT): ScanResult {
  return scanFiles(getTrackedFiles(rootDir), (relPath) => {
    try {
      return fs.readFileSync(path.join(rootDir, relPath), 'utf-8');
    } catch {
      return null;
    }
  });
}

export function main(args: string[] = process.argv.slice(2)): number {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: secret-scan.ts [--staged]   (default: scan git-tracked files)');
    return 2;
  }
  let files: string[];
  if (args.includes('--staged')) {
    try {
      const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: ROOT,
        encoding: 'utf-8',
      });
      files = out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      console.error('::error::SECRET SCAN: cannot list staged files');
      return 2;
    }
  } else {
    files = getTrackedFiles(ROOT);
  }
  const result = scanFiles(files, (relPath) => {
    try {
      return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
    } catch {
      return null;
    }
  });
  if (result.clean) {
    console.log(`SECRET SCAN CLEAN — ${result.filesScanned} file(s) scanned, 0 findings`);
    return 0;
  }
  console.log('SECRET SCAN FAIL');
  for (const f of result.findings) {
    const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
    console.log(`- ${loc} [${f.rule}] ${f.note}`);
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  process.exit(main());
}
