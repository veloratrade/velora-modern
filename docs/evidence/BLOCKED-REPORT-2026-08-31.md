# Hosting Validation — BLOCKED REPORT (attempt 2026-08-31)

**Result: VALIDATION NOT PERFORMED — 0/20 rows testable. No row was marked PASS.
Nothing was simulated.**

## 1. Candidate host/network position actually used

**NONE.** No candidate production host has been identified anywhere in the
governance corpus (verified by search 2026-08-31: only generic rule text, no
named provider/host/access). No host access, credentials, or network position
was provided to this session.

Session environment at attempt time: ephemeral agent sandbox (`e2b.local`,
Docker/psql/compose absent) — a CI-runner/workstation-class environment that
`docs/hosting-validation.md` explicitly disqualifies as a substitute. Its
tooling absence is recorded as context only, **not as evidence**.

## 2. Why every row is BLOCKED

Each checklist row requires execution from the candidate production host/network
position. That position does not exist yet. Per the governing rules ("If a
validation step requires infrastructure modification, STOP that row and report
it as BLOCKED"; "do not infer PASS from configuration"), all 20 rows are
**BLOCKED — capability cannot be tested** (distinct from FAIL, which would mean
the host demonstrably lacks the requirement).

## 3. Missing inputs (exact)

| # | Missing input | Owner action needed |
|---|---|---|
| A | Candidate production host **identified** (provider, region, plan/type) — nothing can run until this exists | Owner decision: name the candidate host/environment |
| B | **Access path** to that host (SSH/deploy credential or equivalent execution channel) for the validation window only | Owner provides access mechanism (never credentials in chat) |
| C | Permission to run **isolated temporary** containers + a disposable PostgreSQL instance on that host (permitted by the 2026-08-31 authorization, but only on the candidate host) | Confirmed once A+B exist |
| D | **Registry choice** (Docker Hub vs GHCR vs mirror) — rows 11–12 depend on it | Owner decision (ADR-010 open question 2) |
| E | Test-scope secrets for provider rows (14/15/16): MetaApi read-only, Gemini test key, Resend test key — executed on the host by the owner or injected as env at runtime; never placed in chat, logs, or evidence | Owner runs or provisions test-scope credentials |
| F | **Monitoring target** (row 10): a metrics/log sink to ship to | Owner decision |
| G | TLS/reverse-proxy rows (6/17): a candidate environment that **already** has TLS/DNS to verify read-only — the rules forbid altering DNS/certs during validation; if none exists yet, these rows stay BLOCKED by rule | Depends on A; may legitimately remain BLOCKED at Gate-3-first-pass |

## 4. Ready-to-run evidence plan (per row, once A–F exist)

| Row | Command/procedure (run ON the candidate host, timestamped, sanitized) |
|---|---|
| 1 | `node -v` (target LTS) |
| 2 | `docker version` + `docker info` (server version, storage driver, rootless?) |
| 3 | `docker compose version` + up/down of a minimal isolated stack |
| 4 | Disposable PG 16 container: `SELECT version()`; create validation DB; load schema-shaped test data |
| 5 | Isolated pg-boss smoke: enqueue → process one job → verify completion record (throwaway script, deleted after; not application code) |
| 6 | Volume + container restart → data survives (`docker volume inspect` + app read-back) |
| 7 | `pg_dump` of validation DB → copy to offsite destination → listing at destination |
| 8 | **Restore drill**: load dump into a fresh PG container → row counts → app-level connectivity (psql select + minimal health request) |
| 9 | Object storage round-trip via S3-compatible client (put/get/delete + checksum match) |
| 10 | Ship metrics + a log line to the monitoring sink; verify queryable |
| 11 | Digest-pinned pull of the chosen base image; record durations |
| 12 | **Repeated pulls over time** (≥10 across ≥1 hour, ideally across a day) to observe rate-limit/throttle behavior; record anonymized outcomes |
| 13 | `docker pull` of an OCR-sized image (tesseract-bearing class, GB-scale) with timing |
| 14 | `curl -sS -o /dev/null -w '%{http_code}'` to ≥3 independent HTTPS endpoints |
| 15 | MetaApi authenticated read-only call (test-scope key, env-injected, redacted output) |
| 16 | Gemini minimal call within test budget (redacted) |
| 17 | Resend test send to designated test inbox (redacted) |
| 18 | Read-only DNS verification (`dig` current records + control-plane access demonstration; **no changes**) |
| 19 | `df -h`, `nproc`, `free -h`, sustained-transfer sanity vs egress quota |
| 20 | Egress quota vs measured transfer (rows 11/13 measurements reused) |

Evidence to be stored as `docs/evidence/E-<row>-<slug>.md` (one per row),
each with: UTC timestamp, host identity, exact commands, sanitized output,
PASS/FAIL verdict. (Note: checklist row numbering vs this table — rows 6/17 and
13/18 pairing reflect the checklist's own order; artifacts will carry the
original row IDs.)

## 5. Explicitly not done

No production database touched · no DNS/TLS changes · no firewall changes ·
no infrastructure provisioned · no n8n/MetaApi/Gemini/Resend configuration
changed · no Velora deployment · no Phase 1 work · no push · no secrets
handled. Registry reachability, throttling, OCR-sized pull, and the PostgreSQL
restore drill were **NOT TESTED** — they require the candidate host.
