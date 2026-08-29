# ADR-003 — Identity Canonicalization (Email)

## Status

Accepted — owner decision D-02 (2026-08-29): **policy (a)** — lowercase canonicalization at every write path; plain UNIQUE on canonical email; mandatory duplicate scan before migration; existing case-colliding identities must be resolved before import. PHP database untouched.

## Context

MySQL and PostgreSQL disagree on string comparison case-sensitivity. If
unhandled, every existing user whose email was stored or entered with any
uppercase character loses the ability to log in / re-register after migration —
silently.

## Verified Evidence

- Schema DDL (VERIFIED): `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  — **case-insensitive collation**. Therefore current lookups (`WHERE email = ?`)
  match case-insensitively at the DB layer, regardless of application code.
- Auth code (VERIFIED files inspected): `AuthService`/`UserRepository` perform
  straight equality lookups; no explicit `LOWER()` normalization was observed
  (reliance on collation — ASSUMPTION pending full read of every lookup path).
- PostgreSQL (platform fact): text comparison is case-sensitive by default;
  a naive migration changes login/registration semantics.

## Decision

1. **Canonical form:** email = `trim()` + `toLowerCase()` (Unicode-aware, NFC) at
   **every write path** (register, change, admin edit, migration import).
2. **Storage:** canonical lowercase `text`/`varchar` column.
3. **Uniqueness:** plain `UNIQUE` index on the canonical column
   (safe because all writes are normalized).
   - Alternative rejected: `CITEXT` (extension dependency, hides normalization
     from application layer, complicates cross-DB tests).
   - Alternative viable but rejected as primary: unique index on `lower(email)`
     expression (keeps two representations possible; normalization-at-write is stricter).
4. **Login/registration lookup:** always against the canonical form
   (normalize input the same way before querying).
5. **Pre-migration duplicate detection (mandatory, on MySQL before transform):**
   `SELECT LOWER(TRIM(email)), COUNT(*) FROM users GROUP BY 1 HAVING COUNT(*) > 1`
   — run against staging first, then production copy during rehearsal.
   Any hit = `OWNER DECISION REQUIRED` (merge/rename) before import.
6. **Login regression test** in migration validation: mixed-case credential
   smoke test must pass post-load.

## Alternatives Considered

- CITEXT everywhere: see above.
- Case-sensitive accounts (change of product behavior): rejected — breaks existing users.

## Consequences

### Positive
- No silent login breakage at migration; deterministic identity.
- Simpler unique constraints; no expression-index overhead.

### Negative
- Normalization must be enforced in one shared helper (drift risk if bypassed);
  display-cased emails (if any user expects `John@X.com` display) are lost — display
  uses the stored canonical form (product-level acceptable; flagged).

## Security Impact

Prevents duplicate-account creation via case variants (a known account-abuse
vector). Enumeration resistance is unchanged (uniform API responses, security-policy).

## Migration Impact

Transform step: `email := lower(trim(email))` inside the pipeline; duplicate check
before load; unique-violation during load = hard fail (never silently merge).

## Testing / Verification Requirements

- Unit: canonicalizer (Unicode edge cases, IDN, trailing spaces).
- Migration validation: zero duplicate canonical emails pre-load; unique constraint
  holds post-load; mixed-case login smoke passes.

## Open Questions

1. Full audit of every PHP email lookup path for hidden `LOWER()`/collation reliance — NEEDS VERIFICATION (Phase 1).
2. Whether any existing production emails are stored with uppercase (count query during rehearsal; affects comms, not correctness).

## Phase

Phase 0 decision; helper + schema in Phase 1; duplicate scan in migration rehearsal (Phase 3/4).
