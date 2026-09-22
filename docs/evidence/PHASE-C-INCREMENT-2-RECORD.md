# Phase C Increment 2 Record — 2026-09-12 (identity completion, PnL golden vectors, accounts capability)

**Start HEAD:** `15d6adfa8ec83f6522ba881933e8e36b4b6570b5` (increment-1 terminal,
clean tree). **Commits (owner-ordered sequence):**

| # | Commit | Wave |
|---|---|---|
| 1 | `1f35f49` | identity completion (change-password, preferences, email preferences) |
| 2 | `0c1ca88` | PnL golden-vector reconciliation (Remote A–F, per-value classification) |
| 3 | `0f2abc1` | accounts application layer (port, memory adapter, service, routes, envelope widening) |
| 4 | `23124ca` | accounts persistence boundary (0004 migration + PGlite tests) |
| 5 | this commit | evidence record + AGENTS.md row |

## 1. Identity status (wave 1)

| Capability | Status | Evidence | Tests |
|---|---|---|---|
| POST `/auth/change-password` | DONE | Remote: wrong current → 400 VALIDATION_FAILED `details.currentPassword`; identical → `details.newPassword`; success `{changed:true, messageKey:'auth.passwordChanged', params:{}}`; sessions revoked via `updateMany` (ALL). PHP: `revokeAllForUser` (ALL — lineages agree); pre-change refresh token → 401 | authService 14; authRoutes 11 (journey incl. old-token rejection) |
| PATCH `/me/preferences` | DONE | `{locale: fa\|en, ai_consent}` → `{updated, locale, ai_consent, ai_consent_at}`; `ai_consent:false` → null timestamp; no field → 400 (Remote) | authService; authRoutes |
| GET/PUT `/email-preferences` | DONE | PHP is contract source (BUG-A9): 6 keys `welcome_email, security_alerts, trade_notifications, weekly_report, monthly_report, achievement_notifications`, all default 1, ints 1\|0; PUT partial boolean merge (`is_bool`), unknown keys ignored; GET/PUT messageKeys `auth.emailPreferences`/`auth.emailPreferencesUpdated` | authService; authRoutes |
| Migration `0003_email_preferences.sql` | DONE | one row per user, upsert semantics, forward-only | identityPersistence 6 (PGlite in-wasm) |

**DOCUMENTED DIFFERENCES (identity):** Local password policy min 10 vs PHP
change-password min 8 (stricter retained; exact PHP policy fixture-pending);
missing-user → 400 USER_NOT_FOUND (Remote) vs PHP ValidationException;
Remote `marketing_emails` NOT ported (older divergence from the PHP 6-key
contract). Password-changed email → Phase I.

## 2. PnL golden vectors (wave 2) — `packages/domain/src/pnlGoldenVectors.test.ts`

| Vector | Source | Expected | Local actual | Status |
|---|---|---|---|---|
| A gross/net/R | Remote `financialParity.test.ts` | 500.00 / 493.50 / 1.64500000 | identical | **VERIFIED** |
| B gross/net | Remote | 0.00 / 0.00 | identical | **VERIFIED** |
| B risk | Remote vs Local | defined (scale-8) vs undefined-risk | `risk-is-zero` (scale-2 risk 0.0001→0.00) | **DOCUMENTED DIFFERENCE** |
| C gross/net | Remote | 333.33 / 331.58 | identical | **VERIFIED** |
| C r-multiple | Remote vs Local | 2.48687500 (8÷8) vs 2.48691217 (2÷2) | 2.48691217 | **DOCUMENTED DIFFERENCE** |
| D gross | Remote | 7.50 | identical | **VERIFIED** |
| D net | Remote vs Local | 3.92 (toFixed half-up) vs 3.91 (parity-truncate) | 3.91 | **DOCUMENTED DIFFERENCE** |
| E gross/net/R | Remote | 100.00 / 100.00 / 3.33333333 | identical | **VERIFIED** |
| F gross/net | Remote | 250.00 / 244.00 | identical | **VERIFIED** |
| no-SL risk | PHP vs Remote | Local fallback risk=\|delta\| (PHP-verified) vs Remote null | fallback | **DOCUMENTED DIFFERENCE** |
| wrong-side SL | unknown | — | computes \|entry−SL\|, not frozen | **FIXTURE PENDING** |
| external serialization precision | OD-3 | — | — | **FIXTURE PENDING** |

Local ADR-001 dual-rounding engine KEPT (architecture rule: ADR wins; no
floats in money; no precision change for schema similarity). No invented
expected outputs — differences are classified, never silently resolved.

## 3. Accounts capability matrix (wave 3)

| Capability | Classification | Status | Evidence | Tests | Deferred |
|---|---|---|---|---|---|
| GET/POST `/api/v1/accounts` | PORT | DONE | Remote+PHP routes agree; list newest-first; create defaults (platform=provider, balance/equity "0.00", status disconnected, syncStatus DISCONNECTED) | accountService 6; accountRoutes 5 | — |
| Validation matrix | PORT | DONE | provider ∈ {MT4,MT5,MANUAL} REQUIRED (PHP; Remote defaults MANUAL — PHP wins, DOCUMENTED DIFFERENCE); currency 3-uppercase default USD; accountNumber `[A-Za-z0-9*._-]{1,32}`; leverage `^(?:1:)?[1-9]\d{0,7}$` default "100"; timezone IANA (Intl probe) or empty→null+source unknown; label default 'Trading Account' max 120 | accountService (validation matrix) | — |
| Plan quota | PORT | DONE | free=1, pro/enterprise=∞ → 429 `ACCOUNT_QUOTA_EXCEEDED` details `{plan, currentCount, maxAllowed}` (Remote evidence; envelope `details` widened to `string\|number` accordingly) | accountService; accountRoutes (HTTP 429) | Remote enforces in DB transaction + user row lock → Local check-then-create; **DB-level guarantee DEFERRED Phase D (documented, not pretended)** |
| POST `/accounts/detect-server` | PORT | DONE | 422 `VALIDATION_ERROR` (verified code — not VALIDATION_FAILED); login `^\d{1,32}$`; `5`-prefix→ICMarkets trio, `6`-prefix→Exness pair, else first 5 of 18; `messageKey`/`nextStepKey` payload | accountService; accountRoutes | — |
| PATCH `/:id/timezone` | PORT | DONE | set (IANA) / clear (empty→null, source `unknown`) | accountService; accountRoutes | — |
| DELETE `/:id` | PORT | DONE | hard delete → `{deleted:true}` (both lineages) | accountService; accountRoutes | — |
| Ownership enforcement | KEEP+HARDEN | DONE | non-disclosing 404 `NOT_FOUND` "Account not found." on every miss (missing OR foreign — indistinguishable); pattern Authenticated User→ownership→resource→service→port→adapter, never bypassed; no DB ops in HTTP handlers | accountService (ownership matrix); accountRoutes (cross-user 404s + ghost-id indistinguishability) | — |
| connect-metaapi / sync / sync-status | NOT IMPLEMENTED | — | PHP routes require MetaAPI | — | **Phase H** |
| Real-PG account store | NOT IMPLEMENTED | — | memory/test adapter only | accountPersistence 3 (PGlite in-wasm) | **Phase D** |

**Wave-3 architectural finding:** `trading_accounts` pre-exists in
`0001_core.sql` (MetaApi link table; `trades.account_id` FK target,
ADR-002). A `CREATE TABLE IF NOT EXISTS` in 0004 silently no-opped against
it — caught by the PGlite persistence test, corrected to additive
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` (forward-only, non-destructive).

## 4. Contract changes

- `packages/contracts/src/envelope.ts`: error `details` widened
  `Record<string, string>` → `Record<string, string | number>` (Remote quota
  details carry numbers — evidence-based).
- `apps/api/src/kernel/server.ts`: `ApiConfig.accounts` optional capability;
  `accountsRoute` helper; 5 routes. Fail-closed: unconfigured → 503
  SERVICE_UNAVAILABLE; unauthenticated → 401 UNAUTHENTICATED.
- New port `AccountStore` (smallest justified surface: listByUser,
  findByIdForUser, countByUser, create, updateTimezone, deleteForUser);
  `MemoryAccountStore` dev/test adapter.
- `apps/api/src/server-main.ts`: AccountService dev wiring; `getPlan` via
  `auth.me` plan field (0002).
- `db/migrations/0004_trading_accounts.sql`: additive ALTER (see §3); money
  `NUMERIC(20,2)` per Local ADR-001 matrix — Remote's `Decimal(18,2)` NOT
  copied (no precision change for schema similarity). DB defaults from
  Remote Prisma (provider/platform MANUAL, timezone_source 'unknown',
  sync_status DISCONNECTED, balances 0.00). `status` CHECK is the API enum
  the Remote repository actually persists (connected\|error\|disconnected,
  default disconnected); Prisma's legacy `active\|archived` enum NOT ported
  (documented divergence). CHECKs for provider/currency/leverage/status/
  sync_status; index `(user_id, created_at DESC)`.

## 5. Security review — NO REGRESSION

Argon2id exact (no parameter drift); refresh tokens hashed (SHA-256) and
revoked on password change (ALL sessions); CSPRNG for tokens/jti (no
Math.random for security randomness); CSP unchanged; ownership mandatory on
every account operation with non-disclosing 404 (no existence leak);
fail-closed routes intact (503 unconfigured — test-evidenced); no DB ops in
HTTP handlers; no floats in money; secret-scan 0 findings.

## 6. Persistence boundary (three tiers — never combined)

1. **Memory/test adapter** (`MemoryAccountStore`, `MemoryUserStore`):
   in-process dev/test only; no durability claims.
2. **PGlite in-wasm** (identityPersistence, accountPersistence,
   migrations tests): real migrations 0001–0004 against PostgreSQL
   semantics in-wasm; proves the port + SQL contract. **PGlite in-wasm is
   NOT real PostgreSQL and NOT production** (no real concurrency, no real
   row locks).
3. **Real PostgreSQL adapter: NOT IMPLEMENTED — Phase D** (accounts and
   users durable stores, transactional quota + row locks, S5 real-PG
   verification). Nothing pretends otherwise.

## 7. Tests (exact commands and counts — on the committed tree)

| Command | Result |
|---|---|
| `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` | 0 errors |
| `npm test` | **206/206** (authService 14, authRoutes 11, identityPersistence 6, pnlGoldenVectors 7, accountService 6, accountRoutes 5, accountPersistence 3, prior suite 154) |
| `npm run test:migrations` | 5/5 |
| `npx tsx tools/parity-smoke.ts` | 6 pass / 0 fail |
| `bash tools/secret-scan.sh` | PASS (0 findings) |
| lint | N/A (no lint script in repo) |

## 8. Deferred items

- **Remaining Phase C (per matrix):** trades (PORT+REDESIGN, ADR-002),
  journal/strategies/dashboard/entitlements ports; OD-3 fixture captures.
- **Phase D:** real-PG adapters (users, accounts), DB-transactional quota
  (Remote's transaction + user row lock), row locks, S5 real-PG verification.
- **Phase H:** MetaAPI connect/sync/sync-status routes; MetaApi sync/credential columns.
- **Phase I:** password-changed email; VERIFICATION_LIMIT quirk owner review;
  rate-limit fixture capture (register 5/3600 vs 10/3600).
- **Fixture-pending:** exact PHP error-object fields; register/verify payload
  equivalence; expired-token code; PHP change-password policy min-8; PnL
  wrong-side SL; external serialization precision (OD-3).
- **Intentionally not implemented:** idempotency/concurrency guarantees
  beyond memory-check-then-create (no speculative distributed locks, no
  process-local locks pretending to be DB guarantees — documented deferral).

## 9. Git evidence

- Branch `reconcile/foundation-first`; start `15d6adf` (clean) → end = this
  commit; commits `1f35f49`, `0c1ca88`, `0f2abc1`, `23124ca`, this record.
- Working tree clean at close. `main` (`07977504c346034a3be402a67c3c0106eb6d8242`)
  and tag `remote-snapshot-99e024c829db` untouched; 0 remotes.
- Main merge: **NO**. Remote-snapshot change: **NO**. Push: **NO**.
  Merge: **NO**. Deployment: **NO**.
