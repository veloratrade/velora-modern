-- 0008_installation_ownership.sql — System Owner: installation-level ownership.
--
-- WHY A SEPARATE TABLE AND NOT role = 'system_owner':
--   System Owner is installation ownership/governance state, NOT an ordinary
--   RBAC role. Representing it as a fourth value of users.role would:
--     (a) make ownership reachable through the normal role-assignment path
--         (PATCH /admin/users/:id/role), which the product decision forbids —
--         ownership must NOT be an ordinary promotion target;
--     (b) require weakening the 0006 users_role_check constraint;
--     (c) conflate "which authority does this account exercise at runtime"
--         with "who owns this installation", which are different questions.
--   A singleton table keeps the RBAC model in 0006 completely untouched, and
--   makes "claimed exactly once" a DATABASE invariant rather than an
--   application convention.
--
-- SINGLETON ENFORCEMENT:
--   `id` is fixed to TRUE by a CHECK and is the PRIMARY KEY, so at most one row
--   can ever exist. A second claim therefore fails with a unique-violation at
--   the database level, independently of any application check. Two concurrent
--   claims cannot both succeed even under a race: one INSERT wins, the other
--   raises SQLSTATE 23505. This is the concurrency guarantee, and it does not
--   depend on a transaction wrapper in the user store (there is none).
--
-- OWNER ACCOUNT LIFETIME:
--   owner_user_id REFERENCES users(id) ON DELETE RESTRICT — the owner's user
--   row cannot be deleted while it is referenced. Note this is a guarantee
--   about ROW DELETION only; it says nothing about suspension or role change,
--   which remain ordinary account-state operations (documented, deliberately
--   not decided here).
--
-- DELIBERATELY ABSENT (out of scope by product decision — not oversights):
--   ownership transfer, ownership deletion, successor selection, multiple
--   owners, recovery/emergency owner. There is no UPDATE or DELETE path for
--   this table in application code.
--
-- SCOPE / SAFETY:
--   - Forward-only (ADR-010), additive, idempotent (IF NOT EXISTS).
--   - Creates ONE new table. No existing table, column, constraint, default or
--     row is modified, read or re-interpreted. The 0006 role CHECK and the 0007
--     status CHECK are untouched.
--   - APPLICATION-level ownership only. Unrelated to the ADR-010 PostgreSQL
--     identities in db/roles.sql; a System Owner gains NO database privilege.
--   - No production database exists or is touched by this file.

CREATE TABLE IF NOT EXISTS installation_ownership (
  -- Singleton key: CHECK pins it to TRUE, PRIMARY KEY makes it unique, so the
  -- table can hold at most one row for the lifetime of the installation.
  id              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  owner_user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Who performed the claim and when. The claimant is always the owner in this
  -- design (self-claim during bootstrap); both are recorded so the bootstrap
  -- event remains attributable if that ever changes.
  claimed_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Sanitized provenance for the bootstrap action. NEVER holds a password,
  -- token, secret or credential of any kind.
  claimed_ip      TEXT,
  claimed_user_agent TEXT
);
