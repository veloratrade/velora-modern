# VELORA-MODERN — Observability Contract

## Naming conventions

- Metrics: `velora.<service>.<component>.<name>` (snake_case), unit suffix where
  ambiguous (`_seconds`, `_bytes`, `_count`). Services: `api`, `web`, `worker`.
- Logs: structured JSON, one event per line.
- Traces: OTel-compatible; `request_id` correlates web→api→worker→provider.

## Metric inventory (minimum, day-one)

| Metric | Type | Labels |
|---|---|---|
| `velora.api.http.duration_seconds` | histogram | route, method, status |
| `velora.api.http.errors_total` | counter | route, status |
| `velora.worker.queue.depth` | gauge | queue |
| `velora.worker.job.age_seconds` | gauge | queue |
| `velora.worker.dlq.count` | gauge | queue |
| `velora.worker.retries_total` | counter | job_class |
| `velora.worker.metaapi.freshness_seconds` | gauge | (per account → aggregate p50/p95/stale_count) |
| `velora.api.webhooks.result_total` | counter | source, result(accepted/rejected/deduped/quarantined/failed) |
| `velora.ai.requests_total` | counter | provider, transport, outcome |
| `velora.ai.provider.duration_seconds` | histogram | provider, transport |
| `velora.ai.provider.errors_total` | counter | provider, status_class (429/5xx/timeout) |
| `velora.ai.quota.usage_ratio` | gauge | scope (user/global), period |
| `velora.mail.outbox.lag_seconds` | gauge | template |
| `velora.api.db.pool.saturation_ratio` | gauge | pool |
| `velora.infra.backup.status` | gauge | kind (dump/wal), last_success_age_seconds |

## Log schema (required fields)

`timestamp` (ISO-8601 UTC) · `level` · `service` · `operation` · `request_id`
· `trace_id` (where applicable) · `user_id`/`account_id` (where safe — IDs only)
· `event` · structured payload (typed fields, no free-form dumps).

## Never logged (enforced by redaction middleware + review)

Passwords · JWTs · refresh tokens · API keys · provider credentials ·
raw screenshot bytes · full env contents · token fragments from links.

## Alerts (day-one set)

DLQ > 0 · queue depth sustained (15 min) · stale-account count threshold ·
webhook reject-rate spike · AI quota > 80% · backup last_success_age exceeded ·
HTTP 5xx rate · cert expiry. Policy: page only on user-visible damage; rest → review queue.

## SLOs — placeholders pending owner approval (OWNER DECISION REQUIRED)

| SLO | Placeholder target | Notes |
|---|---|---|
| API latency p95 | e.g. < 300 ms (read), < 800 ms (write) | load-test gates at user tiers |
| MetaApi sync freshness | e.g. 95% accounts synced within 1 h | depends on provider limits — validate |
| Email delivery lag | e.g. p95 < 60 s from trigger | Resend-era observed ~10 s (verified) |
| AI queued verdict latency | e.g. p95 < 5 min | queued path only |

These are placeholders: they become binding only with owner sign-off and
load-test evidence at Phase 3 gates.
