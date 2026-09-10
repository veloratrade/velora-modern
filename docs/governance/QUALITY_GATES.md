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
| **QG-04** | Automated Test Suite | `npm run test` | Executes Vitest test suite (70 tests across 14 test files). | YES | `SHARED_REQUIRED` |
| **QG-05** | Translation Key Parity | `npm run i18n:check` | Enforces 100% key-level parity between `en.json` and `fa.json` catalogs. | YES | `SHARED_REQUIRED` |
| **QG-06** | Latin/ASCII Digit Invariant | `npm run i18n:check` | Rejects Eastern Arabic digits (`۰-۹`) in locale catalog strings; enforces `0-9`. | YES | `SHARED_REQUIRED` |
| **QG-07** | Brand Terms Policy | `npm run i18n:check` | Rejects translation or alteration of `"VELORA"` and `"MetaAPI"` brand tokens. | YES | `SHARED_REQUIRED` |
| **QG-08** | Financial Math Parity | `npm run test` (`financialParity.test.ts`) | Verifies `PnlCalculator` scale 8 Decimal.js math against PHP golden vectors. | YES | `SHARED_REQUIRED` |
| **QG-09** | Schema Parity & DMMF | `npm run test` (`schemaParity.test.ts`) | Verifies Prisma schema mappings for 38 tables, unique indexes, & Decimal types. | YES | `SHARED_REQUIRED` |
| **QG-10** | Fail-Closed Security | `npm run test` (`remediation.test.ts`) | Verifies DB failure throws HTTP 503 without MemoryStore fallback in prod/dev. | YES | `SHARED_REQUIRED` |
| **QG-11** | API Response Envelope | `npm run test` (`errors.test.ts`) | Verifies `{ status, data, error, timestamp }` JSON structure matching PHP contract. | YES | `SHARED_REQUIRED` |
| **QG-12** | Fastify Request Validation | Fastify + Zod | Rejects invalid request payloads with HTTP 400/422 validation errors. | YES | `MODERN_SPECIFIC` |

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

# 5. Execute full Vitest test suite
npx vitest run --no-file-parallelism
```

All 5 commands MUST pass with 0 errors before code is committed or pushed to `main`.

---

## Provenance & Traceability Matrix

| Quality Gate | PHP Reference Evidence | Classification | Modern Target Location | Status |
| :--- | :--- | :--- | :--- | :--- |
| **QG-01 to QG-07** | `docs/QUALITY_GATE_MATRIX.md` | `SHARED_REQUIRED` | `docs/governance/QUALITY_GATES.md` | `TRANSFER_COMPLETED` |
| **QG-08 (Financial Math)** | `PnlCalculatorTest.php` | `SHARED_REQUIRED` | `tests/unit/financialParity.test.ts` | `VERIFIED` |
| **QG-09 (Schema Parity)** | `v0.1_init.sql` through `v0.9` | `SHARED_REQUIRED` | `tests/unit/schemaParity.test.ts` | `VERIFIED` |
| **QG-10 (Fail-Closed DB)** | `DatabaseException.php` | `SECURITY_REQUIREMENT` | `tests/unit/remediation.test.ts` | `VERIFIED` |
