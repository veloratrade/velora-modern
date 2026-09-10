# Velora Cross-Platform Capability Parity Matrix

## Overview
This matrix tracks the migration status of core platform capabilities between the PHP reference implementation (`veloratrade/veloratrade`) and the Modern target architecture (`veloratrade/velora-modern`).

## Status Definitions
- `NOT_STARTED`: Capability not yet evaluated or implemented.
- `DISCOVERED`: Requirements extracted from PHP codebase; design pending.
- `IMPLEMENTED`: Modern native code implemented; parity validation pending.
- `PARITY_PENDING`: Implementation complete; automated parity tests under construction.
- `PARITY_VERIFIED`: Implementation verified against PHP reference behavior with green test evidence.
- `BLOCKED`: Implementation or verification blocked by missing dependency or security blocker.
- `NOT_APPLICABLE`: PHP capability specific to legacy architecture, omitted by design.
- `UNKNOWN`: Insufficient evidence to evaluate status.

---

## Capability Matrix

| CAPABILITY | PHP STATUS | MODERN STATUS | BUSINESS RULE PARITY | API PARITY | DATA PARITY | SECURITY PARITY | TEST PARITY | GATE STATUS | EVIDENCE | BLOCKERS |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Authentication & Identity** | `IMPLEMENTED` | `IMPLEMENTED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `tests/integration/auth.test.ts`, `tests/unit/remediation.test.ts` | None |
| **Password Security & Hashing** | `IMPLEMENTED` | `IMPLEMENTED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `tests/unit/password.test.ts` | None |
| **RBAC & Authorization** | `IMPLEMENTED` | `IMPLEMENTED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `src/modules/auth/roles.ts`, `tests/unit/schemaParity.test.ts` | None |
| **API Error Handling** | `IMPLEMENTED` | `IMPLEMENTED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `tests/integration/errors.test.ts`, `src/core/errors/errorHandler.ts` | None |
| **Localization & i18n Gate** | `IMPLEMENTED` | `IMPLEMENTED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `scripts/validate-i18n.ts`, `tests/unit/i18nParity.test.ts` | None |
| **Financial & PnL Math** | `IMPLEMENTED` | `IMPLEMENTED` | `PARITY_VERIFIED` | `PARITY_PENDING` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `src/modules/trades/pnlCalculator.ts`, `tests/unit/financialParity.test.ts` | None |
| **Database Schema & Migrations** | `IMPLEMENTED` | `IMPLEMENTED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `PARITY_VERIFIED` | `prisma/schema.prisma`, `tests/unit/schemaParity.test.ts` | None |
| **Trading & Deal Assembly** | `IMPLEMENTED` | `DISCOVERED` | `PARITY_PENDING` | `NOT_STARTED` | `DISCOVERED` | `DISCOVERED` | `NOT_STARTED` | `PARITY_PENDING` | `api/src/Trades/MetaApiDealAssembler.php` | Deferred to Phase 6 |
| **MetaAPI Webhook Ingestion** | `IMPLEMENTED` | `DISCOVERED` | `PARITY_PENDING` | `NOT_STARTED` | `DISCOVERED` | `DISCOVERED` | `NOT_STARTED` | `PARITY_PENDING` | `api/src/Webhooks/MetaApiWebhookController.php` | Deferred to Phase 6 |
| **AI Provider Routing & OCR** | `IMPLEMENTED` | `DISCOVERED` | `PARITY_PENDING` | `NOT_STARTED` | `DISCOVERED` | `DISCOVERED` | `NOT_STARTED` | `PARITY_PENDING` | `api/src/AI/Services/FeatureRouter.php` | Deferred to Phase 7 |
