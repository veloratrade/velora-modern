# Local Disposable Backup + Restore Drill — 2026-10-03

**Task:** Charter Wave-1, Task 3 — local disposable backup/restore drill (ADR-012 Amendment A; `infra/backup/DR-RUNBOOK.md` dev/staging procedure).
**Branch:** `feat/mg-backup-restore-local-drill` (stacked on `feat/mg-obs-7-worker-tick-descriptor`; charter §5).
**Register impact:** MG-BACKUP-RESTORE OPEN → **PARTIAL** (`RECORDED_RUNTIME`, local); MG-G13 verification advanced the same way. This drill does **not** close either item (see §5).

---

## 1. Environment

- Disposable local PostgreSQL **17.11** cluster (port 55432; **not PG16** — standing caveat).
- Source database `velora_test`: migrations `0001…0022`, plus live application data produced by earlier charter tasks this session (1 user, 1 trade, 1 `user_analytics_daily` aggregate from the worker one-tick proof, 2 pg-boss schedules carrying MG-OBS-7 descriptors, pg-boss job history).
- **Honest labeling:** `create_pg_backup.sh` accepts `ENVIRONMENT ∈ {staging, production}` only; the drill used `staging` as the producer's vocabulary, but **the actual environment was the disposable LOCAL cluster — this is NOT the Railway staging environment and NOT staging evidence.**
- No credentials beyond the disposable cluster's own test password; no network; nothing uploaded (storage deliberately NOT claimed).

## 2. Drill (executed 2026-10-03, per DR-RUNBOOK §dev/staging)

1. **Create (real producer):** `DATABASE_URL=… ENVIRONMENT=staging SOURCE_COMMIT_SHA=821f92b1fa0b57caabb828290da8613d53184261 bash ops/backup/create_pg_backup.sh /tmp/drill-artifacts`
   - backup_id `db-backup-staging-20261003192242-bdf0265c449e`, **sha256 `5b3455636e7b39d59e0dfed90e04848646d5141a4769eefaaf67887fe904ef9a`**, size **31,969 bytes**, producer duration < 1s.
   - Evidence JSON emitted: `verification_status: INTEGRITY_VERIFIED`, `storage_status: NONE` — the producer correctly refused to imply storage.
2. **Gate on real producer output (fail-closed proof):** `backup_gate.py` with the real evidence file → **`BACKUP GATE FAIL: no verified backup — deploy/migration must NOT proceed`, exit 1**. A created-but-not-stored backup does not pass the release gate — exactly the ADR-012 semantics.
3. **Stored-bytes re-hash (uploader's verification step, local analog):** re-read the artifact from disk and re-hashed → **sha256 MATCH** with the evidence. (This is what `upload_backup.py` does against official storage after upload; locally it proves the artifact bytes are stable, NOT that official storage happened.)
4. **Restore (the missing proof — "a backup that was never restored is not a backup"):** fresh disposable database `velora_drill_restore`; `pg_restore --no-owner --no-privileges` → **exit 0 in 199 ms**, zero errors.
5. **Application-level recovery (runbook's check):**
   - `schema_migrations` = 22 ✓ · `users` = 1 ✓ · `trades` = 1 ✓
   - `user_analytics_daily` = `(1, 2026-09-13, 1, 493.50)` — exact aggregate from the one-tick proof ✓
   - `pgboss.schedule` = both schedules present **with MG-OBS-7 descriptors** (`data->>'jobClass'` verified) ✓
   - **Per-table content hashes (source vs restored, `md5(string_agg(row::text ORDER BY row::text))`): `users`, `trades`, `user_analytics_daily`, `schema_migrations` — ALL MATCH.**
   - Custom-format re-dumps of source vs restored are not byte-identical (custom format is not canonical across databases — internal object numbering); the authoritative equality check is the per-table hashes above, which is why they were run.
6. **Cleanup:** drill database dropped; artifact kept only in `/tmp` (never committed — `.gitignore` blocks dump bytes).

## 3. Result

The producer → integrity evidence → gate → restore → recovery-verification chain **works end-to-end on a real PostgreSQL**, and the gate **blocks** at every point storage is absent (fail-closed confirmed against real producer output, not fixtures). `ops/backup/`'s 167 Python tests also re-passed this session (offline structural coverage).

## 4. What this does NOT claim

- **No staging/production backup** — the Railway staging/production databases were never contacted (charter hard boundary).
- **No official storage** — nothing was uploaded to `veloratrade/velora-backups`; `storage_status` remains honestly `NONE`; the re-hash in §2.3 is a local analog, not storage verification.
- **No API-level health check** against the restored database (the runbook's `GET /health` step was not run — no API server was booted against the drill DB; row-level recovery is what this drill proves; the API-level check belongs to a staging drill).
- **Not PG16; superuser role** (`velora_test`, not a least-privilege backup role).
- RPO/RTO targets remain an owner decision; ADR-012 A.6 (wiring the gate into deploy) remains open.
