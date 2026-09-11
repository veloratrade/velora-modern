import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  evaluateFrontendUrl,
  runGuard,
  main,
  parseEnvFile,
  DEFAULT_EXPECTED_STAGING,
} from '../../scripts/validate-frontend-url.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Frontend URL Guard Validator (Phase 6.6C)', () => {
  it('FU-000: reports blocking finding when FRONTEND_URL is missing or empty in non-prod', () => {
    const findings = evaluateFrontendUrl('', DEFAULT_EXPECTED_STAGING, false);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('FU-000');
    expect(findings[0].severity).toBe('BLOCK');
  });

  it('FU-000: reports WARN finding when FRONTEND_URL is missing or empty in production', () => {
    const findings = evaluateFrontendUrl('', DEFAULT_EXPECTED_STAGING, true);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('FU-000');
    expect(findings[0].severity).toBe('WARN');
  });

  it('FU-001: reports finding when URL is malformed', () => {
    const findings = evaluateFrontendUrl('not-a-valid-url', DEFAULT_EXPECTED_STAGING, false);
    expect(findings.some((f) => f.code === 'FU-001')).toBe(true);
  });

  it('FU-002: rejects non-https scheme outside local dev', () => {
    const findings = evaluateFrontendUrl(
      'http://staging-modern.veloratrade.ir',
      DEFAULT_EXPECTED_STAGING,
      false,
    );
    expect(findings.some((f) => f.code === 'FU-002')).toBe(true);
  });

  it('FU-003: rejects URL with path suffix, query string, fragment, or credentials', () => {
    const findingsPath = evaluateFrontendUrl(
      'https://staging-modern.veloratrade.ir/path',
      DEFAULT_EXPECTED_STAGING,
      false,
    );
    expect(findingsPath.some((f) => f.code === 'FU-003')).toBe(true);

    const findingsQuery = evaluateFrontendUrl(
      'https://staging-modern.veloratrade.ir?token=secret',
      DEFAULT_EXPECTED_STAGING,
      false,
    );
    expect(findingsQuery.some((f) => f.code === 'FU-003')).toBe(true);

    const findingsHash = evaluateFrontendUrl(
      'https://staging-modern.veloratrade.ir#anchor',
      DEFAULT_EXPECTED_STAGING,
      false,
    );
    expect(findingsHash.some((f) => f.code === 'FU-003')).toBe(true);

    const findingsCreds = evaluateFrontendUrl(
      'https://user:pass@staging-modern.veloratrade.ir',
      DEFAULT_EXPECTED_STAGING,
      false,
    );
    expect(findingsCreds.some((f) => f.code === 'FU-003')).toBe(true);
  });

  it('FU-004: BLOCK finding if non-production environment uses production domain', () => {
    const findings = evaluateFrontendUrl('https://veloratrade.ir', DEFAULT_EXPECTED_STAGING, false);
    expect(findings.some((f) => f.code === 'FU-004' && f.severity === 'BLOCK')).toBe(true);
  });

  it('FU-005: finding if staging environment does not match expected staging origin', () => {
    const findings = evaluateFrontendUrl(
      'https://wrong-staging-domain.com',
      DEFAULT_EXPECTED_STAGING,
      false,
    );
    expect(findings.some((f) => f.code === 'FU-005')).toBe(true);
  });

  it('FU-006: rejects non-default port in non-localhost URLs', () => {
    const findings = evaluateFrontendUrl(
      'https://staging-modern.veloratrade.ir:8443',
      DEFAULT_EXPECTED_STAGING,
      false,
    );
    expect(findings.some((f) => f.code === 'FU-006')).toBe(true);
  });

  it('PASS: valid staging FRONTEND_URL matching expected staging origin', () => {
    const findings = evaluateFrontendUrl(DEFAULT_EXPECTED_STAGING, DEFAULT_EXPECTED_STAGING, false);
    expect(findings.filter((f) => f.severity === 'BLOCK')).toHaveLength(0);
  });

  it('PASS: local dev frontend URL with localhost permitted', () => {
    const findings = evaluateFrontendUrl('http://localhost:3000', DEFAULT_EXPECTED_STAGING, false);
    expect(findings.filter((f) => f.severity === 'BLOCK')).toHaveLength(0);
  });

  it('Mandatory CLI Source Selection: main exits code 2 if neither --from-env nor --env-file is specified', () => {
    const exitCode = main(['--app-env', 'dev']);
    expect(exitCode).toBe(2);
  });

  it('CLI Source Selection: works with --env-file', () => {
    const envPath = path.join(__dirname, 'test.env');
    fs.writeFileSync(envPath, `FRONTEND_URL=${DEFAULT_EXPECTED_STAGING}\nAPP_ENV=staging`, 'utf-8');

    try {
      const parsed = parseEnvFile(envPath);
      const res = runGuard(parsed);
      expect(res.passed).toBe(true);
    } finally {
      fs.rmSync(envPath, { force: true });
    }
  });

  it('Secret Safety: runGuard and evaluation output NEVER print raw FRONTEND_URL secret value', () => {
    const secretUrl = 'https://super-secret-token-holder.veloratrade.ir';
    const res = runGuard({ FRONTEND_URL: secretUrl, APP_ENV: 'staging' });
    const textOutput = JSON.stringify(res);
    expect(textOutput).not.toContain(secretUrl);
  });
});
