# VELORA-MODERN — Threat Model (Phase 0)

Scope: the modern system as designed in ADR-001…010. Existing controls cited
are the VERIFIED PHP-era controls (they inform parity, not adequacy).
Labels: `ASSUMPTION-TM` = threat-model assumption, not an observed vulnerability.

| # | Asset | Threat | Attack path | Impact | Likelihood | Existing control (verified) | Required control (modern) | Detection | Residual risk |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Credentials | Brute force / stuffing on login | password spray | account takeover | High | per-route throttles (8/300s), bcrypt cost 12 | throttle + lockout + stuffing patterns (impossible-travel/IP diversity) | throttle counters, failed-login anomalies | Medium (credential reuse) |
| 2 | JWT | Forgery | alg confusion, weak key | full account access | Medium | HS256 + hash_equals, exp check | pinned alg, per-env strong secret, short TTL | auth-failure alerts | Low |
| 3 | Refresh tokens | Theft + replay | XSS/DB leak → replay | persistent takeover | Medium | SHA-256 at rest, 30d TTL | rotation + reuse detection (family revoke) (ADR-005) | reuse events = security alarm | Low |
| 4 | Sessions | Theft / fixation | token sniff, missing invalidation | takeover | Medium | DB-backed sessions, origin guard | same + device registry + cutover invalidation | concurrent-session anomalies | Low |
| 5 | Password migration | Hash mishandling | bulk rewrite/float/case bug | mass login loss | Low | n/a | import as-is + `$2y$` proof gate + login smoke | rehearsal validation | Low |
| 6 | Accounts | Enumeration via register/reset | response/time oracle | privacy, targeting | Medium | uniform flows (ASSUMPTION-TM) | uniform responses + equal-time paths + captcha-ready hook | probe-rate alert | Medium |
| 7 | Rate limits | Bypass | IP rotation; multi-node counting drift | abuse of AI/auth | Medium | DB-bucket limiter (single node) | shared-store limiter behind interface (ADR-007) | limiter-denied metric per route | Medium |
| 8 | MetaApi webhook | Forgery | missing/weak HMAC | fake trades, poisoned data | Medium | HMAC in service (verified) | ADR-008 pipeline + constant-time + window | reject counter spike | Low |
| 9 | Webhooks | Replay | resend captured payload | duplicate projections | Medium | idempotent sync worker | event-id dedupe + timestamp window + raw archive | dedupe counter | Low |
| 10 | MetaApi credentials | Leakage | logs, repo, client exposure | account/trading compromise | Low | env-only policy (verified) | env-only + audit + no-log redaction | secret-scanner, log audit | Low |
| 11 | AI provider keys | Leakage/cost abuse | key in logs/repo; quota drain | financial + outage | Medium | quotas table + key-check workflow (verified) | key env-only + per-user/global budgets + alerts (429 lesson) | quota-burn metric, spend alerts | Medium |
| 12 | n8n credentials | Leakage via workflows | token in workflow JSON | automation takeover | Medium | "secrets never in workflows" policy (verified) | scoped per-workflow creds, signed callbacks, manual activation | n8n audit review | Medium |
| 13 | Screenshot uploads | Malicious files | polyglot/SVG-with-script/bomb | XSS, DoS, storage abuse | High | upload size/type handling (ASSUMPTION-TM detail) | sniff type, re-encode images, size caps, private bucket | upload-fail metric, AV-scan hook | Medium |
| 14 | Screenshots | Unauthorized access | guessed/leaked URLs | PII leak (trading data) | Medium | private storage assumption (ASSUMPTION-TM) | private object storage + short-TTL signed URLs + auth checks | signed-URL issuance anomalies | Low |
| 15 | Object storage | Public exposure | misconfig bucket | mass PII leak | Medium | n/a (new surface) | private-by-default config check in CI | config drift alert | Low |
| 16 | DB | SQL injection | string-built queries | total compromise | Medium | PDO prepared statements (verified pattern) | parameterized-only + CI grep guard + ORM defaults | WAF/anomaly alerts | Low |
| 17 | API | SSRF | webhook/AI relay fetching attacker URLs | internal network probe | Low | n/a (ASSUMPTION-TM) | egress allowlist, URL validation, no redirects to private ranges | egress deny logs | Low |
| 18 | Browser | XSS via journal content | user notes/strategy fields rendered unsafely | session theft | High | CSP guard (verified) | strict CSP + nonce, output encoding, sanitization of user HTML | CSP report endpoint | Medium |
| 19 | Browser | CSP bypass | unsafe-inline creep | XSS easier | Medium | CSP guard workflow (verified) | CSP guard in modern CI, no-inline budget | CSP violation reports | Low |
| 20 | Auth'd browser | CSRF | cross-site state change | unwanted actions | Medium | same-origin guard on logout (verified live) | origin/CSRF checks on all state-changing routes + cookie SameSite | origin-reject counter | Low |
| 21 | Admin/RBAC | Privilege escalation | role check gaps, IDOR on admin/user objects | data breach | Medium | admin role route (verified minimal) | centralized guards + ownership checks + deny-by-default | authz-denied metric | Low |
| 22 | Audit logs | Tampering | admin/db write | hides abuse | Medium | append-only philosophy (policy) | append-only storage, restricted role | integrity checks | Low |
| 23 | Backups | Theft | unencrypted offsite copy | total data leak | Medium | encrypted backups policy (docs) | encrypted + access-controlled + restore-tested | backup access audit | Low |
| 24 | DB at rest | Compromise | host/volume access | full PII/finance leak | Low | n/a | volume encryption, key management | host IDS/file audit | Medium |
| 25 | Supply chain | Dependency compromise | malicious npm package, typosquat | code exec, theft | Medium | n/a (new stack) | lockfiles, pinning, provenance, audit CI, minimal deps | scanner alerts (CVE/provenance) | Medium |
| 26 | Containers | Escape / root compromise | privileged container, dirty host | host takeover | Low | n/a | non-root, read-only FS, no capabilities, digest-pinned bases | container runtime alerts | Low |
| 27 | Secrets | Leakage via logs/errors | verbose error, stacktrace with env | credential exposure | Medium | sanitized-output discipline (verified) | redaction middleware + secret-scanner CI + error normalization | scanner + log audit | Low |
| 28 | Third parties | MetaApi/Gemini/Resend/n8n outage | provider down/throttled | degraded features | High | 429 incident history (verified) | circuit breakers, budgets, queues, graceful degradation | per-provider latency/error metrics | Accepted (degradation) |
| 29 | Self | Retry storms | synchronized retries | self-DDoS | Medium | retry patterns (workers) | jittered backoff (ADR-007/008), shed loads | retry-rate metric | Low |
| 30 | Migration | Partial/corrupt import | mid-cutover failure | inconsistent data | Medium | n/a | rehearsed pipeline, validation gates, rollback window (migration-strategy) | validation failure = abort | Low |

## Assumptions (explicit)

- ASSUMPTION-TM: no third-party consumers of internal API beyond Velora's own UI.
- ASSUMPTION-TM: PHP upload-validation details adequate — modern re-implements from scratch regardless.
- Threat landscape excludes targeted nation-state actors; focus is internet-facing commodity attacks.

## Review cadence

Re-reviewed at: Phase 1 exit, Phase 3 (scale tests), pre-cutover (Phase 4), and on any new external integration.
