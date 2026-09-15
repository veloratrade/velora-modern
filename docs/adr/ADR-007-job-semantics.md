# ADR-007 — Job & Queue Semantics

## Status

Accepted — owner decision D-13 (2026-08-29): pg-boss initially (major version pinned at Phase 1), the job-semantics standard (idempotency key, lease/visibility, retry with jitter, max attempts → DLQ + replay, priority, timeout, retention, monitoring), and the four explicit Redis introduction triggers approved.

## Context

The PHP system already runs production workers on a DB-lease queue without Redis
(VERIFIED: `metaapi_sync_worker.php` — fenced queue, atomic lease, cron-concurrency-safe;
`ai_job_worker.php` — "MySQL lease pattern … for PHP-FPM (no Redis)"). The modern
system formalizes the same model on PostgreSQL.

## Verified Evidence

- Fenced-queue worker pattern with atomic lease acquisition (VERIFIED source headers).
- Job domains (VERIFIED): MetaApi sync ticks, AI jobs, AI retention cleanup
  (`--dry-run`/`--execute` discipline), async content translation.
- GitHub Actions worker incident history (VERIFIED docs): a stuck-job/cost incident
  (1,353 runner-minutes cancelled) — motivation for timeouts and bounded retries.

## Decision

**Queue: pg-boss initially; Redis deferred.** Pin the pg-boss major version
(breaking changes between majors); queue-table retention/archival configured at
setup; queue-depth and job-age alerts are day-one (observability-contract).

**Standard job contract (every job class):**

| Property | Requirement |
|---|---|
| Idempotency key | business key, e.g. `sync:{accountId}:{cursor}`, `extract:{screenshotId}:{promptVersion}`, `outbox:{notificationId}` |
| Lease/visibility timeout | > worst-case runtime; renewed by long jobs |
| Retry | exponential backoff **with jitter**; max attempts bounded |
| Dead-letter | after max attempts → DLQ + alert; replay tooling required |
| Timeout | hard timeout per class; kills runaways |
| Priority | per class (webhook projection > reports) |
| Retention | completed job rows expire; archive before purge |
| Monitoring | depth, oldest-job age, retry rate, DLQ count |

**Redis introduction triggers (any one, documented evidence required):**

1. multi-node deployment needing shared rate-limit/cache state;
2. sustained queue throughput around **500–1,000 jobs/sec** (Postgres queue write amplification becomes the bottleneck);
3. measured cache-hit win with a hot dataset that does not fit per-node memory;
4. genuine pub/sub fanout requirement.

Redis is **not** introduced because it is fashionable; the trigger evidence is
recorded in an ADR addendum when it fires.

### Amendment — scheduled producer and least-privilege queue bootstrap (2026-09-16, implemented)

**Status: IMPLEMENTED** with the MetaAPI historical-sync path.

**Scheduling uses pg-boss's NATIVE cron — no new mechanism was introduced.**
pg-boss 10.4.2 ships `boss.schedule(queue, cron, data)`, persisted as a row in
`pgboss.schedule` and driven by its internal `__pgboss__send-it` queue. The
producer registers a single recurring **tick** (`metaapi.sync-tick`, default
`0 * * * *`); each tick reads the accounts that currently carry a
`metaapi_account_id` and enqueues one `metaapi.sync-account` job per account.

*Why a fan-out tick rather than one schedule row per account:* schedules are
durable rows, so per-account rows would need lifecycle management on every
account change and would rot when an account is deleted. A single tick reads
live state instead. With zero MetaAPI-provisioned accounts it enqueues zero
jobs — the producer cannot manufacture work.

**No second service, no host cron, no new dependency.** `cron-parser` is
already vendored as a pg-boss dependency. Declaring a worker service in-repo
remains impossible (Railway config-as-code has no `services` key), so **worker
deployment is still an owner decision and is NOT made here**.

**Enqueue idempotency is layered:** pg-boss debounces cron ticks with
`singletonKey: name, singletonSeconds: 60`, and each enqueued job carries the
business key `sync:{accountId}:{cursor}` so a repeated tick over the same
window collapses to one job.

**Least-privilege queue access — empirically derived, not assumed.** pg-boss
self-migrates and self-creates queue partitions, which naively implies granting
the worker `CREATE` on the database. That was measured instead of accepted, and
the result is that **`velora_worker` runs pg-boss with NO CREATE on the database
and NO CREATE on the `pgboss` schema** (both VERIFIED `false` at runtime on
PostgreSQL 17.10):

- `start()` short-circuits when `pgboss.version` exists, so the worker never
  runs install/upgrade DDL. A simulated schema downgrade made `start()` fail
  closed with `42501` — upgrades are an owner/bootstrap action.
- `createQueue()` short-circuits when the queue row exists, so with queues
  pre-created the worker never runs partition DDL. Creating a **new** queue
  fails `42501` — introducing a job class is a deployment decision, not
  something a worker may do to itself.
- Runtime DML and `supervise` maintenance target the parent tables only —
  VERIFIED over repeated maintenance ticks with zero permission errors.

**Bootstrap path.** The `pgboss` schema, its objects and every queue —
including pg-boss's internal `__pgboss__send-it`, whose `createQueue` failure
the timekeeper silently swallows — are created by `velora_owner` in
`db/provision.ts` (the operator-run, `ADMIN_DATABASE_URL` path), never by a
migration and never by the worker. `db/roles.sql` §6 then grants the worker
`USAGE` + table DML + `EXECUTE` and nothing more.

## Alternatives Considered

- BullMQ now (Redis-backed): rejected — adds a service with no current need.
- Managed queues (SQS-class): rejected — hosting/cost/region complexity; no operational fit yet.
- Kafka-class streaming: rejected — absurd for this workload.
- In-process timers (cron-per-app): rejected — recreates the cPanel fragility being escaped.

## Consequences

### Positive
- One fewer service to operate; transactional job+data writes (job enqueued in the same TX as state change — a correctness win Redis queues cannot offer natively).
- Same operational model the team already understands.

### Negative
- Queue load shares Postgres capacity (mitigated by retention + monitoring; escape hatch documented).

## Security Impact

Jobs carry user data → payloads must not contain secrets; worker DB role is
separate and least-privilege (security-policy); DLQ contents are redacted.

## Migration Impact

Ephemeral worker/queue state is NOT migrated (migration-strategy).

## Testing / Verification Requirements

- Failure-injection tests: kill worker mid-job (lease reclaim), duplicate enqueue
  (idempotent convergence), poison payload (DLQ), storm (backoff+jitter verifies no thundering herd).

## Open Questions

1. Final pg-boss version pin (Phase 1).
2. Priority classes list (Phase 1, per capability wave).

## Phase

Phase 0 decision; queue skeleton + alarms = Phase 1.
