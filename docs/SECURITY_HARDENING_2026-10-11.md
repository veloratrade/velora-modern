# Security Hardening — Full Guard Repair 2026-10-11 (validity-reviewed)

Branch `chore/guard-repair-2026-10-11` from verified `main` `354edaae38c3c482594f06ff3e10879bff43aaf2` (`origin/main == origin/HEAD`). Commits `e3d6361` (governance) → `87547d6` (initial hardening) → `96f99e1` (audit+docs) → this revision (validity-hardened suite). No `main` push/force-push/merge/deploy/Telegram.

## 1. CI integrity & cost controls

- `ci.yml` header `DISABLED→ENABLED` with cost controls (push[main]+pr[main], 15m, cancel-in-progress, standard runner, no schedules/caches) — preserves `tools/check_github_cost_guard.py`. Previously contradicted live runs `38115747611`.
- Added `permissions: contents: read` (was write-default).
- Added `npm audit --audit-level=high || true` informational.
- `npm ci` lockfile integrity (fails if out of sync, lockfileV3 59K), 64-MiB generic / 24-MiB screenshot ceilings.
- Branch protection authed `strict:true contexts:["verify"] 15368` — required check `verify` only; other workflows informational.

## 2. Dependency & secret guards — implemented & tested

- `.github/dependabot.yml` weekly npm (no auto-merge), `docs/DEPENDENCY_SECURITY_2026-10-11.md`, `npm audit` 0 high/critical (74 packages). **Implemented & tested** via `ci.verify` + `npm ci`.
- `tools/secret-scan.sh` mandatory in `ci.verify` (PATs, JWT `eyJ…`, URL creds, private keys). Fix: hardening suite initially contained `eyJhbGci…` which correctly failed scan — replaced with `invalid-token-123`. **Implemented & tested** (scan PASS).

## 3. Security headers — implemented & tested

- Kernel `security.ts` emits `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000` (Legacy parity), per-request `CSP` with 24-char nonce, `X-Request-Id`. **Implemented & tested** (`HARDENING-06` on `/health` + `/api/v1/auth/login`, nonce uniqueness; `server.test.ts` also).

## 4. Hardening tests — claim vs actual vs limitation

All tests provision **really mounted handlers** with realistic fixtures. A `503` is ONLY accepted when the test is explicitly `fail-closed` (HARDENING-10, or H-01's optional-capability note). Otherwise the harness provisions the capability (trades/support) so a `503` would be a failure.

| Test | Claim | Actual tested behavior (real handler?) | Result | Remaining limitation |
|---|---|---|---|---|
| **H-01** unauthenticated | `GET /auth/me` without token → `401` (not `200`/`500`) | Real: `withAuthOnly` (only `auth` mounted) → `GET /auth/me` 401 + code, malformed `Bearer` 401, optional `trades` absent → `503` fail-closed (explicit) | **PASS** — **implemented & tested** for `auth` | Live `trades`/`accounts` unauthenticated not tested here (covered by `tradeRoutes.test.ts` “unauthenticated → 401 on every trades route” which provisions trades). Live per-IP / Cloudflare not verified. |
| **H-02** cross-user isolation | Owner’s private resource invisible to other user (`404` non-disclosing, not `200`/`403` leak) | Real: **two resources**: (a) `withTrades` → owner creates `VECTOR_A` trade via `TradeService`+`MemoryTradeStore` → other `GET /trades/:id` 404, `PUT` 404, `GET /trades` list excludes it; (b) `withSupport` → alice ticket → bob `GET /support/tickets/:id` 404 `NOT_FOUND` | **PASS** — **implemented & tested** on real `TradeService` & `SupportService` ownership checks (`findActiveByIdForUser`, `conversationForUser`) | Uses `Memory*Store` (service-layer isolation), not real Postgres RLS; DB-level isolation proven separately by `migrations.test.ts` constraints + `db/tests` (not live production PG). No webhook/journal isolation tested here (existing `journalApplicationService` covers). |
| **H-03** RBAC | Regular user denied admin handler `403`, admin allowed `200` | Real: `withSupport` (support mounted, role from `MemoryUserStore.updateUserRole` → JWT) → alice `GET /admin/communications/tickets` 403 `FORBIDDEN`, admin `200` and sees ticket, `GET /admin/.../:id` same split | **PASS** — **implemented & tested** on real `supportRoutes` admin-authority check (`role: admin/super_admin`) | Only `support` admin surface tested; `adminUsers` (`users.view`/`change_role`) RBAC not exercised in this suite (covered by `adminUserRoutes.test.ts` & `rbacRoutes.test.ts`). System Owner / `super_admin` super-privilege not tested here. Live Telegram/Cloudflare RBAC not verified. |
| **H-04** validation / SQLi / XSS | Invalid input `400`, malformed JSON `400`, SQLi via `q` does not widen or `500`, XSS stored safely | Real: `withTrades` → invalid `direction: sideways` → `400 VALIDATION_FAILED` with details; malformed JSON → `400`; create GBPUSD trade, then `GET /trades?q=' OR '1'='1` → `200` with `items: []` (literal substring, not SQL eval, no `syntax error`/`postgres` leak), normal `q=GBPUSD` → `200` `items: [GBPUSD]` (proves path exercised); nested `withSupport` → `<script>` in subject/message → `201` stored as literal, `GET` returns literal, never `500` | **PASS** — **implemented & tested** on real `TradeService` validation & `MemoryTradeStore` search | `MemoryTradeStore` is substring match, not real SQL — **real PG parameterization** proven by `migrations.test.ts` (DB rejects malformed envelope, nonce reuse) + `tradePersistence.test.ts`; XSS “stored as literal” means server does not strip — **frontend escaping not verified** (must be verified in `apps/web`). URL `q` encoding edge cases (`%27`) not covered. |
| **H-05** oversized | Hurtful body rejected by real size layer `400`/`413` not `500`/OOM, server stays alive | Real: `withAuthOnly` (auth always mounted, `parseJsonBody` default 1 MiB) → `2 MiB` password `POST /auth/login` → `413 PAYLOAD_TOO_LARGE` (or `400` if JSON-too-large), next `register` still `201` (not OOM) | **PASS** — **implemented & tested** on real `parseJsonBody` (`MAX_RAW_BODY_BYTES 64 MiB`, default 1 MiB) | Only generic `1 MiB` limit proven; route-specific ceilings (webhook `1 MiB`, screenshot `24 MiB`) not-driven here (covered by `metaApiWebhookService.test.ts` 1 MiB 413 & `aiRoutes.test.ts` 24 MiB). `64 MiB` max not tested (would OOM CI). |
| **H-06** headers | Every response carries `CSP` nonce, `nosniff`, `DENY`, `HSTS`, `X-Request-Id`, nonces differ | Real: `withAuthOnly` → `GET /health` + `POST /auth/login` → all headers, CSP 24-char nonce, no `unsafe`, nonces differ | **PASS** — **implemented & tested** (both liveness & API) | Only `health` + `auth/login` sampled; not every route. Live TLS (`HSTS` ignored on plain HTTP) not verified. |
| **H-07** leakage | `401`/`404` never contain `secret`/`stack`/`node_modules`/`postgres` | Real: `withAuthOnly` → `GET /auth/me` with invalid token + unknown route → both lowercased bodies checked | **PASS** — **implemented & tested** | Log output (Railway/Cloudflare) not inspected — only HTTP error bodies. `secretLeak.test.ts` (worker) covers job logs separately. |
| **H-08** rate-limit `429` + prod config | Burst → `429` with `Retry-After`; prod `RATE_LIMIT_DEFAULTS` frozen & `FixedWindowRateLimiter+MemoryRateLimitStore` throttles | Real (two layers): (a) **Mock** `RateLimiter` that only throttles `auth:login` after 3 → 5 rapid `POST /auth/login` → ≥1 `429` `Retry-After` `TOO_MANY_REQUESTS`; (b) **Prod config** `RATE_LIMIT_DEFAULTS["auth:login"]=8/300` & `["auth:register"]=5/3600` frozen; **real** `FixedWindowRateLimiter+MemoryRateLimitStore` → 8 logins allowed, 9th `allowed:false`+`retryAfterSec`; same via `createApp` store | **PASS** — (a) **mock-tested** `429` path; (b) **implemented & tested** config+integration (real limiter+store) | **Mock for HTTP 429** — live per-IP extraction (`resolveClientIp` + `trustedProxyCidrs`) and **PG store** (`PgRateLimitStore`) not exercised here (unit `memoryRateLimitStore.test.ts` + `rateLimitPersistence.test.ts` with real PG cover). Cloudflare edge not verified. |
| **H-09** pagination bounds | Invalid pagination not `500`/unbounded; valid pagination bounded | Real: `withTrades` (trades mounted, `limit` clamped `1..200`, `page` clamped `1+`) → `limit=0` → `200` `pagination.limit 20`, `limit=1000` → `200` `limit 200`, `page=-5` → `200` `page 1`, `limit=10 page=1` → `200` `items.length ≤10`; `withSupport` (PAGE_SIZE `20`) `page=-10` → `200` page 1 (or `400`), never `500` | **PASS** — **implemented & tested** on real `TradeService.searchTrades` clamping + `SupportService` paging | Clamping is **implemented as documented divergence** (not `400`). If the spec required `400` for out-of-range, this would be a contract miss — docs call it out as clamp. `offset` is not a user param for support (server ignores), so offset-injection not tested. Expensive `q`/`order` combinations not stress-tested. |
| **H-10** resilience fail-closed | Missing capability `503` not `500`; `health` `200` while `ready` `503` on DB fail | Real: `createApp` without `auth` → `POST /auth/register` `503 SERVICE_UNAVAILABLE`; `checks.database→fail` → `GET /health` `200`, `GET /ready` `503` | **PASS** — **implemented & tested** explicit fail-closed | Live dependency failure (real PG `statement_timeout`, `pg-boss` queue, Redis) not verified — only in-process `checks` mock. Unbounded-queue / backpressure not load-tested. |

**What is NOT in this suite and where it is covered:**

- Webhook HMAC/timestamp/replay/1 MiB/413/dedup → `metaApiWebhookService.test.ts` (real) — **implemented & tested**, but not via hardening suite.
- Real Postgres parameterization & constraints → `db/tests/migrations.test.ts` 19/19, `tradePersistence.test.ts`, `rateLimitPersistence.test.ts` (PGlite disposable, not prod PG) — **implemented & tested**, but **live PG not verified**.
- Frontend XSS escaping, Cloudflare edge, per-IP `X-Forwarded-For` with `trustedProxyCidrs`, queue/worker backpressure, load profiles — **NOT VERIFIED** in this PR (requires staging-only/prod verification per guard plan).

## 5. Verification (this revision)

```
npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web          # PASS
bash tools/secret-scan.sh                                                             # PASS (0)
node ./node_modules/tsx/dist/cli.mjs --test apps/api/src/security/securityHardening.test.ts  # 10/10
node tools/run-tests.mjs                                                             # 294 tests PASS (118 files: 108 general + 10 PGlite, exit 0)
npm run test:migrations  # tsx --test db/tests/migrations.test.ts                  # 19/19 PASS (PGlite disposable)
npm audit --audit-level=high                                                         # 0 high/critical (74 packages)
```

No force-push, no `main` merge, no Telegram/prod deploy, no Legacy/`localized` edit, no branch-protection change. `main` stays `354edaa`.

## 6. What changed

- `e3d6361` governance hardening (cherry-picked `456881c`): `ci.yml` header, `permissions`, `dependabot`, `DEPENDENCY_SECURITY` doc.
- `87547d6` → **revised** hardening suite (10 tests now on real handlers with `Memory*Store` fixtures; no `503`-as-proof).
- `96f99e1` audit+docs → **revised** this doc (validity table, NOT VERIFIED disclosures).
- `ci.yml` `npm audit` step retained.

## 7. Residual

Telegram `update→API/webhook→pg-boss→worker→journal` unchanged; Cloudflare/load profiles remain Phase-1 staging-only per plan.
