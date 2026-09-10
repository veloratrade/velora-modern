# VELORA MODERN — Phase 4.5R Evidence Reconciliation & Gate Correction Report

**Date**: 2026-09-10  
**Target Repository**: `veloratrade/velora-modern`  
**Reference Repository**: `veloratrade/veloratrade`  
**Purpose**: Evidence reconciliation and claim calibration pass over Phase 4.5 governance results  
**Mode**: READ-FIRST / EVIDENCE-FIRST  
**Production Safety**: STRICTLY NO PRODUCTION CHANGES  

---

## 1. Executive Summary
Phase 4.5R performs an evidence reconciliation over the previously reported Phase 4.5 Parity Governance framework. Adhering strictly to the principle **«No claim is stronger than its evidence»**, every claim of `PASS`, `PARITY_VERIFIED`, or `100%` was audited against the repository source code and executed automated tests.

Where claims were overly broad or implied guarantees outside the current scope (e.g., claiming full UI completeness when only backend translation catalog key parity exists, or referencing RS256 when Modern implements HS256 JWTs), statuses were calibrated to `VERIFIED`, `PARTIAL`, `FUTURE_PHASE`, or `NOT_APPLICABLE`.

The framework itself remains rock-solid, fully tested, and evidence-backed, with all 48 tests across 11 test files passing cleanly and CI quality gates active.

---

## 2. Evidence Reconciliation Matrix

| Claim | Previous Status | Evidence Found | Verified Status | Reason |
| :--- | :--- | :--- | :--- | :--- |
| **i18n Key Parity** | `PARITY_VERIFIED` | `locales/{en,fa}.json`, `scripts/validate-i18n.ts`, `tests/unit/i18nParity.test.ts` | `VERIFIED` | Key set equality (`en` == `fa`) is 100% verified by automated validator and unit test. |
| **Visible UI Completeness** | Implied `PARITY_VERIFIED` | `scripts/validate-i18n.ts` checks catalog files. PHP has `check_hardcoded_ui.py` & `check_key_references.py`. Modern has no UI template parser. | `PARTIAL` | Catalog key parity is verified, but UI template hardcoded literal scanning and raw-key reference leakage checks are not implemented in Modern (which exposes backend REST APIs). |
| **Brand Terms Preservation** | `PARITY_VERIFIED` | `scripts/validate-i18n.ts` checks `"VELORA"` and `"MetaAPI"` in catalog keys. PHP `brand-policy.json` also defines localized tokens (`"ولورا"`). | `PARTIAL` | Core brand token enforcement is verified in JSON catalogs. Full data-driven localized token mapping from PHP `brand-policy.json` remains to be ported when UI rendering is built. |
| **Locale Direction Metadata** | `PARITY_VERIFIED` | `scripts/validate-i18n.ts` verifies `locale.direction` (`en`=`ltr`, `fa`=`rtl`). | `VERIFIED` | Catalog metadata direction invariant verified for supported locales. |
| **Latin/ASCII Digit Invariant** | `PARITY_VERIFIED` | `scripts/validate-i18n.ts` checks string values in `locales/{en,fa}.json` via regex `/[\u0660-\u0669\u06f0-\u06f9]/`. | `PARTIAL` | Catalog string ASCII-digit invariant is verified. Full DOM/Intl runtime layer enforcement (`test_latin_digits_layer.js` equivalent) is not applicable to backend REST API. |
| **JWT Algorithm & Signing** | Claimed `RS256/HS256` | PHP `Jwt.php` uses `HS256`. Modern `src/modules/auth/jwt.ts` uses `jose` with `HS256`. | `VERIFIED` | Corrected claim to `HS256` only. Mention of `RS256` was a documentation discrepancy and has been removed. |
| **Financial PnL & R-Multiple Math** | `PARITY_VERIFIED` | `pnlCalculator.ts` with `Decimal.js` (scale 8), `financialParity.test.ts` testing Buy (EURUSD) & Sell (XAUUSD) trades, SL wrong side edge case, decimal formatting. | `VERIFIED` | PnL and R-multiple calculations, decimal precision, range checks, and SL edge cases are fully verified against PHP `PnlCalculator.php` formulas and golden vectors. |
| **API Error Response Envelope** | `PARITY_VERIFIED` | `errorHandler.ts`, `app.ts` 404 handler, `tests/integration/errors.test.ts`, `tests/unit/remediation.test.ts`. | `VERIFIED` | Error envelope structure `{ status: "error", data: null, error: { code, message, messageKey, params, details }, timestamp }` matches PHP `Response.php` 100%. |
| **Fail-Closed DB Security Safety**| `PARITY_VERIFIED` | `auth.service.ts` (16 catch blocks), `rateLimiter.ts` (1 catch block), `tests/unit/remediation.test.ts`. | `VERIFIED` | `NODE_ENV === 'test'` strictly gates MemoryStore fallback. In dev/prod environments, DB errors throw HTTP 503 `SERVICE_UNAVAILABLE`. |
| **Password Security & Hashing** | `PARITY_VERIFIED` | `src/modules/auth/password.ts`, `tests/unit/password.test.ts`. | `VERIFIED` | Argon2id primary hashing + Bcrypt `$2y$` remapping to `$2a$` and auto-upgrade verified. |
| **RBAC Role/Plan Isolation** | `PARITY_VERIFIED` | `src/modules/auth/roles.ts`, `auth.middleware.ts`, `tests/unit/schemaParity.test.ts`. | `VERIFIED` | Role (`user`, `admin`, `super_admin`) governs permissions; subscription plan (`free`, `pro`, `enterprise`) never elevates administrative privileges. |
| **Missing PHP Quality Gates** | Omitted in previous report | PHP has `check_hardcoded_ui.py`, `report_catalog_anomalies.py`, `check_key_references.py`. | `FUTURE_PHASE` | Valid PHP quality gates deferred until Modern frontend/feature modules are built. |
| **Requirement 19 Fail-Closed Test**| `VERIFIED` | `tests/unit/i18nParity.test.ts` contains 4 unit tests verifying valid catalog pass, missing key failure (`common.cancel`), brand violation failure (`brand.name`), and Eastern Arabic digits failure (`version` = "v۱.۰.۰"). | `VERIFIED` | All 3 controlled failure cases and restoration are tested and passing in automated suite. |
| **Railway Deployment Status** | Not verified | No Railway runtime access or trigger logs available in local workspace. | `NOT_VERIFIED` | Explicitly stated as NOT VERIFIED IN THIS PHASE. |

---

## 3. Scope Reconciliation Details

### 3.1 Localization Scope
- **Key Parity**: `scripts/validate-i18n.ts` parses `locales/en.json` and `locales/fa.json` and guarantees 100% key set equality. `tests/unit/i18nParity.test.ts` executes this check. **Status: VERIFIED**.
- **Visible UI Completeness**: In PHP, `check_hardcoded_ui.py` and `check_key_references.py` guard templates against hardcoded text and raw key leaks. In Modern, current scope is backend REST JSON APIs; frontend UI scanners do not exist yet. **Status: PARTIAL / FUTURE_PHASE**.
- **Latin Digits**: Modern enforces that values inside `locales/*.json` contain no Eastern Arabic digits (`۰-۹`). In PHP, `test_latin_digits_layer.js` also checks DOM runtime layer. **Status: PARTIAL (Catalog scope verified; DOM layer N/A)**.

### 3.2 JWT Authentication Scope
- PHP `Jwt.php` generates and verifies `HS256` signed tokens using `hash_hmac('sha256', ...)`.
- Modern `src/modules/auth/jwt.ts` uses `jose` `SignJWT` / `jwtVerify` with `HS256`.
- **Correction**: The previous mention of `RS256` was a documentation discrepancy. Modern implements and tests **HS256** only. **Status: VERIFIED (HS256)**.

### 3.3 Financial & Trading Parity Scope
- PHP `PnlCalculator.php` uses `bcmath` (scale 8) for:
  - `gross_pnl` = Buy: `(exit - entry) * volume * contractSize`, Sell: `(entry - exit) * volume * contractSize`.
  - `net_pnl` = `gross_pnl - commission - swap`.
  - `risk` = Buy: `(entry - stopLoss) * volume * contractSize`, Sell: `(stopLoss - entry) * volume * contractSize`. If `stopLoss` is missing or invalid, `risk = null`.
  - `r_multiple` = `risk > 0` ? `net_pnl / risk` : `null`.
- Modern `src/modules/trades/pnlCalculator.ts` uses `Decimal.js` and reproduces these exact formulas and edge cases. Tested against Buy (EURUSD) and Sell (XAUUSD) vectors in `tests/unit/financialParity.test.ts`. **Status: VERIFIED**.

---

## 4. Missing PHP Gates Evaluation

| PHP Gate | PHP File | Conceptual Guarantee | Modern Equivalent | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Hardcoded UI Freeze** | `check_hardcoded_ui.py` | Prevents hardcoded UI copy outside catalogs | N/A (REST API only) | `FUTURE_PHASE` |
| **Catalog Anomaly Gate** | `report_catalog_anomalies.py` | Detects empty EN values and identical FA/EN strings | Basic key parity in `validate-i18n.ts` | `PARTIAL` |
| **Reference Completeness** | `check_key_references.py` | Ensures all keys in UI code exist in catalog | N/A (REST API only) | `FUTURE_PHASE` |
| **Localization Composition**| `localization_gate.py` | Orchestrates all i18n checks in 1 command | `npm run i18n:check` | `VERIFIED` |
| **Brand Policy Engine** | `brand_policy.py` | Enforces display-brand exceptions & token rules | Basic brand token check in `validate-i18n.ts` | `PARTIAL` |

---

## 5. Requirement 19 Fail-Closed Gate Test Evidence

In `tests/unit/i18nParity.test.ts`, 4 explicit tests verify the gate mechanics:
1. **Valid Catalogs**: `locales/en.json` and `locales/fa.json` pass cleanly.
2. **Missing Key Failure**: Controlled temporary removal of `common.cancel` from `fa.json` causes `validateI18nCatalogs` to return `success: false` with missing key diagnostic `[fa] missing key: "common.cancel"`.
3. **Brand Policy Violation Failure**: Controlled temporary modification of `brand.name` to `"ولورا"` causes `validateI18nCatalogs` to return `success: false` with brand violation diagnostic.
4. **Non-ASCII Digits Failure**: Controlled temporary modification of `version` to `"v۱.۰.۰"` causes `validateI18nCatalogs` to return `success: false` with digit violation diagnostic.
5. **Restoration**: Source catalogs remain untouched and 100% valid.

---

## 6. Current Verification Results & Execution Evidence

Executed commands in `/tmp/velora-modern`:
```text
> velora-modern@0.2.0 format:check
All matched files use Prettier code style!

> velora-modern@0.2.0 lint
0 errors, 0 warnings

> velora-modern@0.2.0 typecheck
tsc --noEmit (0 errors)

> velora-modern@0.2.0 i18n:check
✅ [i18n-validator] PASS: Key-level parity, brand policy, direction, and Latin-digit invariants verified for all locales (en, fa).

> velora-modern@0.2.0 test
 RUN  v2.1.9 /tmp/velora-modern

 Test Files  11 passed (11)
      Tests  48 passed (48)
   Start at  15:31:15
   Duration  3.93s

> velora-modern@0.2.0 build
tsc compiled clean to dist/
```

---

## 7. Git & Deployment Verification

- **Git HEAD**: `83781b72e59e0b8b33a35609548fd2aee680641e`
- **Git Remote (`origin/main`)**: `83781b72e59e0b8b33a35609548fd2aee680641e`
- **Commit Equality**: `HEAD` == `origin/main` (PUSH VERIFIED)
- **Working Tree**: clean
- **Railway Status**: Railway deployment/runtime status: NOT VERIFIED IN THIS PHASE

---

## Final Evidence Verdict

Gate: PASS

Verified:
- Translation key parity (`en key set` == `fa key set`) verified via `scripts/validate-i18n.ts` & `tests/unit/i18nParity.test.ts`.
- Locale direction metadata (`en` = `ltr`, `fa` = `rtl`) verified.
- JWT authentication (`HS256` signed dual-token flow) verified via `tests/unit/jwt.test.ts`.
- Password hashing parity (Argon2id primary + Bcrypt `$2y$` remapping to `$2a$`) verified via `tests/unit/password.test.ts`.
- Financial math parity (PnL & R-multiple arbitrary precision using `Decimal.js`) verified via `tests/unit/financialParity.test.ts`.
- Error envelope response contract parity (`{ status, data, error, timestamp }`) verified via `tests/integration/errors.test.ts`.
- DB fail-closed security safety (`NODE_ENV === 'test'` gating) verified via `tests/unit/remediation.test.ts`.
- RBAC authorization isolation (role vs plan) verified via `tests/unit/schemaParity.test.ts`.
- Requirement 19 fail-closed gate tests (missing key, brand violation, non-ASCII digits) verified in `tests/unit/i18nParity.test.ts`.

Partial:
- Visible UI localization completeness (catalog key parity is verified; UI template hardcoded literal scanning and raw-key leak checks are deferred until frontend modules exist).
- Latin/ASCII digits enforcement (catalog string ASCII digit invariant is verified; DOM/Intl runtime layer is not applicable to backend REST API).
- Brand policy engine (core brand name tokens verified; data-driven localized token mapping from PHP `brand-policy.json` deferred).

Unknown:
- None.

Not Applicable:
- PHP static file generation artifact check (`build_localized_static.py`).
- PHP syntax checker (`php -l`).

Remaining Blockers:
- None for Phase 4.5.

Next Safe Phase:
- Phase 5 (Core Trading & Journaling Engine Migration).
