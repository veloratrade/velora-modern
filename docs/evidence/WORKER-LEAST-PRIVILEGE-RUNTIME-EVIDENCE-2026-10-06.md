# Worker Least-Privilege Runtime Evidence — 2026-10-06 (AC-37)

**Gap:** MG-WORKER-DEPLOY (P1) — "Worker not deployed (no service definition; no
scheduled job ever run)". **Companion hardening:** MG-OPS-TOOLING live-PG probe run.

**Environment:** disposable local PostgreSQL **17.11** (Debian 13, sandbox-installed
cluster), database `velora_deploy_evidence`, created fresh for this run. This is a
REAL PostgreSQL with the REAL deployment contract executed — not PGlite, not a
hosting deploy. Credentials used are throwaway local test values.

---

## 1. Full deployment-contract sequence (first execution in this lineage on PG 17)

Exactly the operator sequence from `db/provision.ts` / `docs/deployment-contract.md`:

| Step | Command (abbrev.) | Result |
|---|---|---|
| 1 | `ADMIN_DATABASE_URL=… ADMIN_DATABASE_ROLE=velora npx tsx db/provision.ts --phase pre-migration` | `applied: [roles-bootstrap.sql, ownership-model]` |
| 2 | operator: local throwaway passwords for `velora_migrator`/`velora_worker`/`app_readwrite` (out-of-band by design — none in repo) | OK |
| 3 | `MIGRATION_DATABASE_URL=…?options=-c role=velora_owner npx tsx db/migrate.ts` (connected AS `velora_migrator`, DDL via `SET ROLE velora_owner`) | `applied: 0001…0030`, head `0030_email_notifications.sql` |
| 4 | `--phase post-migration` | `applied: [reassign-ownership, pgboss-bootstrap, roles.sql, default-privileges, revoke-migrator-create]` |
| 5 | privilege grid self-check | **8/8 as expected** incl. negatives: `app_rw_update_trade_events=false`, `worker_delete_webhook_events=false`, `migrator_select_users=false`, `migrator_create_on_schema=false`, `all_objects_owned_by_owner=true` |

## 2. Worker boot under the least-privilege role `velora_worker`

```
DATABASE_URL=postgres://velora_worker:${LOCAL_THROWAWAY_TEST_PASSWORD}@127.0.0.1:5432/velora_deploy_evidence
METAAPI_PLATFORM_TOKEN=<invalid-local-evidence-token>   # dummy: 0 accounts exist → 0 jobs → 0 external calls
METAAPI_SYNC_CRON="* * * * *"                            # legacy-parity cadence as an explicit TEST override
```

Boot log (verbatim):

```
{"level":"info","event":"scheduler.registered","jobClass":"metaapi.sync-tick"}
{"level":"info","event":"scheduler.registered","jobClass":"fx.ecb-tick"}
{"level":"info","event":"scheduler.registered","jobClass":"analytics.recompute-tick"}
{"level":"info","event":"worker.started","count":6}
```

- `worker.started count=6` — the worker runs under its **actual `velora_worker`
  role** (the 2026-10-03 one-tick proof used the superuser; that caveat is now
  remedied for the boot+tick path).
- The MetaAPI sync handler registered (token present), FX + analytics handlers
  registered unconditionally, copy transport correctly absent.

## 3. `METAAPI_SYNC_CRON` override applied at runtime (AC-35 runtime evidence)

`pgboss.schedule` rows after boot (queried as admin):

```
analytics.recompute-tick | 20 * * * * | data.jobClass: analytics.recompute-tick
fx.ecb-tick              | 30 16 * * * | data.jobClass: fx.ecb-tick
metaapi.sync-tick        | * * * * *  | data.jobClass: metaapi.sync-tick
```

The env override (`* * * * *`, the `LEGACY_SYNC_CRON` reference value) took effect
through `resolveSyncCron` — defaults for the other two schedulers unchanged.

## 4. First-ever execution of the MetaAPI sync tick (real pg-boss timekeeper)

Seven consecutive fires, each a complete enqueue→claim→execute→complete cycle:

```
{"level":"info","event":"scheduler.tick","count":0}
{"level":"info","event":"job.done","jobClass":"metaapi.sync-tick","id":"2e3a48f4-…","idempotencyKey":"tick:metaapi.sync-tick","durationMs":10}
… (7 fires total, ids 2e3a48f4, da9d0f58, 01969553, 1b3eb67f, 529c2746, 54beabc7, 36145d81)
```

`count=0` is the fail-closed design working: **no connected accounts exist, so the
tick manufactures zero jobs** — it does not enqueue work that would then call
MetaAPI with an invalid token. Database state at shutdown:

```
__pgboss__send-it | completed | 7   (timekeeper's internal cron dispatch)
metaapi.sync-tick | completed | 7   (the scheduled tick itself)
states other than completed/created: 0
```

## 5. Graceful shutdown

`SIGTERM` → `{"level":"info","event":"worker.shutdown","service":"SIGTERM"}` logged,
process exited cleanly (the shutdown handler ran before termination).

## 6. Companion: `ops:verify` live-PG run surfaced and fixed a real probe bug

Running the new read-only probe (MG-OPS-TOOLING) against this database **as
`velora_worker`** (its intended least-privilege audience):

1. **First run failed with 42501** — `velora_worker` has no SELECT on
   `audit_log`, `auth_events`, `provisioning_operations`, `user_credentials`
   (correct least-privilege design). The probe now RECORDS these instead of
   crashing: counts surface as `nopriv`, and the constraints the role cannot
   verify surface as `fkUnverifiable` — a privilege boundary is evidence, not a
   failure, and is never counted as drift.
2. **A real hollow-scan bug was found and fixed:** with live `node-postgres`,
   `array_agg(name)` returns the wire literal string, not a JS array (PGlite
   returns arrays, which hid the difference in the battery) — so every FK
   constraint was silently skipped and the report claimed "no orphaned child
   rows" without having scanned any. Fixed by `json_agg` (parsed by both
   drivers) plus a FAIL-CLOSED guard: a non-array column payload now aborts the
   scan instead of skipping, and the report states
   `constraints checked: 74` so a hollow scan can never masquerade as clean.
   Battery `db/tests/opsVerify.test.ts` now pins both behaviors (7/7).
3. Final probe verdicts: as `velora_worker` → 74 constraints checked, 6 recorded
   `nopriv`, **CLEAN**; as admin → 74/74 checked, **CLEAN**.

## 7. What this does and does not claim

- **Claims:** the deployment-contract sequence executes end-to-end on real
  PostgreSQL 17.11 with the 8/8 least-privilege grid; the worker boots and runs
  under the real `velora_worker` role with zero elevated privileges; the pg-boss
  cron timekeeper fires the MetaAPI sync tick (never executed anywhere before)
  and every fire completes; `METAAPI_SYNC_CRON` is honored at runtime with
  defaults untouched; graceful shutdown works; the ops probe is least-privilege
  compatible and no longer capable of a hollow FK scan.
- **Does NOT claim:** a hosting deployment (OD-AC-WORKER stays owner-gated —
  Railway cannot declare a second service in-repo), the FX tick executing
  (would call the ECB — external-call boundary), the copy tick (no transport
  configured), a real MetaAPI round-trip (dummy token, zero accounts — the sync
  HANDLER path remains MG-METAAPI-* live-verification class), or PG16 behavior.
- MG-WORKER-DEPLOY therefore remains **OPEN**, with its local-evidence half now
  complete: service defined (`infra/Dockerfile.worker`, compose, deployment
  contract), ticks proven locally for analytics (2026-10-03) and MetaAPI sync
  (this run); what remains is the owner deploy + the two externally-gated ticks.
