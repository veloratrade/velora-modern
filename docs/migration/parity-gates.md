# Velora Modern — Quality & Parity Gates

## Overview
This document defines all cross-platform quality and behavioral parity gates between the reference PHP codebase (`veloratrade/veloratrade`) and the Modern Node.js/TypeScript architecture (`veloratrade/velora-modern`).

Each gate enforces a specific product invariant or quality guarantee.

## Classification Taxonomy
- `SHARED_REQUIRED`: The underlying rule is part of Velora's product contract and MUST exist in Modern.
- `SHARED_ADAPTED`: The underlying rule applies to Modern, but its implementation differs due to Node.js/TypeScript architecture.
- `PHP_SPECIFIC`: The mechanism exists only because of PHP/cPanel/generated-PHP architecture and is NOT reproduced in Modern.
- `MODERN_SPECIFIC`: Modern requires a stronger/different mechanism that does not exist in PHP.
- `UNKNOWN`: Insufficient evidence to classify.

---

## Parity Gates Table

| Gate / Control | PHP Evidence | Conceptual Guarantee | Classification | Modern Implementation | Test | CI Enforced | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Translation Key Parity** | `tools/localization/validate_localization.py`, `api/locales/{en,fa}/ui.php` | Locale completeness between `en` & `fa` catalogs | `SHARED_REQUIRED` | `scripts/validate-i18n.ts` & `locales/{en,fa}.json` | `tests/unit/i18nParity.test.ts` | Yes (`npm run i18n:check`) | `PARITY_VERIFIED` |
| **Latin/ASCII Digit Invariant** | `tools/tests/test_latin_digits_layer.js`, `LOCALIZATION_IMPLEMENTATION_REPORT.md` | Numeric display must strictly use ASCII digits (0-9) | `SHARED_REQUIRED` | Regex invariant check in `scripts/validate-i18n.ts` & string formatting | `tests/unit/i18nParity.test.ts` | Yes | `PARITY_VERIFIED` |
| **Brand Terms Preservation** | `tools/localization/brand_policy.py`, `brand-policy.json` | "VELORA" and "MetaAPI" brand tokens preserved across all locales | `SHARED_REQUIRED` | Brand token enforcement in `scripts/validate-i18n.ts` | `tests/unit/i18nParity.test.ts` | Yes | `PARITY_VERIFIED` |
| **Locale Direction Invariant** | `test_locale_resolution.js`, `ui.php` | EN must be LTR, FA must be RTL | `SHARED_REQUIRED` | Metadata validation in `scripts/validate-i18n.ts` | `tests/unit/i18nParity.test.ts` | Yes | `PARITY_VERIFIED` |
| **API Error Envelope Parity** | `api/src/Core/Response.php` | Standard response `{ status, data, error: { code, message, messageKey, params, details }, timestamp }` | `SHARED_REQUIRED` | `src/core/errors/errorHandler.ts` | `tests/integration/errors.test.ts`, `remediation.test.ts` | Yes | `PARITY_VERIFIED` |
| **DB Fail-Closed Safety** | `api/src/Core/Database.php` | DB failure in dev/prod throws HTTP 503 SERVICE_UNAVAILABLE without MemoryStore fallback | `SHARED_REQUIRED` | `NODE_ENV === 'test'` gating in `auth.service.ts` & `rateLimiter.ts` | `tests/unit/remediation.test.ts` | Yes | `PARITY_VERIFIED` |
| **Financial Decimal Precision** | `api/src/Trades/PnlCalculator.php` (bcmath scale 8) | PnL & R-Multiple calculations with 8-decimal precision & range checks | `SHARED_REQUIRED` | `src/modules/trades/pnlCalculator.ts` using Decimal.js | `tests/unit/financialParity.test.ts` | Yes | `PARITY_VERIFIED` |
| **Password Hashing Parity** | `api/src/Auth/PasswordService.php` | Argon2id primary + Bcrypt `$2y$` legacy hash remapping to `$2a$` | `SHARED_REQUIRED` | `src/modules/auth/password.ts` | `tests/unit/password.test.ts` | Yes | `PARITY_VERIFIED` |
| **RBAC Authorization Isolation** | `api/src/Auth/Role.php` | Authorization based strictly on role (`user`,`admin`,`super_admin`), never subscription plan | `SHARED_REQUIRED` | `src/modules/auth/roles.ts` & `auth.middleware.ts` | `tests/unit/schemaParity.test.ts` | Yes | `PARITY_VERIFIED` |
| **JWT Bearer Authentication** | `api/src/Core/Jwt.php` | RS256/HS256 signed JWTs with expiration & revocation tracking | `SHARED_REQUIRED` | `src/modules/auth/jwt.ts` using `jose` | `tests/unit/jwt.test.ts` | Yes | `PARITY_VERIFIED` |
| **PHP Syntax & Build Checks** | `quality-gate.yml` (`php -l`) | Verify PHP syntax cleanliness | `PHP_SPECIFIC` | N/A (Modern uses TypeScript compiler `tsc`) | N/A | N/A | `NOT_APPLICABLE` |
| **PHP Generated Artifact Check** | `build_localized_static.py` | Freshness of statically generated PHP/HTML output | `PHP_SPECIFIC` | N/A (Modern serves dynamic REST JSON APIs) | N/A | N/A | `NOT_APPLICABLE` |
| **Fastify Schema & Type Safety** | N/A | Request/response Zod schema validation & Fastify plugin isolation | `MODERN_SPECIFIC` | Fastify plugins + Zod schemas | `tests/integration/auth.test.ts` | Yes | `PARITY_VERIFIED` |
