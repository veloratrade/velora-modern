/**
 * VELORA BACKUP EVIDENCE GATE — machine-enforced backup-evidence validator.
 *
 * Semantic port of the PHP permanent repository law (2026-09-09):
 *
 *     NO DEPLOY OR DATABASE MIGRATION MAY PROCEED WITHOUT A SUCCESSFULLY
 *     CREATED AND VERIFIED BACKUP.
 *
 * PHP source: `ops/velora-mgmt/backup_gate.py` (`evaluate_backup_gate`).
 * Adaptation notes (mechanism replaced, law preserved):
 * - Evidence contract is UNCHANGED (same 6 fields, same formats, same
 *   fail-closed evaluation). Only the transport changed (Python -> TypeScript).
 * - The gate validates EVIDENCE, never creates backups. Backup execution for
 *   Railway Postgres is a deferred final-phase responsibility; until then,
 *   deploy workflows obtain evidence from the (future) backup producer or use
 *   the documented empty-target bootstrap attestation (see
 *   `docs/ops/BACKUP_POLICY.md`). The bootstrap decision lives in the
 *   workflow, never in this validator: this module has no bypass path.
 * - Pure logic + thin CLI. No network I/O. Never prints secret values (it only
 *   sees evidence identifiers, which are non-secret by design).
 *
 * CLI contract (mirrors the PHP CLI):
 *   EXPECTED_ENV=staging|production
 *   BACKUP_ID / RELEASE_TAG / SHA256 / SOURCE_COMMIT_SHA /
 *   VERIFICATION_STATUS / ENVIRONMENT
 *   EXPECTED_COMMIT_SHA (optional locally; CI always sets it to the
 *   deployment commit SHA — when set, binding is enforced, fail-closed)
 * Exit codes: 0 = PASS, 1 = FAIL (blocked), 2 = usage error.
 */

export const INTEGRITY_VERIFIED = 'INTEGRITY_VERIFIED';

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{7,64}$/;

export const EXPECTED_ENVS = new Set(['staging', 'production']);

export interface BackupEvidence {
  backup_id?: unknown;
  release_tag?: unknown;
  sha256?: unknown;
  source_commit_sha?: unknown;
  verification_status?: unknown;
  environment?: unknown;
  [key: string]: unknown;
}

export interface GateResult {
  allowed: boolean;
  reasons: string[];
}

/**
 * Store-free binding context. `expectedCommitSha` is the deployment commit
 * SHA the evidence MUST name. Omit it only for local/offline validation;
 * CI always supplies it (wired to `github.sha` — never empty in Actions).
 */
export interface BindingOptions {
  expectedCommitSha?: string;
}

/**
 * Fail-closed evaluation. `backup` maps evidence names (lowercase or the
 * CLI's uppercase names) to values; `expectEnv` is 'staging' | 'production'.
 * Any missing/invalid item blocks the gate.
 */
export function evaluateBackupGate(
  backup: BackupEvidence | null | undefined,
  expectEnv: string,
  opts: BindingOptions = {},
): GateResult {
  const reasons: string[] = [];

  if (!EXPECTED_ENVS.has(expectEnv)) {
    return { allowed: false, reasons: [`invalid expected environment: '${expectEnv}'`] };
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(backup ?? {})) {
    normalized[String(key).toLowerCase()] = value;
  }

  function evidence(key: string): string | null {
    const raw = normalized[key];
    if (typeof raw !== 'string' || raw.trim() === '') {
      reasons.push(`missing evidence: ${key}`);
      return null;
    }
    return raw.trim();
  }

  const backupId = evidence('backup_id');
  const releaseTag = evidence('release_tag');
  const sha256 = evidence('sha256');
  const sourceCommitSha = evidence('source_commit_sha');
  const status = evidence('verification_status');
  const environment = evidence('environment');

  if (backupId !== null && !backupId.startsWith(`db-backup-${expectEnv}-`)) {
    reasons.push(
      `backup_id not in the ${expectEnv} namespace ` +
        `(expected prefix 'db-backup-${expectEnv}-'): ${backupId}`,
    );
  }
  if (sha256 !== null && !SHA256_RE.test(sha256)) {
    reasons.push('sha256 is not a lowercase 64-hex digest');
  }
  if (sourceCommitSha !== null && !GIT_SHA_RE.test(sourceCommitSha)) {
    reasons.push('source_commit_sha is not a valid git SHA (7..64 hex)');
  }
  if (status !== null && status !== INTEGRITY_VERIFIED) {
    reasons.push(`verification_status must be exactly '${INTEGRITY_VERIFIED}', got '${status}'`);
  }
  if (environment !== null && environment !== expectEnv) {
    reasons.push(`environment mismatch: expected '${expectEnv}', got '${environment}'`);
  }

  // ── Store-free BINDING (D5): the evidence must name THIS deployment ──
  // No store access: pure claim-vs-context comparison. Skipped ONLY when the
  // caller supplies no deployment SHA (local/offline use); CI always sets it.
  const expectedCommit = (opts.expectedCommitSha ?? '').trim();
  if (expectedCommit !== '' && sourceCommitSha !== null && sourceCommitSha !== expectedCommit) {
    reasons.push(
      `source_commit_sha ${sourceCommitSha.slice(0, 12)} != deployment commit ` +
        `${expectedCommit.slice(0, 12)} (stale or unrelated backup)`,
    );
  }

  // ── Production identity binding (D5; PHP prod-gate parity, store-free) ──
  // Staging intentionally keeps the PHP staging behavior (no tag rules).
  if (expectEnv === 'production') {
    if (releaseTag !== null && !releaseTag.startsWith('db-backup-production-')) {
      reasons.push(
        `release_tag not in the production namespace ` +
          `(expected prefix 'db-backup-production-'): ${releaseTag}`,
      );
    }
    if (backupId !== null && releaseTag !== null && releaseTag !== backupId) {
      reasons.push(`release_tag ${releaseTag} does not match backup_id ${backupId}`);
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

const EVIDENCE_KEYS = [
  'BACKUP_ID',
  'RELEASE_TAG',
  'SHA256',
  'SOURCE_COMMIT_SHA',
  'VERIFICATION_STATUS',
  'ENVIRONMENT',
] as const;

export function main(env: NodeJS.ProcessEnv = process.env): number {
  const expectEnv = (env['EXPECTED_ENV'] ?? '').trim();
  if (expectEnv === '') {
    console.error('::error::BACKUP GATE: EXPECTED_ENV is not set (staging|production)');
    return 2;
  }
  const payload: BackupEvidence = {};
  for (const key of EVIDENCE_KEYS) {
    payload[key] = env[key] ?? '';
  }
  const { allowed, reasons } = evaluateBackupGate(payload, expectEnv, {
    expectedCommitSha: env['EXPECTED_COMMIT_SHA'] ?? '',
  });
  if (allowed) {
    console.log(
      'BACKUP GATE PASS: verified backup evidence complete ' +
        `(backup_id=${payload['BACKUP_ID']} env=${expectEnv})`,
    );
    return 0;
  }
  for (const reason of reasons) {
    console.error(`::error::BACKUP GATE: ${reason}`);
  }
  console.error('BACKUP GATE FAIL: no verified backup — deploy/migration must NOT proceed');
  return 1;
}

import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  process.exit(main());
}
