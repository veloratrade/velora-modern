-- 0024_auth_events.sql — SEC-02/SEC-03: the authentication-attempt history.
--
-- WHY A TABLE OF ITS OWN (and why this is NOT a second audit trail):
--   0009 created `audit_log` and justified it as distinct from `trade_events`:
--   "which privileged action did which AUTHENTICATED ACTOR perform against
--   which account". This table answers a different question — "which
--   authentication ATTEMPT happened, from where, and with what outcome" — and
--   the two questions have incompatible principal semantics:
--
--     * audit_log.actor_user_id is NOT NULL and is ALWAYS a server-derived
--       authenticated identity. That is the contract that makes it trustworthy.
--     * The single most valuable auth event has NO actor: a failed login for an
--       address that matches no account. Recording it in audit_log would require
--       relaxing a NOT NULL contract whose whole purpose is actor integrity, and
--       would force every existing reader to handle actor-less rows.
--
--   So the two tables coexist with a hard rule: an event belongs to EXACTLY ONE
--   of them. audit_log keeps privileged ACTIONS by authenticated actors;
--   auth_events keeps AUTHENTICATION ATTEMPTS by principals that may not exist.
--   This is the capability of Legacy `api/src/Auth/AuthEventRepository.php` +
--   `api/database/schema.sql` (`auth_events`, v1.7), migrated — not a new model.
--
-- WHAT LEGACY RECORDED (source-read, capability reference; no code copied):
--   * events:  'signup' (success) at registration, 'login' success, and
--              'login' failure with `reason` = the error code the caller got.
--   * user_id: NULLABLE — NULL means "unknown account at attempt time". The
--              ATTEMPTED ADDRESS IS DELIBERATELY NOT STORED anywhere in either
--              revision, which is what preserves anti-enumeration: the table can
--              answer "how many failures came from this IP" without becoming a
--              list of addresses somebody tried.
--   * fields:  result ∈ {success, failure}, reason (a CODE, never user text),
--              ip_address, user_agent, created_at.
--   * write policy: the recorder SWALLOWS its own failures ("History must never
--              break authentication") — preserved in the port and asserted.
--
-- RETENTION: Legacy declared none, so none is invented here. The table is
-- append-only by privilege (see db/roles.sql), so nothing in the application can
-- erase history; a future retention policy is an owner decision, not a default.
--
-- SENSITIVE MATERIAL: rows never carry a password, password hash, session token,
-- refresh token, reset/verification token or request body. `reason` is a
-- constrained CODE vocabulary. ip_address/user_agent are bounded because they are
-- attacker-controlled text (45 = the IPv6 literal bound Legacy used, 250 = its
-- user-agent bound), applied by the adapter before the INSERT.
--
-- SCOPE / SAFETY: forward-only (ADR-010), additive, idempotent (IF NOT EXISTS).
-- Creates ONE new table. No existing table, column, constraint, default or row is
-- modified. No production database exists or is touched by this file.

CREATE TABLE IF NOT EXISTS auth_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- When the attempt happened (ADR-004: every timestamp is timestamptz).
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- WHO was being authenticated. NULL is meaningful and load-bearing: it is the
  -- "no such account" case, and it is why this table cannot live in audit_log.
  user_id      BIGINT REFERENCES users(id) ON DELETE CASCADE,
  -- What kind of attempt. CHECK-constrained so a future caller cannot invent an
  -- event name without a deliberate migration.
  event_type   TEXT NOT NULL CHECK (event_type IN ('signup', 'login')),
  result       TEXT NOT NULL CHECK (result IN ('success', 'failure')),
  -- Machine-readable failure cause, never user-supplied text. Mirrors the codes
  -- the API returns to the caller (INVALID_CREDENTIALS, ACCOUNT_INACTIVE,
  -- EMAIL_NOT_VERIFIED) so a reviewer can reason about the attempt without
  -- guesswork. NULL on success.
  reason       TEXT CHECK (reason IS NULL OR length(reason) <= 64),
  ip_address   TEXT CHECK (ip_address IS NULL OR length(ip_address) <= 45),
  user_agent   TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 250),
  -- Invariant: a success is never carrying a failure cause.
  CONSTRAINT auth_events_reason_only_on_failure CHECK (result = 'failure' OR reason IS NULL)
);

-- The two read shapes the surface actually needs, both deterministic:
--   * per-user history, newest first (the admin "login history" view);
--   * failure scanning by time (the opposite direction, for abuse review).
CREATE INDEX IF NOT EXISTS auth_events_user_time_idx ON auth_events (user_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS auth_events_result_time_idx ON auth_events (result, occurred_at DESC, id DESC)
  WHERE result = 'failure';
