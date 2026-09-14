# VELORA-MODERN — Security Policy (Phase 0)

Mandatory baseline. Violations are release blockers, not style issues.

## Baseline controls

| # | Control | Requirement | Verified PHP-era precedent |
|---|---|---|---|
| 1 | Secrets in Git | Never. Names only. Secret-scanner in CI. | NP-2 (verified policy) |
| 2 | Environment separation | Staging/production: separate credentials, secrets, hosts | counter-example: shared FTP account (OC-10/11) — retired by design |
| 3 | Least privilege | Service accounts scoped per function | — |
| 4 | DB role separation | app / worker / migrator / readonly roles | — |
| 5 | Parameterized SQL only | No string-built queries; CI grep guard | PDO prepared statements (verified) |
| 6 | Dependency pinning | Lockfiles, exact versions, renovate/dependabot | — |
| 7 | Vulnerability scanning | `npm audit`/OSV + image scan in CI, gate on high/critical | — |
| 8 | Secret scanning | gitleaks-class scanner on every PR | — |
| 9 | Containers | non-root, read-only FS where practical, no extra capabilities | — |
| 10 | Base images | digest-pinned, minimal | — |
| 11 | Backups | encrypted, offsite, access-controlled | backup artifacts (verified pipeline) |
| 12 | Restore | **tested** on schedule; drill is a release gate | RB-6 gap in PHP (documented) — closed here |
| 13 | Webhook verification | signed (constant-time HMAC) + timestamp window + dedupe | MetaApi HMAC (verified) |
| 14 | Audit logs | append-only; auth, trade mutations, admin, AI consent/quota events | append-only philosophy (verified) |
| 15 | Upload validation | type sniffing, size caps, image re-encode, private storage | upload handling exists (detail unverified) |
| 16 | Object storage | private buckets only; short-TTL signed URLs | — |
| 17 | CSP | strict, nonce-based, guard test in CI | CSP guard workflow (verified) |
| 18 | Rate limiting | shared-store interface; verified PHP limits as defaults | per-route limits (verified) |
| 19 | Request IDs | propagated web→api→worker→provider | — |
| 20 | Log redaction | redaction middleware; never log the forbidden set | sanitized-output discipline (verified) |
| 21 | Auth | ADR-005 (bcrypt→argon2id, rotation+reuse detection, pinned alg) | verified behaviors |
| 22 | Financial math | ADR-001 decimal-only; CI bans float ops on money | bcmath precedent (verified) |

## Forbidden in logs (ever)

Passwords, JWTs, refresh tokens, API keys, provider credentials, raw PII beyond
operational need, full env contents.

## Gates before first production deployment

1. Threat model reviewed & updated (docs/threat-model.md).
2. Secret-scanner + dependency audit + image scan green in CI.
3. CSP guard test green (nonce pipeline verified).
4. Webhook signature tests green (forgery/replay vectors).
5. Restore drill passed from backup to running stack.
6. Rate limiter verified per-route against the defaults table.
7. Auth journeys green in parity suite (both stacks).
8. Upload hardening tests green (malicious-file corpus).
9. RBAC matrix test green (user/admin, ownership, IDOR probes).
10. Migration validation suite green on latest rehearsal.
11. Owner security sign-off (explicit, per-change thereafter).

## Incident rules

- Suspected secret leak → immediate rotation path documented per secret class.
- Security events (token reuse, webhook reject storms, authz denials) alert to the owner channel.
- Post-incident: threat-model row added/updated in the same session (PHP BR culture, ported).

---

## Administrative role hierarchy and System Ownership

Conceptual model:

```
    SYSTEM OWNER
          ↓
    SUPER ADMIN ↔ SUPER ADMIN ↔ SUPER ADMIN   (peers, no hierarchy between them)
          ↓
        ADMIN
          ↓
        USER
```

### Product principles (binding)

1. **System Owner is the highest ownership/governance authority** of a Velora
   installation.
2. **System Ownership is established exactly once, during initial bootstrap**,
   by an explicit claim. It is installation-level state, not an RBAC role.
3. **The first registered user is NOT automatically System Owner.** Ownership
   never derives from registration, account creation order, the first database
   row, first login, email address, plan, or any client-supplied field.
4. **Ownership cannot be claimed through normal RBAC after bootstrap.** There is
   deliberately no `system_owner.assign` / `system_owner.promote` permission, and
   `system_owner` is not a valid `users.role` value. Admin → Owner, Super Admin →
   Owner and User → Owner are all rejected once ownership exists.
5. **Super Admins are peers.** There is no hierarchy between Super Admin
   accounts.
6. **A Super Admin cannot demote or suspend another Super Admin**, nor otherwise
   revoke a peer's administrative authority, through normal user management.
7. **The installation must always retain at least one ACTIVE Super Admin**
   (`role = 'super_admin' AND status = 'active'`). Counting by role alone is
   insufficient: a suspended super admin cannot authenticate.

### Implementation

| Concern | Mechanism |
|---|---|
| Ownership state | `installation_ownership` (migration `0008`), single row pinned by `id BOOLEAN PRIMARY KEY CHECK (id = TRUE)` |
| One-time guarantee | Database singleton — a concurrent second claim fails with a unique violation, mapped to `409 OWNERSHIP_ALREADY_CLAIMED` |
| Owner row protection | `owner_user_id REFERENCES users(id) ON DELETE RESTRICT` (protects row **deletion** only) |
| Bootstrap claim | `POST /api/v1/admin/ownership/claim` — role/status/verification re-read from storage, explicit confirmation phrase, password re-authentication via the existing hasher |
| Ownership status | `GET /api/v1/admin/ownership/status` |
| Peer protection | `SUPER_ADMIN_PEER_PROTECTED` (403) in `AdminUserService.setRole` / `setStatus` |
| Last active super admin | `LAST_SUPER_ADMIN` (409) via `countActiveUsersByRole` |

### Deliberately out of scope

Ownership transfer, ownership deletion, successor selection, "next Super Admin
becomes Owner", multiple System Owners, primary/secondary Super Admin ranking,
owner voting, two-person transfer, hidden emergency owner, database backdoor and
automatic recovery owner are **not implemented**. Consequently **no ownership
recovery path exists**; see the open product decisions recorded in the phase
report.

### Ownership state vs runtime authority

System Ownership is currently **recorded state, not a runtime permission**. The
owner's day-to-day authority is still whatever their RBAC role grants. Whether
System Owner should outrank Super Admin at runtime — and whether the owner's
account should be protected from suspension or demotion — are **product
decisions that remain open** and were not assumed by this implementation.
