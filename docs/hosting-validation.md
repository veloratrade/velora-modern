# VELORA-MODERN — Hosting Validation Checklist (Phase 0 — NOT a deployment)

**Authorization: GRANTED** — owner decision D-09 (2026-08-29). Evidence gathering
only. **No infrastructure provisioning or modification is authorized.** Every
evidence item must be dated, reproducible, obtained from the candidate production
host/network position, and attached to the appropriate evidence record. Hosting
remains BLOCKED until all required evidence exists.

Status: **NOT VALIDATED — no evidence yet.** No hosting claims may be made until
each row has evidence (command output, screenshot, timestamped log). This is the
plan's load-bearing assumption (the PHP system exists because of hosting limits).

| # | Requirement | Validation method (planned) | Evidence | Status |
|---|---|---|---|---|
| 1 | Node.js LTS runtime | run target-version `node -v` on candidate host | — | NOT VALIDATED |
| 2 | Docker Engine | `docker version` + run hello-world equivalent | — | NOT VALIDATED |
| 3 | Docker Compose | `docker compose version` + bring up minimal stack | — | NOT VALIDATED |
| 4 | PostgreSQL (container or managed) | run 16.x, create/restore test DB | — | NOT VALIDATED |
| 5 | pg-boss functioning | enqueue/process one job against test PG | — | NOT VALIDATED |
| 6 | Reverse proxy + TLS | terminate HTTPS with real cert (Let's Encrypt class) | — | NOT VALIDATED |
| 7 | Backups work | pg_dump + WAL archive to offsite target | — | NOT VALIDATED |
| 8 | Restore works | **restore drill to a running stack** | — | NOT VALIDATED |
| 9 | Object storage (S3-compatible or volume) | put/get/delete object via StoragePort | — | NOT VALIDATED |
| 10 | Monitoring pipeline | metrics + logs shipped and queryable | — | NOT VALIDATED |
| 11 | **Registry access** | pull a digest-pinned image from chosen registry **from the host, repeated over time (throttling risk)** | — | NOT VALIDATED |
| 12 | Image pull reliability | repeated pulls incl. large image (OCR-bearing) | — | NOT VALIDATED |
| 13 | Outbound HTTPS (general) | curl to ≥3 independent endpoints | — | NOT VALIDATED |
| 14 | MetaApi connectivity | authenticated read-only API call | — | NOT VALIDATED |
| 15 | Gemini connectivity | minimal API call within test budget | — | NOT VALIDATED |
| 16 | Resend connectivity | test send within test budget | — | NOT VALIDATED |
| 17 | DNS control | TTL changes, record management on the domain | — | NOT VALIDATED |
| 18 | Disk capacity | sized from migration rehearsal volumes (screenshots!) + growth model | — | NOT VALIDATED |
| 19 | RAM / CPU | load-test headroom at 1k-user gate | — | NOT VALIDATED |
| 20 | Network egress limits | bandwidth/transfer quotas checked | — | NOT VALIDATED |

## Rules

- Evidence is attached to this file (or `docs/evidence/`) as it is gathered —
  dated, reproducible commands only.
- A single successful attempt is not "validated" for registry pulls (throttling
  is time-dependent — PHP-era lesson OC-1/OC-2 generalizes: verify from the real
  network position, repeatedly).
- **Do not claim hosting readiness without evidence.** Absence of evidence = BLOCKED.
- Region-specific reachability (registry, providers) must be tested **from the
  production host's network position**, not from a developer machine.
