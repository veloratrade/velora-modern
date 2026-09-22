# Phase C Increment 7 — Rate Limiting Inventory & Determination (read-only)

Date: 2026-09-13. Base: `8d264823faf7aae70781856683319e095b10dbe8` (increment-6
terminal, baseline 259/259, migrations 5/5, parity 6/6, scan PASS — Step 0
verified). Candidate selection per the increment-7 authorization: read-only
inventory first, one capability only, stop-list respected.

Evidence sources: PHP `api/index.php` (dispatch block 256–305),
`api/src/Core/RateLimiter.php` (134 lines, read in full),
`api/src/Core/Response.php` (error envelope); Remote
`src/core/middleware/rateLimiter.ts`, `src/modules/auth/auth.routes.ts` (read
via `git show remote-snapshot-99e024c829db`); Local `packages/contracts/src/auth.ts`
(C-14), `packages/contracts/src/errors.ts`, `apps/api/src/kernel/server.ts`,
`db/migrations/0001_core.sql` (rate_limits table), `docs/capability-registry.md`
(CAP-PLAT-02), `docs/reconciliation/PHASE-C-CAPABILITY-MATRIX.md` line 63,
ADR-007 (Redis triggers).

## 0. Candidate scan (authorization Step 2 table)

| Capability | Remote | PHP | Local | Phase | Eligible now? | Classification |
|---|---|---|---|---|---|---|
| Support system (6 routes) | `src/modules/support/index.ts` = 2-line placeholder ONLY | IMPLEMENTED — 1371 lines, 6 routes (index.php 198–203) | none | (none — **no registry row**) | **NO** — absent from the owner-approved `docs/capability-registry.md`; registry rule 1 forbids agent-created rows; porting an unregistered capability is an owner decision | NOT IMPLEMENTED (this increment; owner decision required) |
| Remote `users`/`observability` modules | 2-line placeholders ONLY | n/a | n/a | — | NO — nothing portable (verified: placeholders) | n/a (nothing to port) |
| Dashboard (row 13) | implemented | implemented | partial anchors | C-later | NO — **stop-listed for increment 7** | (deferred by authorization) |
| MetaAPI / OCR / AI / Backtest / Strategy Lab | partial | implemented | contracts only | H–K | NO — stop-listed | (deferred by authorization) |
| Real PostgreSQL / Phase D | n/a | n/a | memory + PGlite tests | D | NO — stop-listed | (deferred by authorization) |
| **Rate limiting (CAP-PLAT-02)** | implemented — `rateLimiter.ts` + per-route values in `auth.routes.ts` | implemented — dispatch-level limits (index.php 256–305) + `Core/RateLimiter.php` | contracts only — C-14 `RATE_LIMIT_DEFAULTS` + `RATE_LIMITED` code + `rate_limits` table (0001); **no limiter seam yet** | C (registry: PORT) | **YES** — registry row CAP-PLAT-02 (owner-approved, PORT/PORT); the matrix line-63 deferral ("PHP fixture evidence required before freezing") is now satisfiable: the PHP source read below IS the fixture evidence, and it resolves the C-14 discrepancy | **PORT** (PHP mechanics + PHP limit values; Remote fail-closed store-error posture adopted) |

Determination: **NEXT ELIGIBLE CAPABILITY = Rate limiting (CAP-PLAT-02),
classification PORT.** A documented NOT IMPLEMENTED result is recorded above for
Support (unregistered); no capability was manufactured.

## 1. C-14 discrepancy resolution (the line-63 deferral, now closed)

Matrix line 63 flagged: Local C-14 defaults (register 5/3600) vs Remote route
values (register 10/3600), "PHP fixture evidence required before freezing".
VERIFIED EVIDENCE (PHP source, dispatch block `api/index.php` 256–305 — applied
to POST requests by exact path match BEFORE router dispatch):

| Route | PHP (dispatch) | Local C-14 default | Remote (auth.routes.ts) |
|---|---|---|---|
| POST /auth/register | **5 / 3600** | `auth:register` 5/3600 ✓ | 10/3600 ✗ |
| POST /auth/login | **8 / 300** | `auth:login` 8/300 ✓ | 10/300 ✗ |
| POST /auth/verify-email | **20 / 900** | `auth:verify-email` 20/900 ✓ | 10/900 ✗ |
| POST /auth/resend-verification (+ alias -email) | **4 / 3600** | `auth:resend-verification` 4/3600 ✓ | 5/900 ✗ (both value and window) |
| POST /auth/forgot-password | **4 / 3600** | `auth:forgot-password` 4/3600 ✓ | 5/900 ✗ |
| POST /auth/reset-password | **6 / 3600** | `auth:reset-password` 6/3600 ✓ | 5/900 ✗ |
| POST /auth/refresh | **30 / 300** | `auth:refresh` 30/300 ✓ | **not limited** ✗ |
| POST /auth/change-password | **8 / 900** | `auth:change-password` 8/900 ✓ | **not limited** ✗ |
| POST /accounts/connect-metaapi | 5 / 900 | — (Phase H) | — |
| POST /accounts/detect-server | 20 / 900 | — (Phase H) | — |
| POST /webhooks/metaapi | 120 / 60 | — (Phase H) | — |
| POST /accounts/{id}/sync (regex) | 20 / 300 | — (Phase H) | — |
| POST /ai/analyze-trades, weekly-report, feedback | 10/3600, 5/3600, 20/3600 | `trades:extract-screenshot` 8/300 (matches PHP `ScreenshotExtractController.php:39` 8/300, Phase J) | — |

**Resolution:** Local C-14 defaults match the PHP dispatch values EXACTLY on
every auth route (and the OCR route). PHP is the lineage contract source (C-14
row: "verified limits, carried as defaults"); the frozen part is
limits-as-defaults and it already agrees with the PHP fixture. Remote's values
are a Remote-side divergence (different values on every limited route, two
routes unlimited) — **documented divergence, not a contradiction**: the
contract source (C-14/PHP) is unambiguous. The deferral condition is discharged;
no product decision is required.

## 2. PHP mechanics (VERIFIED EVIDENCE — `Core/RateLimiter.php`, read in full)

1. **Bucket key** = `"{op}|{clientIp}"` (e.g. `login|1.2.3.4`); `rate_limits`
   row PK = the full bucket key.
2. **Fixed window anchored at the first hit** of the window:
   - per-hit `DELETE FROM rate_limits WHERE bucket = :b AND window_start < now − windowSec`
     (expire this bucket using ITS OWN window — a global cleanup would shorten
     longer policies);
   - per-hit stale sweep `DELETE … WHERE window_start < now − 172800` (48 h),
     independent of any bucket policy;
   - upsert `hits = hits + 1` (SQLite `ON CONFLICT(bucket) DO UPDATE` /
     MySQL `ON DUPLICATE KEY`), `window_start` preserved on increment;
   - read back `{hits, window_start}`.
3. **Decision**: block when `hits > maxAttempts` AFTER incrementing → the
   limit-th attempt is allowed, the (limit+1)-th is the first blocked one.
   Blocked hits still increment (the counter keeps growing inside the window).
4. **429 response**: header `Retry-After: max(1, (window_start + windowSec) − now)`
   (integer seconds, minimum 1); body via `ApiException('Too many requests.',
   429, 'TOO_MANY_REQUESTS', null, 'errors.rateLimited')` rendered by
   `Response::error` → `error.code = 'TOO_MANY_REQUESTS'`,
   `error.message = 'Too many requests.'` (`defaultMessage(429)`),
   `error.messageKey = 'errors.rateLimited'` (top-level in `error`, with
   `params`), `status: 'error'`, `data: null`, ISO `timestamp`.
5. **Client IP** (`RateLimiter::clientIp`): `REMOTE_ADDR` validated (invalid →
   `0.0.0.0`); `X-Forwarded-For` honored ONLY when the immediate peer matches a
   configured `trusted_proxy_cidrs` entry (default: none → header never
   trusted); first XFF entry only, validated; values capped at 64 chars.
   CIDR matching: byte-exact `inet_pton` comparison, IPv4/IPv6, per-family
   length check, prefix default = full length, prefix bounds validated,
   invalid entries skipped.
6. **Application point**: dispatch level, BEFORE routing/controllers — attempts
   count even when the request later fails validation or auth (brute-force
   semantics).
7. **Store failure**: DB exceptions surface as `ServiceUnavailableException` →
   503 (fail-closed, no silent pass-through).

## 3. Remote mechanics (VERIFIED EVIDENCE)

1. `src/core/middleware/rateLimiter.ts`: prisma `rate_limits` table, same
   `"{name}|{ip}"` bucket shape; deleteMany-expired + findUnique +
   update/create; `currentHits > maxAttempts` → 429 `TOO_MANY_REQUESTS`
   (message "Too many requests.").
2. **Fail-closed store error**: non-test env → 503 `SERVICE_UNAVAILABLE`
   (memory fallback exists ONLY in test env).
3. ** getClientIp trusts `X-Forwarded-For` blindly** (first entry, no
   trusted-proxy check) — spoofable; weaker than PHP. NOT ported.
4. **No `Retry-After` header** on 429. NOT ported (PHP richer contract wins).
5. Limits applied inside route handlers (first statement), values per the
   table in §1 — every value diverges from PHP; refresh and change-password
   unlimited.

## 4. Local current state (VERIFIED)

- `packages/contracts/src/auth.ts` ~line 57: `RATE_LIMIT_DEFAULTS` (9 keys)
  with the PHP-verified values; `contracts.test.ts` pins 3 of them (C-14 test).
- `packages/contracts/src/errors.ts`: `RATE_LIMITED` code — appears in NEITHER
  lineage (both emit `TOO_MANY_REQUESTS`); zero usages in the tree. Evidence
  correction required (see §6 D3).
- `db/migrations/0001_core.sql` 161–165: `rate_limits (bucket TEXT PRIMARY KEY,
  hits BIGINT NOT NULL DEFAULT 1, window_start TIMESTAMPTZ NOT NULL)` — matches
  the PHP/Remote schema shape exactly. **No migration needed.**
- Kernel `route()`: 5 of the 8 PHP-limited auth routes exist
  (register/login/refresh/verify-email/change-password; resend/forgot/reset are
  Phase I, OCR Phase J, MetaAPI Phase H). No limiter seam, no client-IP
  extraction, no trusted-proxy config anywhere.
- `RouteResult` supports `headers` (Cache-Control precedent) → `Retry-After`
  deliverable. `fail(code, message, requestId, details)` with
  `details: Record<string, string|number>` → messageKey-in-details per the
  frozen C-10 envelope.
- ADR-007 trigger #1 (multi-node shared rate-limit state) not met →
  single-process store now, swappable store port = the Redis seam.

## 5. Contract for this increment (contract-first; the slice)

**Scope**: apply PHP-verified throttling to the five IMPLEMENTED Local auth
routes. Phase H/I/J routes have no Local route yet — their C-14 defaults stay
in contracts and light up when those routes land (no speculative wiring).

| Element | Contract |
|---|---|
| Endpoints | POST `/api/v1/auth/register` → `auth:register` 5/3600; `/auth/login` → 8/300; `/auth/refresh` → 30/300; `/auth/verify-email` → 20/900; `/auth/change-password` → 8/900 (values from `RATE_LIMIT_DEFAULTS`, single source) |
| Ordering | dispatch-level: limiter runs BEFORE validation/auth/capability checks (PHP §2.6) — invalid-body and unauthenticated attempts still count |
| Bucket | `"{key}|{clientIp}"`, fixed window anchored at first hit, limit-th allowed, (limit+1)-th first blocked, blocked hits keep counting |
| Client IP | socket remote address; X-Forwarded-For (first entry) honored only when the peer ∈ configured trusted-proxy CIDRs; **default: trust nothing (fail-closed)**; invalid → `0.0.0.0`; 64-char cap |
| 429 body | C-10 envelope: `status:'error'`, `data:null`, `error.code='TOO_MANY_REQUESTS'`, `error.message='Too many requests.'`, `error.details={messageKey:'errors.rateLimited'}`, `requestId`, ISO `timestamp` |
| 429 header | `Retry-After: max(1, window_start + windowSec − now)` seconds |
| Store failure | 503 `SERVICE_UNAVAILABLE` fail-closed (Remote §3.2 + PHP §2.7 + Local doctrine) — never a silent pass-through |
| Persistence | NO migration; 0001 `rate_limits` table proven via a test-local PGlite adapter (persistence-boundary pattern, like identityPersistence) |
| Runtime store | per-process memory store (single-node per ADR-007; S8 dev posture — real-PostgreSQL stores are Phase D); store port = Redis seam (ADR-007 trigger #1) |
| Always-on | no capability toggle: `createApp` builds a default limiter per app when none injected (PHP applies limiting unconditionally at dispatch; per-app instance preserves the established per-test-server isolation) |

## 6. Divergences & decisions

- **D1 (values)** — Remote vs PHP limits: PHP wins (C-14 lineage contract,
  already frozen in Local contracts). Documented, no action.
- **D2 (messageKey placement)** — PHP/Remote put `messageKey` top-level in
  `error`; Local's frozen C-10 envelope has no such field → carried as
  `details.messageKey` (same documented divergence class as increment 6;
  envelope change would break C-10; OD-3 fixture-pending).
- **D3 (error code)** — Local taxonomy has `RATE_LIMITED`; both lineages emit
  `TOO_MANY_REQUESTS` (PHP `Response::defaultCode(429)` + explicit ApiException
  code; Remote ApiError). Zero usages of the old constant → replace
  `RATE_LIMITED` with `TOO_MANY_REQUESTS` in `ERROR_CODES` (evidence
  correction, documented here; not a frozen external-contract change — C-14
  freezes the limits, and no Local endpoint has ever emitted either code).
- **D4 (Retry-After)** — PHP yes / Remote no → port PHP (verified richer
  contract).
- **D5 (IP trust)** — Remote's blind XFF trust is spoofable; port PHP's
  trusted-proxy CIDR gate (KEEP+HARDEN relative to Remote; fail-closed default).
- **D6 (store error)** — Remote memory-fallback-in-test / 503-in-prod; Local:
  any store failure → 503 (fail-closed; the default runtime store is memory and
  does not fail in practice; injected stores prove the 503 path by test).

## 7. Stop-condition check

No contradictory evidence (§1 resolves the flagged discrepancy from source); no
product decision required (limits are an owner-frozen contract, C-14); no
invented behavior (every semantic traced to PHP source above); no ADR violation
(ADR-010 apps-thin: logic in domain/contracts; ADR-007: no Redis, store port
is the seam; ADR-006: error-code tier documented); no real PostgreSQL (PGlite
test evidence only, labeled as such); no production/staging access; no
migration (table exists in 0001); no scope expansion (5 auth routes; Phase H/I/J
routes untouched); no UI work (backend-only; 429 envelope consumed by existing
error rendering). **Proceed to implementation.**
