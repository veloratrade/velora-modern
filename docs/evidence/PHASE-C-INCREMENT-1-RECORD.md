# Phase C Increment Record — 2026-09-12 (first authorized increment)

**Scope executed:** C1 (capability matrix) + C2 (contract inventory) + first
porting wave. Full matrix: `docs/reconciliation/PHASE-C-CAPABILITY-MATRIX.md`.

## Implemented (this increment)

| Capability | Classification | Evidence |
|---|---|---|
| PHP external envelope (C-10) | PORT — **DONE** | 4-field `{status, data, error, timestamp}`; timestamp PHP format (seconds, `+00:00`, OD-5); `details` on error objects |
| `/health` contract (OD-3) | PORT — **DONE** | PHP reference shape `data:{status:'ok', time}` (VERIFIED `api/index.php:43-45`); DB durability on `/ready` (S8 liveness/readiness split); parity spec corrected |
| Identity: register / verify-email / login / refresh / logout / me | PORT + KEEP+HARDEN — **DONE** | Remote-verified semantics/constants (access TTL 900s; refresh 30d; rotation; failure codes; cookie contract) on the Phase B hardened foundation (no fallback secret, CSPRNG jti/refresh tokens, no memory fallback outside dev); S5 boundary now EXISTS (UserStore) with rehash persisted through it |
| User model fields (0002 migration) | PORT — **DONE** | full_name, timezone, plan, status, ai_consent_at + session metadata (forward-only migration; PGlite-tested) |

## Evidence labels (test honesty)

- Unit (service behavior, real crypto): 12 tests — PASS.
- HTTP contract (kernel, in-process fetch, in-memory store): 8 tests — PASS.
- Persistence integration (PGlite, in-wasm, real migrations 0001+0002, real
  port): 3 tests — PASS. **PGlite ≠ real PostgreSQL ≠ production.**
- Full battery: typecheck 0 errors; 177/177 unit; migrations 5/5; parity 6/6;
  secret scan 0 findings.

## Discovered evidence findings

1. **Remote VERIFICATION_LIMIT quirk:** the 3-per-24h limit is unreachable in
   the reference (verifications are deleted before the count runs → count ≤ 1).
   Ported faithfully; flagged for owner review at Phase I (email waves).
2. **Rate-limit contract discrepancy:** Local C-14 defaults (register 5/3600)
   vs Remote route values (register 10/3600) — PHP fixture evidence required
   before freezing; no rate limiter implemented yet (deferred, no regression).

## Deferred (classified in the matrix; not blockers)

- Phase C remaining: change-password, preferences, email-preferences routes;
  accounts/trades/journal/strategies/dashboard/entitlements ports; PnL golden-
  vector merge (Remote A–E into Local suite).
- Phase I gate: resend-verification, forgot/reset-password (email dispatch).
- Phase D: durable (real-PG) user store; real-PG verification of S5.
- Fixture capture (OD-3) for exact PHP error-object/endpoint payloads.
