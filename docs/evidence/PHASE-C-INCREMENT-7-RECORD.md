# Phase C Increment 7 Record — Rate Limiting / Route Throttling (2026-09-13)

**Scope:** Rate limiting capability only (registry CAP-PLAT-02, PORT;
capability-matrix "Rate limits" row). Start HEAD
`8d264823faf7aae70781856683319e095b10dbe8` (verified: branch
`reconcile/foundation-first`, clean tree, main `07977504…` and snapshot tag
untouched, 0 remotes; Step 0 baseline before any change: tsc 0, **259/259**,
migrations 5/5, parity 6/6, scan PASS; `npm ci` + dependency-order rebuild
after workspace restore — snapshot-excluded `dist`/`node_modules`, known
environment property). Inventory (read-only, committed first):
`docs/reconciliation/PHASE-C-INC7-RATELIMIT-INVENTORY.md`.

| # | Commit | Content |
|---|---|---|
| 1 | `753dd50` | rate-limiting inventory + determination (read-only; C-14 discrepancy resolved from PHP source) |
| 2 | `4706acf` | domain window semantics + client-IP/trusted-proxy port + contracts correction + limiter module + kernel wiring + full test matrix |
| 3 | this commit | evidence record + matrix row update + AGENTS.md row |

## 1. Capability determination

- **PHP (contract source):** fully implemented — dispatch-level throttle in
  `api/index.php` (256–305) applied to enumerated POST paths BEFORE routing;
  `Core/RateLimiter.php` (134 lines): bucket `{op}|{clientIp}`, fixed window
  anchored at first hit, increment-then-check (`hits > max` blocks → limit-th
  allowed, (limit+1)-th first blocked, blocked hits keep counting), per-bucket
  own-window expiry + 48h stale sweep, `Retry-After: max(1, windowEnd − now)`
  header, 429 `TOO_MANY_REQUESTS` + message "Too many requests." + messageKey
  `errors.rateLimited`; `RateLimiter::clientIp` honors X-Forwarded-For only
  from trusted-proxy CIDR peers (fail-closed default). Auth limits:
  login 8/300, register 5/3600, verify-email 20/900, resend-verification 4/3600,
  forgot 4/3600, reset 6/3600, refresh 30/300, change-password 8/900 (+
  Phase H MetaAPI and Phase J AI/OCR routes, out of Local scope until those
  routes exist).
- **Remote:** implemented but divergent — `rateLimiter.ts` (prisma-backed,
  same bucket shape, fail-closed 503 on store error in non-test env) with
  per-route values that differ from PHP on every limited route (register
  10/3600, login 10/300, verify-email 10/900, resend 5/900, forgot 5/900,
  reset 5/900) and NO limit on refresh/change-password; blind X-Forwarded-For
  trust (spoofable); no Retry-After.
- **Local before:** contracts only — C-14 `RATE_LIMIT_DEFAULTS` (values match
  PHP dispatch exactly), `RATE_LIMITED` error-code placeholder (in neither
  lineage), `rate_limits` table in 0001 (matches the PHP/Remote schema shape).
  No limiter seam, no client-IP extraction, no trusted-proxy config.
- **Matrix line-63 deferral DISCHARGED:** the flagged discrepancy (Local C-14
  register 5/3600 vs Remote route 10/3600) resolves from PHP source — the
  Local C-14 defaults are the PHP-verified lineage contract; Remote's values
  are a documented Remote divergence (inventory §1/§6 D1). No product decision
  required; nothing was frozen differently.
- **Determination: PORT** — PHP mechanics + PHP values, with the Remote
  fail-closed store-error posture adopted (it matches PHP's
  ServiceUnavailableException handling and Local doctrine).

## 2. Implemented (this increment)

| Behavior | Status | Evidence | Tests |
|---|---|---|---|
| Fixed-window decision: limit-th allowed, (limit+1)-th first blocked; blocked hits keep counting | DONE | PHP `RateLimiter.php` increment-then-check | domain rateLimit 3, rateLimiter 2 |
| `Retry-After` seconds = max(1, ceil(windowEnd − now)) — never 0/negative | DONE | PHP `max(1, ($startedAt + $windowSec) − time())` | domain rateLimit (clamp + ceil vectors) |
| Bucket key `{routeKey}|{clientIp}`; window anchored at first hit; per-bucket own-window expiry (a 300s policy never shortens a 3600s bucket) | DONE | PHP bucket concat + per-bucket DELETE comment | memory store 5, PGlite 5 |
| 48h stale sweep (storage hygiene, independent of bucket policy) | DONE | PHP stale DELETE (172800s) | memory store 1, PGlite 1 |
| Client IP: peer address; X-Forwarded-For honored ONLY from trusted-proxy CIDR peers; first entry, validated; `0.0.0.0` fallback; 64-char cap | DONE | PHP `RateLimiter::clientIp` | domain clientIp 7 |
| CIDR matching: byte-exact IPv4/IPv6, per-family lengths, prefix default/bounds, invalid entries skipped | DONE | PHP `matchesAnyCidr` (inet_pton) | domain clientIp (v4/v6/families/malformed) |
| Throttled routes = exactly the 5 implemented Local auth routes, values from C-14 (single source) | DONE | PHP dispatch table ∩ implemented Local routes | HTTP THROTTLED_AUTH_ROUTES test |
| Limiter runs BEFORE validation/auth/capability checks (attempts count regardless of outcome) | DONE | PHP dispatch-level application | HTTP before-validation + 503→429 ordering tests |
| 429 envelope: C-10 shape, code `TOO_MANY_REQUESTS`, message "Too many requests.", `details.messageKey = "errors.rateLimited"`, requestId, ISO timestamp | DONE | PHP ApiException + `Response::error` (messageKey placement = documented divergence D2, same class as inc 6; C-10 frozen) | HTTP register test (full envelope) |
| `Retry-After` response header on 429 | DONE | PHP header() (Remote: absent — divergence D4, PHP wins) | HTTP register/login/verify-email/refresh/change-password |
| Store failure → 503 `SERVICE_UNAVAILABLE` fail-closed, never a silent pass-through | DONE | Remote non-test invariant + PHP ServiceUnavailableException + Local doctrine | HTTP fail-closed test |
| Always-on limiter: per-app default (fixed-window + memory store) when none injected | DONE | PHP applies throttling unconditionally at dispatch; per-app instance preserves per-test-server isolation | entire suite runs under the default limiter |
| Error-taxonomy correction: `RATE_LIMITED` → `TOO_MANY_REQUESTS` | DONE | both lineages emit TOO_MANY_REQUESTS; the placeholder appeared in neither and had zero usages (inventory §6 D3) | contracts taxonomy test |
| PGlite persistence boundary over the EXISTING 0001 `rate_limits` table | DONE (test-local adapter, PHP-shaped SQL) | persistence-boundary pattern (identityPersistence) | PGlite 5 |

Not implemented (evidence-documented, not gaps): Phase H MetaAPI routes
(connect 5/900, detect 20/900, webhook 120/60, sync 20/300) and Phase J
AI/OCR routes — no Local routes exist; Phase I auth routes (resend 4/3600,
forgot 4/3600, reset 6/3600) — C-14 defaults ready, wiring lands with the
routes. No new endpoints, no UI, no migration.

## 3. Divergences (documented, not silently resolved)

- **D1 values:** Remote ≠ PHP on every route; PHP wins (C-14 lineage).
- **D2 messageKey placement:** PHP/Remote top-level `error.messageKey` vs
  Local `details.messageKey` (C-10 envelope frozen; OD-3 fixture-pending).
- **D3 error code:** Local placeholder RATE_LIMITED corrected to
  TOO_MANY_REQUESTS before any endpoint ever emitted either.
- **D4 Retry-After:** PHP yes / Remote no → PHP ported.
- **D5 IP trust:** Remote's blind XFF trust is spoofable → PHP trusted-proxy
  gate ported (fail-closed default: empty CIDR list never trusts the header).
- **D6 store error:** Remote memory-fallback-in-test / 503-in-prod → Local:
  any store failure 503 (the default memory store does not fail in practice;
  the 503 path is test-proven with an injected failing store).
- **Runtime store:** both lineages persist buckets in the DB at runtime;
  Local Phase C runs a per-process memory store (S8 dev posture —
  real-PostgreSQL stores are Phase D). The `RateLimitStore` port + the 0001
  table (PGlite-proven) are the durable seam; **no DB-backed runtime claims
  are made for this increment.** Multi-node shared state would be an ADR-007
  trigger (not met).

## 4. Verification (final battery, committed tree)

- `npm run typecheck`: **0 errors** (contracts, domain, api, worker, web).
- `npm test`: **296/296** (259 baseline + 37 new: domain rateLimit 4,
  clientIp 7, memory store 5, limiter 5, HTTP contract 10, PGlite persistence
  5, contracts 1). No existing test weakened or removed.
- `npm run test:migrations`: **5/5**. `tools/parity-smoke.ts`: **6/6**.
  `tools/secret-scan.sh`: **PASS (0 findings)**.
- Git: `reconcile/foundation-first`; commits `753dd50` → `4706acf` → this
  record; main `07977504…` and snapshot tag untouched; 0 remotes; no
  push/merge/deploy.

## 5. ADR / doctrine traceability

ADR-010 (apps thin — decision logic in `packages/domain`, policies in
`packages/contracts`, kernel only routes/renders), ADR-007 (no Redis; the
store port is the documented seam; single-node posture), ADR-006 (error-code
tier change documented in the inventory before the code), S2/S8 (no boot
changes; memory posture unchanged; no PostgreSQL claims), fail-closed
doctrine (503 on store error; trusted-proxy default empty), C-10 (envelope
frozen — messageKey in details), C-14 (limits as defaults — values verified
against the PHP dispatch table, all eight auth routes exact).

## 6. Open items (deferred, evidence-tagged)

- Phase I: wire resend-verification / forgot-password / reset-password limits
  when those routes land (C-14 defaults ready).
- Phase J: `trades:extract-screenshot` 8/300; Phase H: MetaAPI route limits
  (dispatch table values in inventory §1).
- Phase D: durable (PostgreSQL) rate-limit store behind the existing port;
  row-level atomicity (PHP upsert+select is best-effort cross-request —
  single-process Local is equivalent under the memory store).
- Phase N/infra: `TRUSTED_PROXY_CIDRS` boot-level configuration plumbing
  (kernel accepts the list; server-main currently relies on the fail-closed
  default), plus a proxy-aware deployment review.
- OD-3: exact PHP error-object fixture capture (messageKey/params placement).
