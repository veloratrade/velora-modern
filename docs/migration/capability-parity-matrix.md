# Velora Cross-Platform Capability Parity Matrix (Reconciled)

## Overview
This matrix tracks the migration status of core platform capabilities between the PHP reference implementation (`veloratrade/veloratrade`) and the Modern target architecture (`veloratrade/velora-modern`).

## Status Definitions
- `NOT_STARTED`: Capability not yet evaluated or implemented.
- `DISCOVERED`: Requirements extracted from PHP codebase; design pending.
- `IMPLEMENTED`: Modern native code implemented; parity validation pending.
- `PARITY_PENDING`: Implementation complete; automated parity tests under construction.
- `VERIFIED`: Implementation verified against PHP reference behavior with green test evidence.
- `PARTIAL`: Implementation or verification scoped to backend/catalog subset.
- `BLOCKED`: Implementation or verification blocked by missing dependency or security blocker.
- `NOT_APPLICABLE`: PHP capability specific to legacy architecture, omitted by design.
- `UNKNOWN`: Insufficient evidence to evaluate status.

---

## Capability Matrix

| CAPABILITY | PHP STATUS | MODERN STATUS | BUSINESS RULE PARITY | API PARITY | DATA PARITY | SECURITY PARITY | TEST PARITY | GATE STATUS | EVIDENCE | BLOCKERS |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Authentication & Identity** | `IMPLEMENTED` | `IMPLEMENTED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `tests/integration/auth.test.ts`, `tests/unit/remediation.test.ts` | None |
| **Password Security & Hashing** | `IMPLEMENTED` | `IMPLEMENTED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `tests/unit/password.test.ts` | None |
| **RBAC & Authorization** | `IMPLEMENTED` | `IMPLEMENTED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `src/modules/auth/roles.ts`, `tests/unit/schemaParity.test.ts` | None |
| **API Error Handling** | `IMPLEMENTED` | `IMPLEMENTED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `tests/integration/errors.test.ts`, `src/core/errors/errorHandler.ts` | None |
| **Localization Key Parity Gate** | `IMPLEMENTED` | `IMPLEMENTED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `scripts/validate-i18n.ts`, `tests/unit/i18nParity.test.ts` | None |
| **Visible UI Localization Gate**| `IMPLEMENTED` | `NOT_STARTED` | `PARTIAL` | `NOT_APPLICABLE` | `NOT_APPLICABLE` | `N/A` | `NOT_STARTED` | `FUTURE_PHASE`| PHP `check_hardcoded_ui.py`, `check_key_references.py` | Deferred until Modern Frontend |
| **Financial & PnL Math** | `IMPLEMENTED` | `IMPLEMENTED` | `VERIFIED` | `PARITY_PENDING` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `src/modules/trades/pnlCalculator.ts`, `tests/unit/financialParity.test.ts` | None |
| **Database Schema & Migrations** | `IMPLEMENTED` | `IMPLEMENTED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `VERIFIED` | `prisma/schema.prisma`, `tests/unit/schemaParity.test.ts` | None |
| **Trading & Deal Assembly** | `IMPLEMENTED` | `DISCOVERED` | `PARITY_PENDING` | `NOT_STARTED` | `DISCOVERED` | `DISCOVERED` | `NOT_STARTED` | `FUTURE_PHASE` | `api/src/Trades/MetaApiDealAssembler.php` | Deferred to Phase 6 |
| **MetaAPI Webhook Ingestion** | `IMPLEMENTED` | `DISCOVERED` | `PARITY_PENDING` | `NOT_STARTED` | `DISCOVERED` | `DISCOVERED` | `NOT_STARTED` | `FUTURE_PHASE` | `api/src/Webhooks/MetaApiWebhookController.php` | Deferred to Phase 6 |
| **AI Provider Routing & OCR** | `IMPLEMENTED` | `DISCOVERED` | `PARITY_PENDING` | `NOT_STARTED` | `DISCOVERED` | `DISCOVERED` | `NOT_STARTED` | `FUTURE_PHASE` | `api/src/AI/Services/FeatureRouter.php` | Deferred to Phase 7 |
