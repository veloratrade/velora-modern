# Worker One-Tick Runtime Proof + MG-OBS-7 Fix — 2026-10-03

**Task:** Charter Wave-1, Task 2 — local worker one-tick runtime proof.
**Branch:** `feat/mg-obs-7-worker-tick-descriptor` (stacked on `feat/mg-obs-6-pg-smoke-expectation`; charter §5 — no direct-`main` implementation).
**Classification of outcome:** the proof **succeeded as a proof and failed as a first boot** — it surfaced a real defect (MG-OBS-7) that was fixed and re-proven in the same session. Evidence below is the complete record of both.

---

## 1. Environment

- Disposable local PostgreSQL **17.11** cluster (`/tmp/pgdata`, port 55432; **not PG16** — the standing caveat applies: PG16 remains the GHA-proven / compose target).
- Database `velora_test` pre-seeded by the AC-9 pg-smoke run: migrations `0001…0022`, 1 user, 1 live trade, 0 analytics rows (the user was therefore DUE for recompute).
- Worker started exactly as production code allows: `DATABASE_URL=… npm run start:worker` with **no `METAAPI_PLATFORM_TOKEN`** (MetaAPI handler correctly not registered — `worker.token_absent`; copy transport absent — not registered).
- **Caveat (recorded honestly):** the connection used the cluster superuser `velora_test`, not the least-privilege `velora_worker` role (that role's grant grid is what the D5 battery proves). This proof exercises runtime mechanics, not the least-privilege path.
- **No credentials, no external calls:** no MetaAPI, no ECB fetch (the FX tick was registered but never fired — charter hard boundary on live third-party integrations).

## 2. First boot — defect found (pre-fix)

Boot was clean (`worker.started count=4`), and a single manually dispatched `analytics.recompute-tick` job (via `boss.send`) **killed the process**:

```
TypeError: Cannot read properties of undefined (reading 'slice')
    at safeDlqReason (apps/worker/src/observability/safeError.ts:130)
    at WorkerRunner.processOnce (apps/worker/src/runner.ts:29)
… process exit code 1
```

**Root-cause chain (source-verified, pg-boss 10.4.2 source read):**

1. The adapter registered cron schedules as `boss.schedule(jobClass, cron)` — **no `data` argument**.
2. pg-boss's timekeeper copies the schedule's `data` column **verbatim** into every fired job (`timekeeper.js`: `insert(jobs.map(i => i.data))`). With no data, fired jobs carry an empty payload.
3. `claim()` types `j.data` as the `JobDescriptor` the runner dispatches on → `descriptor.jobClass` is `undefined` → handler lookup fails → the no-handler path calls `safeDlqReason("NO_HANDLER", undefined)` → `undefined.slice` throws inside an un-awaited promise → **unhandled rejection → process death**.

**Consequence:** the worker would have died on its **first real cron fire** (analytics at `:20` hourly, FX daily, or the MetaAPI sync tick when token-configured). No cron tick had ever executed anywhere (the worker is not deployed — MG-WORKER-DEPLOY), so no prior evidence could have caught it; this is exactly the gap the one-tick proof exists to close.

## 3. Fix (MG-OBS-7)

- `apps/worker/src/queue/pgBossAdapter.ts` — `schedule()` now passes a complete maintenance-policy `JobDescriptor` (`jobClass`, `priorityClass: "maintenance"`, `idempotencyKey: tick:<jobClass>`, full `DEFAULT_JOB_POLICIES.maintenance`) as the schedule's `data`, so cron-fired jobs are first-class descriptors. Cadence/debounce stays pg-boss-owned.
- `apps/worker/src/runner.ts` — a job whose data is not a descriptor (foreign/malformed producer) now dead-letters with `NO_HANDLER` instead of crashing the process.
- `apps/worker/src/observability/safeError.ts` — `safeDlqReason` accepts a missing jobClass and emits the fixed token `unknown` (bounded at the persistence boundary).

**Tests added:**
- `apps/worker/src/runner.test.ts` — malformed job (no `jobClass`) → `"no-handler"` + DLQ reason `NO_HANDLER:unknown`, no throw.
- `db/tests/pgBossAdapter.pg.test.ts` (real-PG battery, 3 new subtests, file now 16/16): schedule row carries a complete descriptor (jobClass/priorityClass/timeoutMs>0/idempotencyKey); a timekeeper-shaped job (data = the schedule's stored descriptor) runs end-to-end through the real queue; a malformed raw-inserted job is terminally failed with the classified reason persisted in `output` and never redelivered.

**Discovered pg-boss v10 facts (recorded for future work):** `pgboss.job` is LIST-partitioned per queue name — a raw insert into a never-created queue fails with `no partition of relation "job" found` (pg-boss itself blocks foreign producers targeting unknown queues); `boss.fail(name, id, data)` stores `data` as the job's `output` (the adapter's `{dlq, reason}` object is output data, not a routing option); retry routing is `retry_count < retry_limit → 'retry'`, else `'failed'`; the `dead_letter` target is stamped at `send()` time from the queue config, which is why raw rows fail terminally in place.

## 4. Post-fix runtime proof (executed 2026-10-03, same cluster)

1. Worker booted with the fix: `worker.started count=4`; both schedules now stored **with descriptors** (`schedule: analytics.recompute-tick | cron: 20 * * * * | data.jobClass: analytics.recompute-tick | timeoutMs: 120000`; same for `fx.ecb-tick`).
2. **Crash-shape repro (malformed job inserted directly into the existing `analytics.recompute-tick` queue):** the worker logged `job.no_handler jobClass=unknown` and **kept running** (pre-fix: process death).
3. **Real cron fire:** the analytics schedule's cron was accelerated to `* * * * *` via `boss.schedule` upsert **preserving the adapter-written data verbatim**; pg-boss's real timekeeper then fired it. Observed chain:

```
{"level":"info","event":"scheduler.analytics_tick","count":1}
{"level":"info","event":"job.done","jobClass":"analytics.recompute-tick","id":"c075b2d3-…","idempotencyKey":"tick:analytics.recompute-tick","durationMs":24}
{"level":"info","event":"analytics.recomputed","count":1}
{"level":"info","event":"job.done","jobClass":"analytics.recompute-daily","id":"82166b93-…","idempotencyKey":"analytics:daily:1:2026-10-03T19","durationMs":11}
```

4. **Database verification:** `user_analytics_daily` materialized the pre-aggregate for the due user — `(user_id=1, day=2026-09-13, trades_count=1, net_pnl=493.50)` — the roadmap-mandated async analytics pivot proven end-to-end (cron → tick → due-set → per-user recompute job → aggregate row).
5. **Graceful shutdown:** `SIGTERM` → `{"level":"info","event":"worker.shutdown","service":"SIGTERM"}` logged (outer exit code 143: the signal reached the tsx/npm process group; the shutdown handler itself ran and logged).

## 5. Gates (all on this branch)

- Typecheck: **0 errors** (clean rebuild).
- Local unit battery: **ALL TEST FILES PASSED** (0 fail, 0 skipped).
- `db/tests/pgBossAdapter.pg.test.ts` on real PG 17.11: **16/16** (13 prior + 3 new).
- Secret scan: **PASS, 0 findings**.
- Migration tests: unaffected (no `db/migrations` change) — not rerun for this task.

## 6. What this does and does not claim

- **Claims:** the analytics scheduler's one-tick chain runs for real against real PostgreSQL + real pg-boss 10.4.2 timekeeper, with no credentials and no external calls; the pre-fix crash defect is fixed with regression tests at both the unit and real-PG integration level.
- **Does NOT claim:** deployment (MG-WORKER-DEPLOY stays OPEN — OD-AC-WORKER owner-gated), the FX tick executing (would call the ECB — charter-excluded; its registration/schedule-upsert IS proven at boot), the MetaAPI sync tick (token-gated), the copy tick (no transport), least-privilege role execution (superuser used, see §1), or PG16 behavior.
