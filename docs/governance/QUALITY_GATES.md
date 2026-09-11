# Velora Modern — Quality & Parity Gate Specification

## Purpose

This document defines the automated and manual quality gates, static verification scripts, and parity controls governing **Velora Modern** (`veloratrade/velora-modern`). It adapts the legacy PHP Quality Gate Matrix (`docs/QUALITY_GATE_MATRIX.md`) to Modern Node.js/TypeScript architecture.

---

## Active Quality Gate Matrix

| Gate ID | Control / Gate Name | Command / Script | Enforced Invariant / Guarantee | CI Status | Classification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **QG-01** | Code Formatting | `npm run format:check` | Enforces Prettier code style rules across `src/`, `tests/`, `scripts/`. | YES | `SHARED_REQUIRED` |
| **QG-02** | ESLint Code Quality | `npm run lint` | Enforces TypeScript ESLint static analysis and no-unused-vars rules. | YES | `SHARED_REQUIRED` |
| **QG-03** | TypeScript Compiler | `npm run typecheck` | Enforces zero compiler errors (`tsc --noEmit`) and strict null checks. | YES | `SHARED_REQUIRED` |
| **QG-04** | Automated Test Suite | `npm run test` | Executes Vitest test suite (141 tests across 21 test files). | YES | `SHARED_REQUIRED` |
| **QG-05** | Translation Key Parity | `npm run i18n:check` | Enforces 100% key-level parity between `en.json` and `fa.json` catalogs. | YES | `SHARED_REQUIRED` |
| **QG-06** | Latin/ASCII Digit Invariant | `npm run i18n:check` | Rejects Eastern Arabic digits (`۰-۹`) in locale catalog strings; enforces `0-9`. | YES | `SHARED_REQUIRED` |
| **QG-07** | Brand Terms Policy | `npm run i18n:check` | Rejects translation or alteration of `"VELORA"` and `"MetaAPI"` brand tokens. | YES | `SHARED_REQUIRED` |
| **QG-08** | Financial Math Parity | `npm run test` (`financialParity.test.ts`) | Verifies `PnlCalculator` scale 8 Decimal.js math against PHP golden vectors. | YES | `SHARED_REQUIRED` |
| **QG-09** | Schema Parity & DMMF | `npm run test` (`schemaParity.test.ts`) | Verifies Prisma schema mappings for 38 tables, unique indexes, & Decimal types. | YES | `SHARED_REQUIRED` |
| **QG-10** | Fail-Closed Security | `npm run test` (`remediation.test.ts`) | Verifies DB failure throws HTTP 503 without MemoryStore fallback in prod/dev. | YES | `SHARED_REQUIRED` |
| **QG-11** | API Response Envelope | `npm run test` (`errors.test.ts`) | Verifies `{ status, data, error, timestamp }` JSON structure matching PHP contract. | YES | `SHARED_REQUIRED` |
| **QG-12** | Fastify Request Validation | Fastify + Zod | Rejects invalid request payloads with HTTP 400/422 validation errors. | YES | `MODERN_SPECIFIC` |
| **QG-13** | Structure Guard | `npm run structure:check` | Fails closed on unindexed top/second-level boundaries (`STRUCTURE_BASELINE.md`). | YES | `SHARED_REQUIRED` |
| **QG-14** | GitHub Cost Policy | `npm run github:cost:check` | Standard runners, timeouts ≤30m, no schedules/dispatch-runs, no writes, retention ≤14d. | YES | `SHARED_REQUIRED` |
| **QG-15** | Secret Scan | `npm run secret:scan` + `secret-scan.yml` | No committed secrets/forbidden files/real user data in SQL; findings print path+rule only. | YES | `SHARED_REQUIRED` |
| **QG-16** | Staging Origin Contract | `deploy-staging.yml` preflight (`validate-frontend-url.ts` vs `STAGING_FRONTEND_URL`) | Staging deploys only with the pinned staging origin; unset/mismatched value fails closed. | RELEASE | `SHARED_REQUIRED` |
| **QG-17** | Backup Evidence Gate | `backup-evidence-gate.yml` (`validate-backup-evidence.ts`) | Evidence contract or empty-target attestation (XOR); deploys stop without either. | RELEASE | `SHARED_REQUIRED` |

### Pending gates and test debt (tracked, not dropped — D6/D7 correction)

Two distinct states — do not confuse them:

- **Current test debt:** the Modern subject is LIVE but regression pins are
  unported. The behavior exists and is reachable; only the pins are missing.
- **Phase-bound:** the Modern subject does not exist yet; pins port with it.

| Gate | State | PHP source | Unblocks with |
|---|---|---|---|
| Auth-flow pins (TEST-01..05/10/12/13/16/17/22/23) | CURRENT TEST DEBT — auth routes live (register/verify/login/refresh/logout/forgot/reset/change-password), pins unported | `quality-gate.yml` gate-auth | Auth hardening: port pins against the live routes |
| Security regression pins (TEST-11/13/21/24/25 classes) | CURRENT TEST DEBT — limiter enforced + headers emitted, behaviors unpinned (rate-limit + headers contracts covered 2026-09-12; remainder open) | `quality-gate.yml` gate-security | Security phase: port the remaining pins |
| Email-contract pins | PHASE-BOUND — no Modern mail provider binding | `quality-gate.yml` + email suites | Mail phase |
| Browser/E2E contracts | PHASE-BOUND — no Modern UI | `dashboard_e2e.js`, `tools/e2e`, journey workflows | UI phase |
| AI regression | PHASE-BOUND — no Modern AI surface | `quality-gate.yml` ai job | AI phase |
| n8n archive-read gate + tooling | DEFERRED — `tools/n8n_migrate/` + `tools/n8n_archive/` recorded, not migrated (safety properties: secret guards, HMAC/read guards, archive safety, live-client boundaries, credential non-migration) | `quality-gate.yml` archive job + n8n docs | Automation owner decision |
| Artifact freshness (TEST-26 class) + NP-5 | NOT APPLICABLE — Modern commits no generated artifacts (build output gitignored, rebuilt fresh); no staleness subject exists | `test_artifact_freshness.py`, ARTIFACT_INTEGRITY §6 | — (revisit only if committed artifacts appear) |

---

## Quality Gate Execution Protocol

Pre-commit verification protocol for all contributors:

```bash
# 1. Check code formatting
npm run format:check

# 2. Run linter
npm run lint

# 3. Check TypeScript compilation
npm run typecheck

# 4. Run translation catalog validator
npm run i18n:check

# 5. Run structural + cost + secret guards
npm run structure:check
npm run github:cost:check
npm run secret:scan

# 6. Execute full Vitest test suite
npx vitest run --no-file-parallelism
```

All 6 command groups MUST pass with 0 errors before code is committed or pushed to `main`.

---

## Provenance & Traceability Matrix

| Quality Gate | PHP Reference Evidence | Classification | Modern Target Location | Status |
| :--- | :--- | :--- | :--- | :--- |
| **QG-01 to QG-07** | `docs/QUALITY_GATE_MATRIX.md` | `SHARED_REQUIRED` | `docs/governance/QUALITY_GATES.md` | `TRANSFER_COMPLETED` |
| **QG-08 (Financial Math)** | `PnlCalculatorTest.php` | `SHARED_REQUIRED` | `tests/unit/financialParity.test.ts` | `VERIFIED` |
| **QG-09 (Schema Parity)** | `v0.1_init.sql` through `v0.9` | `SHARED_REQUIRED` | `tests/unit/schemaParity.test.ts` | `VERIFIED` |
| **QG-10 (Fail-Closed DB)** | `DatabaseException.php` | `SECURITY_REQUIREMENT` | `tests/unit/remediation.test.ts` | `VERIFIED` |
