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
