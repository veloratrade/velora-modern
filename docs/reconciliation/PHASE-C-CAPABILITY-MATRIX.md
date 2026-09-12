# Phase C — Capability Matrix & External Contract Inventory (2026-09-12)

**Directive:** Phase C only (business capability reconciliation & porting). Local =
architectural foundation; Remote (frozen `remote-snapshot-99e024c829db`) = behavioral
reference; PHP (`veloratrade/veloratrade` @ `a8eabac`, via velora-sparse) = behavioral +
visual contract source. Nothing is copied; behavior is re-implemented natively.

**Evidence bases:** Remote snapshot (read via `git show`, never checked out), PHP
reference source, Local tree, baseline audit + gate reports (2026-09-12), and the
executed Phase B work. Classifications per the required model.

## A. Capability Matrix (C1)

| # | Capability | Classification | Remote evidence | Local status | Phase | Action / deferral reason |
|---|---|---|---|---|---|---|
| 1 | Authentication (register/login/refresh/logout/me/verify-email) | **PORT + KEEP+HARDEN** | `src/modules/auth/auth.routes.ts`, `auth.service.ts` (full flows, in-memory tested) | Phase B hardened primitives (JWT, hashing, boot gate); no flows | **C (this increment)** | Port flows onto Local security foundation; no memory fallback, CSPRNG jti |
| 2 | Auth: change-password, preferences, email-preferences | **PORT** | `auth.routes.ts` (protected routes) | Not implemented | C-later | Needs session revocation semantics + prefs schema; next increment |
| 3 | Auth: resend-verification, forgot/reset-password | **PORT (blocked on email)** | `auth.service.ts` (token logic implemented) | Email contracts C-06/C-07 exist | Phase I gate | Token logic portable, but flows end in email dispatch — defer with email |
| 4 | Users / profile model | **PORT** | `auth.service.ts` PublicUserDto (fullName, timezone, plan, aiConsent) | `users` table lacks those columns | **C (this increment)** | Narrow forward-only migration `0002` adds Remote-verified fields |
| 5 | Authorization / ownership | **PORT + KEEP+HARDEN** | `requireOwned`, `verifyAccountOwnership` (audit-verified) | Origin guard in kernel; RBAC contracts | C-later | Port ownership pattern with trades/accounts; fail-closed |
| 6 | Trading accounts | **PORT** | `src/modules/accounts/*` (service+repo+routes) | No Local equivalent | C-later | Needs PersistencePort expansion; ownership checks mandatory |
| 7 | Trades (CRUD/read model) | **PORT + REDESIGN (write path)** | `src/modules/trades/*` | Local schema + ADR-002 design only | C-later → Phase E | Read model ported; destructive mutation replaced by ledger/correction events (ADR-002 wins over Remote mutable CRUD) |
| 8 | Trade events / immutable ledger | **KEEP (Local design) + REDESIGN** | none (Remote has no ledger) | `packages/domain/tradeLedger.ts` (tested) | Phase E | Local-led design; enforcement staged per OD-9 |
| 9 | Journal (exits) | **PORT** | `trades.routes.ts` `/:id/exits` (atomic exits, audit-verified) | No Local equivalent | C-later | Atomic exit semantics preserved |
| 10 | Strategies / strategy tags | **KEEP (strategyTag journal field, delivered inc 3/4)** — NO standalone Strategy entity in either lineage (verified inc 5); per-strategy stats live in the Dashboard capability; PHP tags/trade_tags tables are schema-only (roadmap v0.5) | trades module (strategyTag string; `/dashboard/strategies` projection) | delivered as trades journal metadata (inc 3/4) | C-inc5 VERIFIED — see `PHASE-C-INC5-STRATEGIES-INVENTORY.md` | no CRUD/entity manufactured; Dashboard stats deferred to the Dashboard increment |
| 11 | PnL calculation | **KEEP (Local engine) + PORT (vectors)** | `trades/pnlCalculator.ts`, vectors A–E green | `packages/domain/pnl.ts`, vectors V1–V7 green | C-later | Merge Remote golden vectors into Local suite (gate decision) |
| 12 | R-multiple | **PORT** | pnlCalculator (R computation) | Partial in domain PnL | C-later | With PnL vector merge |
| 13 | Dashboard metrics | **PORT** | `src/modules/dashboard/*` | No Local equivalent | C-later | Aggregates follow trades port |
| 14 | Entitlements / plans / quotas | **PORT — DONE (inc 6)** | `entitlements/entitlement.service.ts` (free\|pro\|enterprise, quotas; fail-closed 503; memory-path userLocks) | `apps/api/src/entitlements/entitlementService.ts` + accountService quota + per-user mutex + 429 messageKey | C-inc6 | Remote unit+integration matrix ported (SAFE-FAIL CLOSED unknown plans, Blocker A fail-closed, Blocker B concurrency, provider-bypass); PHP flat MetaApi quota NOT ported (documented divergence, Phase H); DB transaction+row lock = Phase D |
| 15 | MetaAPI synchronization (auto+manual) | **NOT IMPLEMENTED** | schema tables only (`uq_sync_*`, `uq_metaapi_*`) | ADR-008 contracts | Phase H | No implementation exists to port |
| 16 | Screenshot / OCR import | **NOT IMPLEMENTED** | schema tables only | — | Phase J |同上 (same: nothing implemented) |
| 17 | Email / notifications | **NOT IMPLEMENTED (Remote)** | schema + contract docs only | C-09 contract + link builders | Phase I | Resend templates from PHP reference |
| 18 | AI / Gemini integration | **NOT IMPLEMENTED** | `modules/ai/index.ts` stub | — | Phase J | Remote stub (3 lines) — nothing to port |
| 19 | Admin capabilities | **NOT IMPLEMENTED** | `modules/admin/index.ts` stub | — | Phase K | Remote stub — port from PHP reference |
| 20 | Configuration / settings | **KEEP+HARDEN (boot) + PORT (app-level)** | `config/env.ts` (fail-open — NOT ported) | Phase B fail-closed boot | C-later | App-level user settings port with capability #2 |
| 21 | Localization / i18n | **KEEP (kernel) + PORT (catalogs)** | starter catalogs (superseded) | URL kernel + validators | Phase L | PHP production catalogs are the source |
| 22 | API contracts (envelope/health/errors) | **PORT (PHP)** | errorHandler (close but ms `Z`) | 2-field envelope; health non-conformant | **C (this increment)** | 4-field PHP envelope `{status,data,error,timestamp}` (C-10); `/health` per OD-3; error-object exact fields fixture-pending |
| 23 | Background jobs | **KEEP (Local) + PORT (semantics)** | none (BullMQ planned only — rejected, OD-7) | QueuePort + runner (tested) | Phase F | pg-boss per ADR-007/OD-7 |
| 24 | Webhooks | **NOT IMPLEMENTED** | schema uniques only (`uq_webhook_event_key`) | ADR-008 contracts | Phase H | Unique-key design preserved for schema conversion |
| 25 | Idempotency | **KEEP (Local) + PORT (Remote uniques)** | 20 uniques incl. idempotency keys | domain idempotency (tested) | Phase D | Remote unique layer enters at schema conversion |
| 26 | Concurrency / locking | **REDESIGN** | untested (no `$transaction`) | deterministic queue tests | Phase E | DB-level `FOR UPDATE`/SERIALIZABLE per gate §4 |
| 27 | Audit / history | **REDESIGN** | none | ADR-002 direction | Phase E | Ledger events + tombstones |

**Per-capability nine-field records** (remote evidence / local equivalent / status /
security / architecture / external behavior / tests / recommendation / phase) are
embodied in the table columns above plus the audit and gate reports referenced here;
each ported increment records its own evidence block in the commit and Phase C report.

## B. External Contract Inventory (C2)

| Contract | Status | Evidence / note |
|---|---|---|
| Response envelope 4-field `{status, data, error, timestamp}` | **PRESERVE — porting now** | PHP `Response.php:36-46` (VERIFIED); Remote close but ms `Z` (fixture-pending detail) |
| `/health` → 200 `data:{status:'ok', time:<gmdate('c')>}` | **PRESERVE — porting now** | PHP `api/index.php:43-45` (VERIFIED); OD-3 approved as reference; Local `checks.database` shape withdrawn; DB readiness moves to `/ready` (S8 liveness/readiness split) |
| Envelope timestamp format seconds `+00:00` | **PRESERVE** | PHP `gmdate('c')`; OD-5 |
| Auth routes `/api/v1/auth/*` | **PRESERVE — core set porting now** | Remote routes + PHP controller (VERIFIED); email-dependent routes deferred (Phase I) |
| Login/refresh → `{tokens:{accessToken, expiresIn, tokenType, user}}` + `refresh_token` cookie (Path=/, HttpOnly, Secure, SameSite=Lax, Max-Age=2592000) | **PRESERVE — porting now** | Remote `auth.routes.ts` + PHP `AuthController::respondWithTokens` (VERIFIED; PHP cookie TTL `jwt_refresh_ttl_sec` 2,592,000) |
| Auth error codes (INVALID_CREDENTIALS, EMAIL_ALREADY_REGISTERED, EMAIL_NOT_VERIFIED, INVALID_TOKEN, SESSION_EXPIRED, ACCOUNT_INACTIVE, VERIFICATION_LIMIT, VERIFICATION_RETRY_DELAY, REFRESH_COOKIE_MISSING, VALIDATION_FAILED) + statuses | **PRESERVE — porting now** | Remote `auth.service.ts`/`auth.routes.ts` (VERIFIED); PHP parity fixture-pending |
| Register → 201 `{verificationRequired, email}` (+`messageKey:'auth.verificationResent'` re-send case) | **PRESERVE — porting now** | Remote register (VERIFIED); PHP `$result` payload fixture-pending |
| verify-email → `{verified, alreadyVerified, messageKey, params}` | **PRESERVE — porting now** | Remote (VERIFIED); expired/unknown-token error code fixture-pending (INVALID_TOKEN chosen, documented) |
| Access token: HS256 JWT `{sub, role}`, TTL 900s | **PRESERVE — porting now** | Remote `jwt.ts` (ttl default 900 — VERIFIED); Local hardened signer (no fallback secret, CSPRNG jti — behavior-compatible, mechanism hardened) |
| Logout → `{loggedOut:true}` + cleared cookie; forged Origin → 403 ORIGIN_REJECTED | **PRESERVE (already Local)** | PHP live-proven (audit); Local kernel test green |
| Rate limits (register/login/…) | **PRESERVE — DEFERRED** | **DISCREPANCY:** Local C-14 defaults (e.g. register 5/3600) vs Remote route values (register 10/3600) — PHP fixture evidence required before freezing; no limiter exists in Local yet (no regression) |
| Error object exact fields (`messageKey`/`details`) | **NEEDS FIXTURE EVIDENCE** | Gate §7; not frozen until PHP fixtures captured |
| Trades/accounts/dashboard route contracts | **NOT YET IMPLEMENTED** | Remote route inventories captured (C-later) |
| Locale URLs `/`, `/en/`, `/fa/checkout`, `/en/checkout` (D-14) | **PRESERVE (already Local)** | Kernel green |
| Email link shapes C-06/C-07, From identity C-09 | **PRESERVE (contract docs)** | Phase I |

**Breaking-change log:** none introduced. The `/health` shape change is conformance
to the owner-approved PHP reference (OD-3), replacing a Local-side expectation that
was already classified as incorrect (gate §7; parity spec correction planned). The
Local `data.checks.database` field moves to `/ready` (readiness), matching the
Phase B S8 liveness/readiness split.
