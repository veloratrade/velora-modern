# Velora Modern — Canonical Migration Roadmap

## Purpose

This document defines the canonical migration roadmap, phase status, source-of-truth governance model, and architecture pipeline for **Velora Modern** (`veloratrade/velora-modern`). It serves as the single authoritative roadmap reference for the platform migration from legacy PHP to modern Node.js/TypeScript.

---

## Source-of-Truth Governance Model

### PHP Reference Repository
- **Repository**: `veloratrade/veloratrade`
- **Role**: Current operational reference implementation and authoritative source of truth for existing product behavior, business logic, authorization rules, financial formulas, error response structures, and third-party integrations.

### Modern Target Repository
- **Repository**: `veloratrade/velora-modern`
- **Role**: Target architecture, modernized Node.js/TypeScript implementation, clean REST API foundation, and future product evolution platform.

### Core Migration Principle
> **«Migrate capabilities and business behavior, not PHP source code line-by-line.»**

Parity is defined strictly as **functional, security, and business capability equivalence**, not line-by-line translation or directory-level code duplication.

---

## Migration Phase Pipeline & Verification Status

```text
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 / 4F ──► Phase 4.5 ──► Phase 5 ──► Phase 6 ──► Phase 6.5 ──► Phase 7
Baseline    ADR/Prin.   Scaffolding Schema DB   Auth & Ident.   Parity Gov.    Trading Engine Accounts/Dash  Entitlements  Sync & AI
(COMPLETE)  (COMPLETE)  (COMPLETE)  (COMPLETE)  (COMPLETE)      (COMPLETE)     (COMPLETE)     (COMPLETE)     (PLANNED)     (FUTURE)
```

---

### Phase 0 — Baseline & Platform Setup
- **Status**: `COMPLETE`
- **Scope**: Railway infrastructure baseline definition, environment isolation, deployment triggers for `main` and `staging` branches.
- **Evidence**: `docs/infrastructure/railway-baseline.md`, `src/config/env.ts`

---

### Phase 1 — Architecture Decision & Governance Principles
- **Status**: `COMPLETE`
- **Scope**: Core architectural decisions establishing modular monolith structure, TypeScript standards, Fastify framework selection, and migration governance principles.
- **Evidence**: `docs/architecture/migration-principles.md`

---

### Phase 2 — Repository Scaffolding & Engineering Foundation
- **Status**: `COMPLETE`
- **Commit**: `891af3f1ecda67f9b798695d6411911f9226cee2`
- **Scope**: Fastify app builder (`src/app.ts`), Pino structured logging, Zod environment validation (`src/config/env.ts`), standard HTTP error envelope (`src/core/errors/errorHandler.ts`), `/health` status endpoint, Vitest testing setup, Prettier & ESLint configurations, and i18n key-parity script (`scripts/validate-i18n.ts`).
- **Evidence**: `docs/VELORA_MODERN_PHASE_2_SCAFFOLDING.md`

---

### Phase 3 — Database Schema & Migration Foundation
- **Status**: `COMPLETE`
- **Commit**: `2445ebd8537f2da5a0767ad35d6de635ac4e977a`
- **Scope**: Canonical Prisma schema (`prisma/schema.prisma`) faithfully mapping 38 active MySQL database tables from PHP baseline, initial SQL migration (`prisma/migrations/0_init/migration.sql`), schema parity test suite (`tests/unit/schemaParity.test.ts`), and test-mode in-memory store abstractions.
- **Evidence**: `docs/VELORA_MODERN_PHASE_3_DATABASE_PARITY.md`

---

### Phase 4 / 4F — Authentication, JWT & User Identity
- **Status**: `COMPLETE`
- **Commits**: `ad728691cd2643c1afe7ed525f86f24a747801dc`, `aed808b72b921ccf0493ab6b6c8cf797c3f9eb32` (Phase 4F Blocker Remediation)
- **Scope**: Argon2id password hashing with legacy Bcrypt `$2y$` -> `$2a$` remapping (`src/modules/auth/password.ts`), JOSE-backed HS256 JWT access and refresh tokens (`src/modules/auth/jwt.ts`), fail-closed production security rules (`NODE_ENV === 'test'` memory store isolation), Auth REST endpoints (`/api/v1/auth`), rate-limiting middleware, and comprehensive unit/integration test suites (`tests/integration/auth.test.ts`, `tests/unit/password.test.ts`, `tests/unit/remediation.test.ts`).
- **Evidence**: `docs/VELORA_MODERN_PHASE_4_AUTH_IDENTITY.md`, `docs/VELORA_MODERN_PHASE_4F_BLOCKER_REMEDIATION.md`

---

### Phase 4.5 / 4.5R — Cross-Platform Parity Governance
- **Status**: `COMPLETE`
- **Commits**: `ce0f677d141133aa4b170dbd5d9bb83fc734f003`, `8c1fc55aba54937e3923a7a971271431185531a2` (Phase 4.5R Evidence Reconciliation)
- **Scope**: Cross-platform Capability Parity Matrix (`docs/migration/capability-parity-matrix.md`), Reconciled Business Rules (`docs/migration/business-rules.md`), API Contracts (`docs/migration/api-contracts.md`), Parity Quality Gates (`docs/migration/parity-gates.md`), and automated i18n validator enforcing Latin digit `0-9` and brand preservation invariants (`tests/unit/i18nParity.test.ts`).
- **Evidence**: `docs/VELORA_MODERN_PHASE_4_5_PARITY_GOVERNANCE_REPORT.md`, `docs/VELORA_MODERN_PHASE_4_5R_RECONCILIATION.md`

---

### Phase 5 / 5R — Core Trading & Journaling Engine Migration
- **Status**: `COMPLETE`
- **Commits**: `e425e119d63757567ca55bd1965359e0e2be33a9`, `ad7fcd8389a9cfb22a81715e4bb46ce0c6dffe6e` (Phase 5 Blocker Resolution)
- **Scope**: `PnlCalculator` using `Decimal.js` scale 8 arbitrary-precision arithmetic for gross PnL, net PnL, risk, and R-multiple (`src/modules/trades/pnlCalculator.ts`), Trade CRUD repository & service (`src/modules/trades/`), REST endpoints (`/api/v1/trades`), partial trade exit management with atomic Prisma `$transaction` partial exits and cumulative volume guards, broker account ownership isolation (`user_id -> account_id -> trade_id`), and financial golden vector test suite (`tests/unit/financialParity.test.ts`, `tests/integration/trades.test.ts`).
- **Evidence**: `docs/VELORA_MODERN_PHASE_5_CORE_TRADING_JOURNAL_REPORT.md`, `docs/VELORA_MODERN_PHASE_5_BLOCKER_RESOLUTION_REPORT.md`, `docs/VELORA_MODERN_PHASE_5_INDEPENDENT_CORE_VERIFICATION.md`

---

### Phase 6 — Trading Accounts & Dashboard Performance Analytics
- **Status**: `COMPLETE`
- **Commit**: `fac3ef81191e3a54062c1edccc01ebc5796e05b7`
- **Scope**: Trading Accounts management module (`src/modules/accounts/`) providing full CRUD under `/api/v1/accounts`, auto-detection of server names, multi-broker sync status lifecycle (`PENDING_SYNC`, `CONNECTING`, `SYNCED`, `SYNC_FAILED`), and account ownership isolation. Dashboard Performance Analytics module (`src/modules/dashboard/`) providing `/api/v1/dashboard/summary` metrics (net PnL, win rate, profit factor, max drawdown, total trades), `/api/v1/dashboard/equity-curve` time-series data, and `/api/v1/dashboard/strategies` breakdown. Integration test suites (`tests/integration/accounts.test.ts`, `tests/integration/dashboard.test.ts`).
- **Evidence**: `docs/VELORA_MODERN_PHASE_6_CAPABILITY_MIGRATION_REPORT.md`

---

## Planned & Future Roadmap Phases

### Phase 6.5 — Plan / Subscription / Entitlement Foundation
- **Status**: `PLANNED`
- **Purpose**: Establish centralized plan/subscription/entitlement architecture before broader commercial feature gating is implemented.

#### Confirmed Business Rule
- **Free Plan**: Maximum **1 Trading Account** (`MT4`, `MT5`, or `MANUAL`).
- **Pro / Subscribed Plan**: **Unlimited Trading Accounts**.

#### Applicability Scope
- **Applies to**: Trading Accounts (`MT4`, `MT5`, `MANUAL`).
- **Explicitly NOT applicable**: Projects (unrestricted account grouping/project management).

#### Undecided Commercial Capabilities
No other commercial entitlement rules are currently approved. AI capabilities, OCR screenshot parsing, Strategy Lab, backtesting, automated reports, advanced analytics, and webhook automation rules remain **UNDECIDED** until explicitly evaluated and approved.

#### Architectural Direction
```text
┌──────────────┐
│  User Identity│
└──────┬───────┘
       │
       ▼
┌──────────────┐      ┌─────────────────────────┐
│ User.plan    ├─────►│ Entitlement Service     │
└──────────────┘      │ (Policy Enforcement)    │
                      └──────────┬──────────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │ Backend API & UI Gate │
                     └───────────────────────┘
```
- **Separation of Concerns**: User `Role` (`user`, `admin`, `super_admin`) and User `Plan` (`free`, `pro`, `enterprise`) MUST remain strictly separate. Subscription Plan must NEVER grant administrative privileges or alter role permissions.
- **Centralized Policy Enforcement**: All quota and entitlement checks must be handled through a dedicated Entitlement Service (`src/core/entitlements/entitlement.service.ts` or `src/modules/billing/entitlements.ts`), avoiding scattered inline `if (user.plan === 'free')` checks throughout business modules.

---

### Phase 7 — MetaAPI Sync Pipeline & AI Provider Routing
- **Status**: `FUTURE / PLANNED`
- **Scope**:
  - **MetaAPI Cloud Webhook Ingestion**: BullMQ background deal sync pipeline, webhook signature validation, deal assembly, and automated trade state synchronization (`api/src/Webhooks/MetaApiWebhookController.php`).
  - **AI Provider Routing & OCR Engine**: Multi-provider LLM routing (Gemini / OpenAI), trade chart OCR screenshot analysis, and automated trade journaling intelligence (`api/src/AI/Services/FeatureRouter.php`).

---

## Roadmap Governance & Evidence Rules

1. **Evidence-First Verification**: No phase claim may be marked `COMPLETE` or `VERIFIED` without backing source code, passed automated tests, and documented audit reports in `docs/`.
2. **Authoritative Hierarchy**:
   - `veloratrade/veloratrade` (PHP) is authoritative for **current operational reference behavior**.
   - `veloratrade/velora-modern` (Node.js/TS) is authoritative for **target modern architecture and future product roadmap**.
3. **Internal Governance Alignment**: `ROADMAP.md`, `migration-changelog.md`, `capability-parity-matrix.md`, `business-rules.md`, `api-contracts.md`, `parity-gates.md`, and `README.md` must remain internally consistent.

---

## Related Documentation

- [Migration Principles](../architecture/migration-principles.md)
- [Capability Parity Matrix](capability-parity-matrix.md)
- [Business Rules Specification](business-rules.md)
- [API Contracts Specification](api-contracts.md)
- [Quality & Parity Gates](parity-gates.md)
- [Migration Changelog](migration-changelog.md)
- [Phase 2 Engineering Scaffolding Report](../VELORA_MODERN_PHASE_2_SCAFFOLDING.md)
- [Phase 3 Database Schema Report](../VELORA_MODERN_PHASE_3_DATABASE_PARITY.md)
- [Phase 4 Auth & Identity Report](../VELORA_MODERN_PHASE_4_AUTH_IDENTITY.md)
- [Phase 4.5 Parity Governance Report](../VELORA_MODERN_PHASE_4_5_PARITY_GOVERNANCE_REPORT.md)
- [Phase 5 Core Trading Report](../VELORA_MODERN_PHASE_5_CORE_TRADING_JOURNAL_REPORT.md)
- [Phase 5 Blocker Resolution Report](../VELORA_MODERN_PHASE_5_BLOCKER_RESOLUTION_REPORT.md)
- [Phase 6 Trading Accounts & Dashboard Report](../VELORA_MODERN_PHASE_6_CAPABILITY_MIGRATION_REPORT.md)
