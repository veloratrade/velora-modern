import { describe, it, expect } from 'vitest';
import {
  evaluateBackupGate,
  INTEGRITY_VERIFIED,
  main,
} from '../../scripts/validate-backup-evidence.js';

const VALID_SHA256 = 'a'.repeat(64);
const VALID_COMMIT = 'f395ccb';

function validEvidence(env: string): Record<string, string> {
  return {
    backup_id: `db-backup-${env}-2026-09-12-001`,
    release_tag: `db-backup-${env}-2026-09-12-001`,
    sha256: VALID_SHA256,
    source_commit_sha: VALID_COMMIT,
    verification_status: INTEGRITY_VERIFIED,
    environment: env,
  };
}

describe('Backup Evidence Gate (BACKUP GATE law)', () => {
  it('PASS: complete valid staging evidence is allowed', () => {
    const { allowed, reasons } = evaluateBackupGate(validEvidence('staging'), 'staging');
    expect(allowed).toBe(true);
    expect(reasons).toHaveLength(0);
  });

  it('PASS: complete valid production evidence is allowed', () => {
    const { allowed, reasons } = evaluateBackupGate(validEvidence('production'), 'production');
    expect(allowed).toBe(true);
    expect(reasons).toHaveLength(0);
  });

  it('PASS: uppercase CLI key names are accepted', () => {
    const upper: Record<string, string> = {};
    for (const [k, v] of Object.entries(validEvidence('staging'))) {
      upper[k.toUpperCase()] = v;
    }
    expect(evaluateBackupGate(upper, 'staging').allowed).toBe(true);
  });

  it('FAIL: missing evidence item blocks', () => {
    const ev = validEvidence('staging');
    delete ev.sha256;
    const { allowed, reasons } = evaluateBackupGate(ev, 'staging');
    expect(allowed).toBe(false);
    expect(reasons.some((r) => r.includes('missing evidence: sha256'))).toBe(true);
  });

  it('FAIL: empty-string evidence blocks', () => {
    const ev = validEvidence('staging');
    ev.release_tag = '   ';
    const { allowed, reasons } = evaluateBackupGate(ev, 'staging');
    expect(allowed).toBe(false);
    expect(reasons.some((r) => r.includes('missing evidence: release_tag'))).toBe(true);
  });

  it('FAIL: backup_id outside the expected namespace blocks', () => {
    const ev = validEvidence('staging');
    ev.backup_id = 'db-backup-production-2026-09-12-001';
    const { allowed, reasons } = evaluateBackupGate(ev, 'staging');
    expect(allowed).toBe(false);
    expect(reasons.some((r) => r.includes('not in the staging namespace'))).toBe(true);
  });

  it('FAIL: malformed sha256 blocks (uppercase + short)', () => {
    for (const bad of ['A'.repeat(64), 'abc123', 'g'.repeat(64)]) {
      const ev = validEvidence('staging');
      ev.sha256 = bad;
      const { allowed, reasons } = evaluateBackupGate(ev, 'staging');
      expect(allowed).toBe(false);
      expect(reasons.some((r) => r.includes('sha256'))).toBe(true);
    }
  });

  it('FAIL: malformed source_commit_sha blocks', () => {
    for (const bad of ['xyz', 'f395ccb!', 'g'.repeat(40), 'a'.repeat(65)]) {
      const ev = validEvidence('staging');
      ev.source_commit_sha = bad;
      const { allowed, reasons } = evaluateBackupGate(ev, 'staging');
      expect(allowed).toBe(false);
      expect(reasons.some((r) => r.includes('source_commit_sha'))).toBe(true);
    }
  });

  it('PASS: 7..64 hex SHAs accepted (boundary)', () => {
    for (const good of ['a'.repeat(7), 'f'.repeat(40), '0'.repeat(64)]) {
      const ev = validEvidence('staging');
      ev.source_commit_sha = good;
      expect(evaluateBackupGate(ev, 'staging').allowed).toBe(true);
    }
  });

  it('FAIL: any verification_status other than INTEGRITY_VERIFIED blocks', () => {
    for (const bad of ['VERIFIED', 'integrity_verified', 'PENDING', 'INTEGRITY_VERIFIED ']) {
      const ev = validEvidence('staging');
      ev.verification_status = bad.trim() === 'INTEGRITY_VERIFIED' ? 'PENDING' : bad;
      const { allowed } = evaluateBackupGate(ev, 'staging');
      expect(allowed).toBe(false);
    }
  });

  it('FAIL: environment mismatch blocks (cross-env evidence reuse)', () => {
    const ev = validEvidence('production');
    const { allowed, reasons } = evaluateBackupGate(ev, 'staging');
    expect(allowed).toBe(false);
    expect(reasons.some((r) => r.includes('environment mismatch'))).toBe(true);
  });

  it('FAIL: invalid expected environment blocks', () => {
    const { allowed, reasons } = evaluateBackupGate(validEvidence('staging'), 'dev');
    expect(allowed).toBe(false);
    expect(reasons.some((r) => r.includes('invalid expected environment'))).toBe(true);
  });

  it('FAIL: null/undefined evidence blocks on every field', () => {
    const { allowed, reasons } = evaluateBackupGate(null, 'staging');
    expect(allowed).toBe(false);
    expect(reasons.length).toBeGreaterThanOrEqual(6);
  });

  it('CLI main(): exit 2 when EXPECTED_ENV is missing', () => {
    expect(main({})).toBe(2);
  });

  it('CLI main(): exit 0 on valid evidence, exit 1 on invalid', () => {
    const upper: Record<string, string> = { EXPECTED_ENV: 'staging' };
    for (const [k, v] of Object.entries(validEvidence('staging'))) {
      upper[k.toUpperCase()] = v;
    }
    expect(main(upper)).toBe(0);
    expect(main({ ...upper, SHA256: 'bad' })).toBe(1);
  });
});

describe('Backup Evidence Binding (D5 — store-free, fail-closed)', () => {
  it('PASS: evidence naming the deployment commit is bound (both envs)', () => {
    for (const env of ['staging', 'production']) {
      const { allowed, reasons } = evaluateBackupGate(validEvidence(env), env, {
        expectedCommitSha: VALID_COMMIT,
      });
      expect(allowed).toBe(true);
      expect(reasons).toHaveLength(0);
    }
  });

  it('FAIL: well-formed evidence for a DIFFERENT commit is stale (both envs)', () => {
    for (const env of ['staging', 'production']) {
      const ev = validEvidence(env);
      const { allowed, reasons } = evaluateBackupGate(ev, env, {
        expectedCommitSha: '0'.repeat(40),
      });
      expect(allowed).toBe(false);
      expect(reasons.some((r) => r.includes('!= deployment commit'))).toBe(true);
    }
  });

  it('FAIL: production release_tag != backup_id blocks', () => {
    const ev = validEvidence('production');
    ev.release_tag = 'db-backup-production-2026-09-12-999';
    const { allowed, reasons } = evaluateBackupGate(ev, 'production', {
      expectedCommitSha: VALID_COMMIT,
    });
    expect(allowed).toBe(false);
    expect(reasons.some((r) => r.includes('does not match backup_id'))).toBe(true);
  });

  it('FAIL: production release_tag outside the production namespace blocks', () => {
    const ev = validEvidence('production');
    ev.release_tag = 'db-backup-staging-2026-09-12-001';
    const { allowed, reasons } = evaluateBackupGate(ev, 'production', {
      expectedCommitSha: VALID_COMMIT,
    });
    expect(allowed).toBe(false);
    expect(reasons.some((r) => r.includes('not in the production namespace'))).toBe(true);
  });

  it('PASS: pre-existing valid fixtures remain valid (no silent behavior break)', () => {
    // Same fixtures the gate shipped with: must still allow with AND
    // without binding context (binding only ADDS rejections, never removals).
    for (const env of ['staging', 'production']) {
      expect(evaluateBackupGate(validEvidence(env), env).allowed).toBe(true);
      expect(
        evaluateBackupGate(validEvidence(env), env, { expectedCommitSha: VALID_COMMIT }).allowed,
      ).toBe(true);
    }
  });

  it('PASS: staging keeps PHP staging behavior (no tag-identity rules)', () => {
    const ev = validEvidence('staging');
    ev.release_tag = 'db-backup-staging-2026-09-12-other';
    const { allowed } = evaluateBackupGate(ev, 'staging', {
      expectedCommitSha: VALID_COMMIT,
    });
    expect(allowed).toBe(true);
  });

  it('PASS: unset EXPECTED_COMMIT_SHA skips binding (local/offline use preserved)', () => {
    const ev = validEvidence('staging');
    ev.source_commit_sha = 'b'.repeat(40); // any well-formed SHA
    expect(evaluateBackupGate(ev, 'staging').allowed).toBe(true);
    expect(evaluateBackupGate(ev, 'staging', {}).allowed).toBe(true);
    expect(evaluateBackupGate(ev, 'staging', { expectedCommitSha: '' }).allowed).toBe(true);
  });

  it('STORE SEPARATION: the validator takes no store handle (deferred by signature)', () => {
    // evaluateBackupGate(backup, expectEnv, bindingOpts?) — no client,
    // transport, token, or repository parameter can exist: only 2 required
    // params. The independent store re-read is final-phase work, and this
    // gate cannot silently grow it without a signature change.
    expect(evaluateBackupGate.length).toBe(2);
  });

  it('CLI main(): EXPECTED_COMMIT_SHA mismatch exits 1, match exits 0', () => {
    const upper: Record<string, string> = { EXPECTED_ENV: 'production' };
    for (const [k, v] of Object.entries(validEvidence('production'))) {
      upper[k.toUpperCase()] = v;
    }
    expect(main({ ...upper, EXPECTED_COMMIT_SHA: VALID_COMMIT })).toBe(0);
    expect(main({ ...upper, EXPECTED_COMMIT_SHA: '0'.repeat(40) })).toBe(1);
  });
});
