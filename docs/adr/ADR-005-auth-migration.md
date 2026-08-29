# ADR-005 — Authentication Migration

## Status

Proposed

## Context

Thousands of existing users must keep working logins after cutover, and verified
PHP security behaviors must not regress.

## Verified Evidence

- `AuthService` (VERIFIED): `password_hash(..., PASSWORD_BCRYPT, ['cost' => Config::get('bcrypt_cost', 12)])`
  → bcrypt **cost 12**, `$2y$` prefix; `password_verify` on login.
- `Core/Jwt.php` (VERIFIED): minimal **HS256** implementation, `hash_equals`
  timing-safe comparison, `iat`/`exp` claims, expired-token rejection.
- Refresh tokens (VERIFIED): dual-token model ("register, login (dual-token JWT), refresh, logout");
  refresh token stored as **SHA-256 hash** in DB; TTL default **2,592,000 s (30 days)**
  (`jwt_refresh_ttl_sec`); `SessionRepository`/`user_sessions` = DB-backed sessions.
- Devices: `user_devices` table + new-device notification (VERIFIED live email).
- Logout same-origin guard (VERIFIED live: forged Origin → 403).
- Email verification: `{frontend_url}/verify-email#token=<rawurlencoded>` (VERIFIED exact format);
  reset: `{frontend_url}/reset-password#token=<...>`; tokens single-use
  (verified consumption bug history fixed); route throttles VERIFIED in baseline §4
  (register 5/3600s, login 8/300s, refresh 30/300s, forgot 4/3600s, reset 6/3600s,
  change-password 8/900s, extract-screenshot 8/user/300s); `rate_limits` table-backed
  limiter (VERIFIED atomic upsert).

## Decision — migration policy

1. Import bcrypt hashes **unchanged** (no bulk rewrite).
2. **Phase 1 gate — bcrypt compatibility proof:** a Node bcrypt library must verify
   `$2y$` vectors (one published/synthetic vector + one generated on staging CLI,
   sanitized) — correct password → true; wrong → false; no exceptions. No auth work
   proceeds without this passing. (Most Node bcrypt libs accept `$2y$`; this is
   prove-it, not assume-it.)
3. Transparent rehash to **Argon2id** on successful login (params per OWASP: m=19456 KiB, t=2, p=1 default, tunable).
4. Argon2id also on password change/reset.
5. Never bulk-rewrite hashes.
6. **Cutover = full session invalidation** (all PHP sessions/refresh tokens void; users re-login).
   Communicated as a planned logout. No cross-system refresh-token portability.
7. **New secrets per environment** (JWT signing keys never reused from PHP); HS256 retained for the single-API topology — reevaluate only if multiple verifiers appear.
8. **JWT algorithm pinned** in verification (reject `alg` conflicts; constant-time MAC compare as today).
9. **Refresh-token rotation with reuse detection**: rotated token invalidates the old;
   reuse of an old refresh token revokes the token family and logs a security event
   (upgrade over PHP — cheap now).
10. Preserve verified behaviors as contract tests: origin-guard 403, single-use
    verification/reset tokens + fragment handling, per-route throttle defaults,
    `GET /health` envelope, session/device bookkeeping.
11. Rate limiting stays behind a shared-store interface (multi-node correctness) — see ADR-007/010.

## Alternatives Considered

- Forcing password resets for all users at cutover: rejected (mass disruption, support load).
- Migrating/validating PHP sessions: rejected (cleanest safe path is re-login).
- RS256 now: deferred (single verifier; adds key-ops complexity without a consumer).

## Consequences

### Positive
- Zero-login-loss migration; stronger hashing over time; detectable token theft.

### Negative
- One-time re-login for all users at cutover; dual hash-verify paths in code until PHP decommission.

## Security Impact

Core control set. Reuse detection converts silent token theft into an alarm.
Throttle limits carry over as *defaults* (tunable, evidence first).

## Migration Impact

`users.password_hash` imported as-is; hash-format column check in validation
(all rows match `^\$2y\$` else flag); login smoke test with real hash vectors in
rehearsal; sessions table intentionally imported empty.

## Testing / Verification Requirements

- Phase 1: bcrypt `$2y$` proof (gate above).
- Phase 2: auth journey parity suite (register→verify→login→forgot→reset→re-login→change-password — mirrors the verified 11-step PHP E2E).
- Rehearsal: migrated-hash login smoke; rotation + reuse-detection tests; throttle tests.

## Open Questions

1. Argon2id parameters final values (owner confirmation of defaults).
2. Device-notification policy in modern (keep parity or refine).

## Phase

Phase 0 decision; compatibility proof = Phase 1 gate; journeys = Phase 2 wave ②.
