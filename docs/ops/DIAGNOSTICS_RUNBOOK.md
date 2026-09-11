# Diagnostics Runbook — Smoke, Logs, and Deferred Suites

## 1. Live smoke (implemented)

| Target | Workflow | Probes | Confirm |
|---|---|---|---|
| staging | `healthcheck-staging.yml` (manual) | read-only + guard probes (default on) | none (staging) |
| production | `healthcheck-production.yml` (manual) | read-only by default; guard probes opt-in | `GUARD-PROBES-PRODUCTION` + `production` env |

Suite checks: `GET /health` (Modern flat contract) → Helmet headers →
404 `NOT_FOUND` envelope → guard probes (`401` auth boundary, `400` validation
boundary; both side-effect-free) → version-drift evidence (warn-only).

## 2. Log tail (implemented for staging)

Dispatch `error-log-staging.yml` with `READ` (+ optional `tail_lines` 10–500).
Output is redacted for bearer/token-like fragments as defense in depth; the
primary control remains the application contract (Pino logs must never emit
secrets). Production log access is a manual owner procedure — no production
log workflow exists by design.

## 3. Incident first steps

1. Smoke the affected env (table above). Red smoke = incident confirmed.
2. Read the staging log tail (or owner-read production logs).
3. Check the last deployment report (provenance: commit, actor, backup path,
   live version). Suspect the most recent change first.
4. Decide: fix forward (new release via `DEPLOY_RUNBOOK.md`) or roll back
   (`ROLLBACK.md` — code only; escalate if data is involved).
5. Record: timeline, evidence links, and the lesson (candidate for a new
   guard — guards must be exact, never heuristic).

## 4. Deferred diagnostic suites (no Modern subject yet — NOT silently dropped)

| PHP suite | Status | Unblocks when |
|---|---|---|
| Mail/SMTP/Resend diagnostics + message status + email suite | DEFERRED | Mail phase binds a provider |
| IMAP bounce forensics | DEFERRED | Mailbox + provider exist |
| Gemini key/429/extraction diagnostics | DEFERRED | AI phase binds a provider |
| Register E2E + user journey | DEFERRED | Staging has users + mail + (for journey) frontend |
| AI feature-flag procedure | DEFERRED | AI phase |
| DB verify suites | DEFERRED | Final database phase |

Each deferred suite keeps its PHP safety properties on record (manual trigger,
exact confirms, secret-safe output, disposable inboxes, one-shot minimal
calls) and must re-implement them — not merely exist — when its phase lands.
