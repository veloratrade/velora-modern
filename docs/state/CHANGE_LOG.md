# VELORA-MODERN — Change / Evidence Log (since the 2026-09-25 audit baseline)

**System:** Agent Context System (ADR-017) · **Format:** append-only, newest last.
**Purpose:** every commit that advances either repository past its recorded
baseline gets an entry: commit → migration impact → evidence status. Entries
are agent-curated (the tool lists raw commits; impact classification is a
judgment, recorded here so the next session does not re-derive it).
**Baselines:** modern `ffcb0e976147c753493532188a598ecb5de8d06d` · legacy
`edede313280f2f0e298f5ccbf5bbdd4d676c80bd` (audit 2026-09-25).

---

## AC-0 — 2026-09-25 · Audit event (no commits; both repos already at baseline)

- **Repos:** modern `ffcb0e9` (unchanged) · legacy `edede31` (unchanged).
- **Event:** Final two-repository migration reconciliation audit executed
  read-only. Verdict: **NOT CLOSED** (0 PASS / 1 PARTIAL / 14 FAIL).
- **Impact:** none on trees; establishes the historical baseline.
- **Evidence:** `docs/audits/2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md`
  (stored verbatim 2026-09-26, SHA-256
  `643fa1b554753d4dc584699261bfe996e668e6dcd2876abde53dc77b090aea2f`).
- **Gaps opened:** all §A/§B/§C rows of `MIGRATION_GAP_REGISTER.md` originate here.

## AC-1 — 2026-09-26 · Governance: Agent Context System introduced (ADR-017)

- **Commit:** this system's introducing commit on branch `governance/agent-context`
  (self-referential — a commit cannot contain its own hash; identify with
  `git log --format='%H %s' -- docs/state/CHANGE_LOG.md | tail -1`).
  Subject: `governance: agent context system — historical audit baseline + persistent project state (ADR-017)`.
- **Classification:** GOVERNANCE-ONLY (paths: `docs/audits/`, `docs/state/`,
  `docs/adr/ADR-017`, `AGENTS.md`, `tools/agent-context.mjs`). No application,
  schema, infra, or contract paths touched → does not invalidate any recorded
  evidence (CURRENT_STATE.md §4 drift policy).
- **Impact on migration state:** none. No gap opened or closed by code. One
  documentation gap closed as a side effect: `MG-OBS-4` (AGENTS.md artifact-map
  staleness).
- **Evidence:**
  - Audit stored verbatim: `cmp` identical; SHA-256 match recorded above and in
    `current-state.json` (verified pre-commit and by the tool).
  - `tools/agent-context.mjs` executed: verdict CURRENT at baseline (0 commits
    since), and CURRENT (governance-only delta) after this commit.
  - `bash tools/secret-scan.sh`: PASS, 0 findings (standing gate, D-06).
  - Both JSON state files parse (validated).
- **Owner authorization:** instruction of 2026-09-26 ("Store the COMPLETE audit
  verbatim … continue the implementation … create one clean governance-only
  commit"). Push/PR/merge: NOT authorized yet — branch only, `main` untouched.

## AC-2 — 2026-09-26 · Documentation defect closure (audit §16.3 D1/D2/D4/D5 + roadmap banner + ADR index + inspection evidence)

- **Commit:** `59047b856e4794c1436ed6abfc01ab9a11c60c35` — "docs: close audit documentation defects — README, roadmap banner, report lineage, ADR index, citation fix"
- **Classification:** MIXED — governance docs **plus one application comment** (`apps/api/src/attachments/attachmentService.ts:11`, citation-only, no behavior). APP path per drift policy → curated by AC-3 below.
- **Impact on migration state:** MG-DOC-1 → CLOSED (README rewritten); MG-DOC-2 → CLOSED (ADR count corrected + `docs/adr/README.md`); MG-DOC-4 → CLOSED (citation corrected); MG-DOC-5 → CLOSED (lineage banners on all three frontend reports, content unedited); MG-DOC-6 → CLOSED (ADR-015 gap documented in `docs/adr/README.md`); **MG-DOC-3 → PARTIAL** (visible reconciliation banner added to `MASTER_ROADMAP.md`; **rows intentionally left unedited per owner instruction** — full reconciliation remains owner-gated). MG-G12 remains OPEN (now blocked only by MG-DOC-3 rows + ADR-004/009 open sub-items). Inspection report of 2026-09-26 committed as `docs/evidence/AGENT-CONTEXT-INSPECTION-2026-09-26.md` (MG-OBS-3 pattern).
- **Evidence:** `git show 59047b8` (8 files, +305/−12; the only `apps/**` change is the 6-line comment); verification battery at this commit recorded in AC-3.
- **Authorization:** owner instruction "ادامه" (continue) 2026-09-26, following audit §19.2(g) "Correct README, MASTER_ROADMAP, ADR numbering and the `ScreenshotController` citation" and §16.3 D5.

## AC-3 — 2026-09-26 · State curation — advance verified baseline past AC-2, record fresh battery

- **Commit:** this curation commit — subject "state: curate AC-2 — advance verified baseline, record verification battery" (self-referential, ADR-017 §Decision 7).
- **Classification:** GOVERNANCE-ONLY (`docs/state/**`).
- **Impact on migration state:** `current_verified.modern_sha` advanced `2ad49df` → `59047b8` after verification. **Local battery re-captured fresh at `59047b8` (2026-09-26): `CURRENT_RUNTIME_VERIFIED`** — per CURRENT_STATE.md §3 this is valid for this session/tree and decays to `RECORDED_RUNTIME` for later sessions.
- **Evidence (executed 2026-09-26 at `59047b8`, clean tree):**
  - `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` → **0 errors**
  - `node tools/run-tests.mjs` → **804/804 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo** (ALL TEST FILES PASSED)
  - `npm run test:migrations` → **19/19 pass, 0 fail**
  - `bash tools/secret-scan.sh` → **PASS (0 findings)**
  - `node tools/agent-context.mjs` → OVERALL CURRENT (this commit classified governance-only + logged)
- **Authorization:** ADR-017 state discipline (the tool's DRIFTED instruction); owner "ادامه" 2026-09-26.

## AC-4 — 2026-09-26 · Branch push + PR opened (distribution event)

- **Commit:** this entry's commit — subject "state: record branch push + PR #8 (AC-4)" (self-referential, ADR-017 §Decision 7).
- **Classification:** GOVERNANCE-ONLY (`docs/state/**`).
- **Event:** owner provided push credentials (fine-grained PAT, transmitted in chat; used **transiently** — never written to any repository file, commit, or git config; the /tmp copy is deleted at session end; rotation recommended post-merge since it transited chat). Branch `governance/agent-context` pushed to `origin` (`2ad49df`, `59047b8`, `abbe93e` + this commit); **PR #8** opened for owner review: `https://github.com/veloratrade/velora-modern/pull/8`. Remote `main` verified still at `ffcb0e9` before push (no drift). Per OD-10: merge requires owner review; `main` untouched.
- **Impact on migration state:** none to gap rows; distribution state recorded in `current-state.json` (`distribution`). MG-OBS-2 unchanged — the OD-2 provenance-tag decision remains open (now trivially executable once decided: the pinned commit `99e024c8` is reachable via the `backup/main-before-migration-promotion-99e024c8` branch in this clone).
- **Evidence:** `git ls-remote` post-push (branch at pushed SHA, `main` at `ffcb0e9`); PR API response HTTP 201 (PR #8, state open); `bash tools/secret-scan.sh` re-run PASS (0 findings) before each push (D-06 standing gate).
- **Authorization:** owner credential provision 2026-09-26, following the push/PR plan in the AC-3 session report.

<!-- Append new entries below this line. Entry template:
## AC-n — YYYY-MM-DD · <title>
- Commit: <sha or locator> · Repo/branch
- Classification: GOVERNANCE-ONLY | APPLICATION (paths touched)
- Impact on migration state: <gaps opened/closed, evidence captured/decayed>
- Evidence: <commands, artifacts, links>
- Authorization: <owner instruction/decision reference>
-->
## AC-5 — 2026-09-26 · Build evidence refresh + MetaAPI assembly implementation brief

- **Commit:** this entry's commit — subject "docs: MetaAPI position-assembly brief + build evidence refresh (AC-5)" (self-referential, ADR-017 §Decision 7).
- **Classification:** GOVERNANCE-ONLY (`docs/reconciliation/`, `docs/state/`).
- **Impact on migration state:** MG-METAAPI-ASSEMBLY unchanged (OPEN) — an implementation **brief** is now linked (design only, no code): `docs/reconciliation/METAAPI_POSITION_ASSEMBLY_BRIEF.md`, with owner decisions OD-M-PA-1 (repair of previously imported per-fill rows), OD-M-PA-2 (convergence model), OD-M-PA-3 (contract_size parity reading). New observation MG-OBS-5 recorded: legacy `MetaApiService.php` never sets `contract_size` (0 grep matches; schema default `1.00000000` at `schema.sql:232`) — audit §9.2's "contract size from the deal" is not what the code path does; modern's hardcoded 1 is parity on that field.
- **Evidence (executed 2026-09-26 at `d85a589`, clean tree):**
  - `npm run build --workspace=@velora/web` → **exit 0**, route table emitted (34 `page.tsx` measured app-side; 0 `route.ts`; no dynamic segments — prior closure-report figure was 35 ƒ incl. middleware; measured count recorded as-is).
  - Sources read for the brief (both repos): `MetaApiDealAssembler.php` (complete), `MetaApiService.php` (reconcileAccount/processWebhook), `schema.sql:232`, `syncRepository.ts`, `normalizeDeal.ts`, `metaapiSync.ts`.
- **Authorization:** owner "ادامه" 2026-09-26; brief-only scope respects the standing "do not fix migration gaps yet" instruction.

## AC-6 — 2026-09-26 · Real-PostgreSQL battery evidence captured (disposable local cluster)

- **Commit:** `3135da9` — full SHA `3135da9` *(completed by this curation commit: the original entry's subject line had `×` where the commit has `x`, which broke the tool's subject match; SHA now recorded for robust matching; the ×/x discrepancy is fixed in the entry text)*. Subject: `state: real-PG battery evidence — 23 batteries x 2 orders green (AC-6)`. Tree under test = `5140098` (unchanged; verification-only pass). Curation commit (this one) is governance-only and self-records per ADR-017 §Decision 7.
- **Classification:** GOVERNANCE-ONLY (`docs/state/**`) — no application code touched.
- **Environment:** disposable local PostgreSQL **17.11** (Debian; apt — PG 16 unavailable in this sandbox), cluster in `/tmp/pgdata`, TCP 127.0.0.1:55432, test-only credentials mirroring `postgres-evidence.yml` (`velora_test` / `velora-test-only` / `velora_test`); cluster destroyed after the run. **Version caveat: 17.11, not the GHA-proven 16.15 / compose-target 16 — evidence recorded with that label.**
- **Evidence (executed 2026-09-26 against tree `5140098`):**
  - `DATABASE_URL=… bash tools/run-pg-batteries.sh` → **REAL-PG EVIDENCE: PASS — batteries: 23, runs: 46 (forward + reverse), failures: 0**; every run asserted `# tests ≥ declared`, `# skipped 0`, `# fail 0`. Forward-order totals: 236 tests (subtests included), 0 fail — incl. `pgRoles` 22 (D5 privilege grid), `pgTradeConcurrency` 14 (D4 races), `metaapiProvisioning` 26, `metaapiSync` 13, `syncSubstrate` 17, `pgBossAdapter` 13, `credentialStore`/`credentialAudit`/`auditCredentialContract`/`auditLog`, `analyticsRecompute` 13, `copyDispatch` 15, `developerKeyAuth` 6, `migrateCli` 6.
  - Migrations `0001…0022` **all applied cleanly** on the real server (observed via the S1b assertion diff on first run); second invocation applied **0** new migrations (`ran = []`) — idempotency confirmed.
  - `tools/pg-smoke.ts` (D1 S1–S9): S1a PASS (real-server identity, `server_version = PostgreSQL 17.11`); **S1b FAILS on a stale expectation** — it asserts the D1-era migration list `[0001…0005]` while the tree carries `0001…0022`. Recorded as **MG-OBS-6** (test-side fix owner-gated; the batteries are unaffected).
- **Impact on migration state:** MG-G11 evidence strengthened — the audit's "real-PG batteries NOT VERIFIED" item now has captured runtime evidence (`CURRENT_RUNTIME_VERIFIED` @ `5140098` on PG 17.11, disposable). Gate stays PARTIAL (missing capabilities remain untestable). New observation MG-OBS-6 opened. No other gap touched.
- **Authorization:** owner "ادامه" 2026-09-26; verification-only (no code change, no owner decision, no production system — disposable, test-only, mirroring the repo's own `postgres-evidence.yml` path without using GitHub Actions, per the owner cost policy).

## AC-6b — 2026-09-26 · Close the AC-6 curation loop + self-reference protocol note

- **Commit:** this entry's commit — subject "state: record AC-6 curation SHA and close the loop (AC-6b)" (self-referential **by subject**; the curation commit `23aa83f` — full SHA `23aa83fe4ab5` — is now recorded by SHA above in this entry's edit of the AC-6 block). Governance-only (`docs/state/CHANGE_LOG.md`).
- **Curation-commit record (exact, injected from git):** `23aa83fe4ab54cfa9a3d54df2fb7a254588fc5c1` — subject: "state: curate AC-6 — record commit SHA (self-reference completion)".
- **This entry's own commit:** subject "state: log the AC-6 curation commit subject (AC-6c)" (self-referential by exact ASCII subject).
- **Protocol lesson (binding for future entries):** a CHANGE_LOG entry must contain **the exact commit subject, ASCII-only, or the full SHA** — a single differing character (here `×` vs `x`) breaks `tools/agent-context.mjs` subject matching and cascades into extra curation commits. Self-referential entries terminate only when the entry carries its own commit's exact subject.
- **Impact on migration state:** none beyond AC-6 bookkeeping.

## AC-7 — 2026-09-26 · Markdown/JSON state synchronization (gap register)

- **Commit:** this entry's commit — subject "docs: sync gap-register Markdown with JSON state - MG-G11 evidence, MG-OBS-5/MG-OBS-6 rows (AC-7)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson).
- **Classification:** GOVERNANCE-ONLY (`docs/state/**`) — documentation synchronization only; no code, no owner decisions.
- **Root cause (recorded):** the AC-5/AC-6 `str.replace` edits against `MIGRATION_GAP_REGISTER.md` silently no-op'd — the search strings did not match the file ("covers **the** migrated surface" vs the file's "covers migrated surface"; the MG-OBS-4 row text differed from the replace's expectation). The JSON twins were updated correctly and are tool-validated; the human-readable Markdown lagged. This commit synchronizes the Markdown to the already-validated JSON state. **The JSON is and remains the authority; no JSON value changed in this commit.**
- **Changes:** (1) MG-G11 row now records the AC-6 real-PG evidence — `CURRENT_RUNTIME_VERIFIED`; 23 batteries; forward + reverse = 46 executions; 0 failures; 0 skips; migrations `0001…0022` applied; second migration run applied 0; PostgreSQL 17.11 used (disposable local cluster); PG16 remains the GHA-proven / compose target. (2) MG-OBS-5 and MG-OBS-6 rows added to §E — both already present in the JSON twin since AC-5/AC-6. No other row touched; no historical audit altered; gap counts unchanged (JSON: 28 OPEN / 16 PARTIAL / 6 CLOSED, total 50).
- **Impact on migration state:** none — pure Markdown/JSON agreement fix; all statuses and verification states were already authoritative in JSON and are unchanged.
- **Evidence:** `node tools/agent-context.mjs` → OVERALL: CURRENT (before and after); `bash tools/secret-scan.sh` → PASS (0 findings); `git diff` limited to `docs/state/MIGRATION_GAP_REGISTER.md` + this CHANGE_LOG entry; `tools/pg-smoke.ts` untouched; legacy untouched at `edede31`.
- **Authorization:** owner instruction 2026-09-26 (documentation-synchronization task; MG-G11/MG-OBS-6 specified; MG-OBS-5 included as the same defect class discovered during inspection and reported in the evidence).

## AC-8 — 2026-09-26 · PR #8 merged to main — verified baseline advanced

- **Commit:** this entry's commit — subject "gov: record PR #8 merge and advance verified SHA (AC-8)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson).
- **Event:** **PR #8 merged into `main`** (owner-authorized 2026-09-26). Merge method: **merge commit** (repository convention, matching PR #7; no squash, no rebase, no history rewrite). Merge commit: `ab0eed790fa8ffc160bc53e34264a61b02ffaedb` ("Merge pull request #8 from veloratrade/governance/agent-context"), parents `ffcb0e9` (main) + `75ddf5c` (branch HEAD). PR #8 state: closed/merged; the full 10-commit governance/evidence history is preserved on `main`.
- **Classification:** GOVERNANCE-ONLY (`docs/state/**`). The merge introduced no application-path changes beyond the reviewed comment-only citation fix already carried by the branch (MG-DOC-4); `tools/pg-smoke.ts` unchanged; legacy untouched.
- **Impact on migration state:** none to gap rows, decisions, evidence, gap counts (28 OPEN / 16 PARTIAL / 6 CLOSED), or audit hashes. `current_verified.modern_sha` advanced `59047b8` → `ab0eed7` per the established curation procedure (AC-3 precedent), clearing the DRIFTED verdict that the unlogged merge commit correctly produced. All AC-1…AC-7 evidence remains valid: the intervening commits are governance-only and merge-bookkeeping, which do not invalidate recorded evidence (CURRENT_STATE.md §4 drift policy).
- **Evidence:** `node tools/agent-context.mjs` pre-curation → DRIFTED (sole cause: unlogged merge commit `ab0eed7`, classified gov); post-curation → CURRENT. `bash tools/secret-scan.sh` → PASS (0 findings). Audit SHA-256 integrity OK (tool-verified). Working tree clean; legacy at `edede31`.
- **Authorization:** owner instruction 2026-09-26 (AC-8 state-curation-only task; single authorized commit).

## AC-9 — 2026-10-03 · MG-OBS-6 fixed: pg-smoke S1b drift-proof expectation (charter wave 1, task 1)

- **Commit:** this entry's commit — subject "fix(tools): pg-smoke S1b derives migration expectation from db/migrations (MG-OBS-6, AC-9)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-obs-6-pg-smoke-expectation` (charter §5; no direct-`main` implementation).
- **Classification:** TEST-TOOLING + STATE (`tools/pg-smoke.ts`, `docs/state/**`). No application code, no schema, no contract change.
- **Change:** S1b's hard-coded D1-era list `[0001..0005]` replaced by an expectation **derived from `db/migrations/`** (sorted `.sql` filenames, floor assertion ≥ 22 files) — the smoke can no longer drift behind the tree. Header check-list line updated accordingly.
- **Evidence (executed 2026-10-03 on this branch, fresh disposable cluster):** `DATABASE_URL=… npx tsx tools/pg-smoke.ts` → **PASS S1a…S9, ALL CHECKS PASSED** (S1b: `0001_core.sql…0022_legacy_contract_parity.sql applied (22 files)`; S1c idempotency no-op). **PG 17.11 caveat (not PG16).** Gates: clean-rebuild typecheck **0 errors** (a stale-`*.tsbuildinfo`/missing-`dist` sandbox artifact produced TS6305 first — resolved by `tsc -b --clean` + rebuild; environmental, not a regression; noted for session recovery) · local battery **804/804, 0 fail/0 skipped** · migration tests **19/19** · secret-scan **PASS 0 findings** · agent-context integrity OK.
- **Impact on migration state:** **MG-OBS-6 → CLOSED** (gap counts: 27 OPEN / 16 PARTIAL / 7 CLOSED). MG-G11's D1-smoke caveat is satisfied; MG-G11 remains PARTIAL (coverage scope unchanged).
- **Authorization:** Autonomous Execution Charter 2026-10-03 §4 task 1 (A-class); fix previously owner-gated — the charter's explicit task list authorizes it.

## AC-10 — 2026-10-03 · Worker one-tick runtime proof; MG-OBS-7 first-cron crash found and fixed (charter wave 1, task 2)

- **Commit:** this entry's commit — subject "fix(worker): cron-fired ticks carry a full job descriptor; malformed jobs DLQ not crash (MG-OBS-7, AC-10)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-obs-7-worker-tick-descriptor`, stacked on `feat/mg-obs-6-pg-smoke-expectation` (charter §5; no direct-`main` implementation).
- **Classification:** WORKER RUNTIME FIX + TESTS + STATE (`apps/worker/src/**`, `db/tests/pgBossAdapter.pg.test.ts`, `docs/state/**`, `docs/evidence/**`). No schema, no contracts, no API, no owner decisions.
- **What happened:** the charter's local one-tick proof booted the real worker against real PostgreSQL and the FIRST dispatched tick job killed the process (`safeDlqReason("NO_HANDLER", undefined)` → TypeError → unhandled rejection → exit 1). Root cause: pg-boss schedules were registered without job data, and the timekeeper copies the schedule's `data` verbatim into fired jobs — so every cron-fired tick arrived with an empty descriptor. The worker would have died on its first real cron fire (analytics hourly at :20, FX daily, MetaAPI sync tick). No cron tick had ever executed anywhere (worker undeployed), so only a runtime proof could surface this.
- **Fix (MG-OBS-7):** (1) `pgBossAdapter.schedule()` passes a complete maintenance-policy `JobDescriptor` as the schedule data; (2) `runner.ts` + `safeError.ts` dead-letter descriptor-less jobs with reason `NO_HANDLER:unknown` instead of crashing. Full record: `docs/evidence/WORKER-ONE-TICK-RUNTIME-PROOF-2026-10-03.md`.
- **Evidence (executed 2026-10-03 on this branch, disposable PG 17.11):** pre-fix crash reproduced (process exit 1) → post-fix: malformed job inserted into a live polled queue → `job.no_handler jobClass=unknown` logged, **process alive**; real pg-boss timekeeper fired the analytics tick (cron accelerated to `* * * * *`, adapter-written data preserved verbatim) → `scheduler.analytics_tick count=1` → `job.done analytics.recompute-tick` (idempotencyKey `tick:analytics.recompute-tick`) → `analytics.recomputed count=1` → `job.done analytics.recompute-daily` (key `analytics:daily:1:2026-10-03T19`) → `user_analytics_daily` row materialized (user 1, trades_count 1, net_pnl 493.50); `SIGTERM` → `worker.shutdown` logged. **PG 17.11 caveat (not PG16); superuser role caveat (not least-priv velora_worker); FX tick not fired (live ECB call — charter-excluded); MetaAPI tick token-gated; copy tick no transport.**
- **Gates:** typecheck **0 errors** (clean rebuild) · local unit battery **ALL TEST FILES PASSED** (0 fail, 0 skipped) · `db/tests/pgBossAdapter.pg.test.ts` on real PG **16/16** (3 new MG-OBS-7 subtests) · secret-scan **PASS 0 findings**. Migration tests not rerun (no `db/migrations` change).
- **Impact on migration state:** **MG-OBS-7 → CLOSED** (new §E row; gap counts: 27 OPEN / 16 PARTIAL / 8 CLOSED, total 51). MG-G09 + MG-WORKER-DEPLOY: verification advanced to `RECORDED_RUNTIME` (local analytics tick proven; both remain **OPEN** — deployment is OD-AC-WORKER owner-gated). MG-G11 unchanged (coverage scope unchanged).
- **Authorization:** Autonomous Execution Charter 2026-10-03 §4 task 2 (A-class runtime evidence + defect fix; fix-and-re-verify per charter failure policy).

## AC-11 — 2026-10-03 · First real backup + restore drill (local disposable; MG-BACKUP-RESTORE → PARTIAL) (charter wave 1, task 3)

- **Commit:** this entry's commit — subject "evidence(backup): local disposable backup + restore drill on real PG 17.11 (MG-BACKUP-RESTORE, AC-11)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-backup-restore-local-drill`, stacked on `feat/mg-obs-7-worker-tick-descriptor` (charter §5).
- **Classification:** EVIDENCE + STATE ONLY (`docs/evidence/**`, `docs/state/**`) — no code change; the drill exercised existing tooling (`ops/backup/create_pg_backup.sh`, `backup_gate.py`, `pg_restore`) exactly as shipped.
- **Drill (per `infra/backup/DR-RUNBOOK.md` dev/staging procedure, disposable local PG 17.11):** real producer run → backup `db-backup-staging-20261003192242-bdf0265c449e`, sha256 `5b3455636e7b39d59e0dfed90e04848646d5141a4769eefaaf67887fe904ef9a`, 31,969 bytes, INTEGRITY_VERIFIED, storage_status=NONE (honest). Gate on the real evidence → **FAIL exit 1** (fail-closed proven against real producer output, not fixtures). Artifact re-read + re-hash → MATCH. `pg_restore` into fresh disposable DB → **exit 0, 199 ms**; `schema_migrations`=22, `users`=1, `trades`=1, `user_analytics_daily` exact aggregate `(1, 2026-09-13, 1, 493.50)`, `pgboss.schedule` descriptors preserved; **per-table content hashes ALL MATCH**. Drill DB dropped; no dump bytes committed.
- **Caveats (recorded in the evidence file):** "staging" is the producer's only non-production label — the environment was the disposable LOCAL cluster, not Railway staging; no official storage/upload (nothing claimed); no API-level `GET /health` (row-level recovery proven; API check belongs to a staging drill); PG 17.11 not PG16; superuser role.
- **Gates:** backup suite 167/167 Python tests PASS; secret-scan PASS 0 findings (pre-commit); no code touched → typecheck/battery not rerun for this commit (unchanged tree `821f92b` + docs).
- **Impact on migration state:** **MG-BACKUP-RESTORE OPEN → PARTIAL** (gap counts: 26 OPEN / 17 PARTIAL / 8 CLOSED); MG-G13 verification → `RECORDED_RUNTIME (local)` — both remain open for staging/production backup, official storage, RPO/RTO, ADR-012 A.6 wiring.
- **Authorization:** Autonomous Execution Charter 2026-10-03 §4 task 3 (A-class local evidence; hard boundaries respected — no production, no network upload, no deploy).

## AC-12 — 2026-10-04 · Evidence-precision correction to AC-10 (MG-OBS-7 DLQ wording; owner-directed)

- **Commit:** this entry's commit — subject "docs: precision correction to AC-10 evidence - MG-OBS-7 DLQ persistence wording (AC-12)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `docs/mg-obs-7-evidence-precision`.
- **Classification:** GOVERNANCE/EVIDENCE ONLY (`docs/evidence/**`, `docs/state/**`) — no code, no tests, no behavior change.
- **What changed:** the AC-10 evidence record and the MG-OBS-7 register rows previously said the runner "dead-letters descriptor-less jobs". Per the owner's evidence-discipline instruction (2026-10-04), three facts are now strictly distinguished: (1) the no-handler/error **path** executed (live log evidence `job.no_handler jobClass=unknown`); (2) the **process survived** (live evidence); (3) **physical persistence into `velora.dlq` is NOT claimed for the live malformed job** — its final DB state was not inspected on the live cluster. What IS proven, by direct SQL in the real-PG integration test: the raw-inserted malformed job is terminally failed **in place** (`state='failed'`, `output={dlq:true, reason:"NO_HANDLER:unknown"}`, never redelivered) because a raw row carries no `dead_letter` target; physical `velora.dlq` routing is proven **only for `send()`-enqueued jobs** (pre-existing exhaustion test), and the runner's `deadLetter()` call is proven to physically move the job only on MemoryQueue (unit test).
- **Impact on migration state:** none to statuses or counts (27→26 OPEN etc. unchanged; MG-OBS-7 remains CLOSED with sharper evidence wording).
- **Authorization:** owner message 2026-10-04 ("IMPORTANT: do NOT claim that the malformed job was physically persisted into the DLQ unless the evidence explicitly proves physical DLQ storage").

## AC-13 — 2026-10-04 · MG-RANGE-GUARD implemented: runtime PnL range guard (legacy assertFits port) (charter wave 1, task 4)

- **Commit:** this entry's commit — subject "feat(domain): runtime PnL range guard - legacy assertFits port (MG-RANGE-GUARD, AC-13)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-range-guard`, stacked on `docs/mg-obs-7-evidence-precision` (charter §5; no direct-`main` implementation).
- **Classification:** DOMAIN + API + TESTS (`packages/domain/src/pnl.ts`, `apps/api/src/trades/tradeService.ts`, two test files). No schema, no migrations, no contracts change, no owner decisions — the limits are derived verbatim from the legacy source (READ-ONLY) and the audit §9.1 row.
- **Change:** `computePnl` returns a new explicit `out-of-range` result kind when a calculated value cannot fit the supported range — the port of legacy `PnlCalculator::assertFits` (`/\A-?\d{1,N}(?:\.\d{1,F})?\z/D`): **netPnl (legacy `profitLoss`) 16 integer / 8 fraction digits, rMultiple 10/8** — checked on the final rescaled strings, net first (legacy assert order, so out-of-range shadows undefined-risk exactly as the legacy throw did). The limits are stricter than the modern storage columns (`trades.net_pnl NUMERIC(20,2)` = 18 integer digits, `r_multiple NUMERIC(20,8)` = 12), so a passing value always fits the schema. `tradeService` maps the kind to the legacy `ApiException` vocabulary at BOTH call sites (create + exit recompute): **422 `VALIDATION_FAILED`, details `code: OUT_OF_RANGE`, `messageKey: errors.validation.range`, field `profitLoss`/`rMultiple`** (field mapped to the API vocabulary, which — like the legacy error — says `profitLoss`).
- **Deliberate mechanism divergence (documented in code):** legacy throws `ValidationException`; modern returns a result kind so the type system forces every caller to handle the branch — the same house style the audit itself notes ("modern makes the branch explicit"), and the reason `undefined-risk` is a kind.
- **Evidence (executed 2026-10-04 on this branch):** domain **17/17** (6 new boundary tests: 16-integer-digit net passes / 17 rejected; negative sign not counted as a digit; out-of-range net shadows undefined-risk; r-multiple 10 digits passes / 11 rejected — vectors constructed so risk survives the scale-2 rescale: riskDelta 1e-8 × volume 1e6 = 0.01) · service **28/28** (3 new integration tests: create net overflow ≈1e30 from individually-valid 10,8 inputs; create r-multiple overflow 1e10; exit recompute overflow ≈1e21) · full local battery **ALL TEST FILES PASSED** (re-run after correcting an invalid test-mode string caught by typecheck — `"parity"` → `"bcmath-truncate"`; environmental authoring slip, not a regression) · typecheck **0 errors** · secret-scan **PASS 0 findings**. No DB change → migration tests not applicable; no real-PG behavior touched (guard is pure domain logic).
- **Impact on migration state:** **MG-RANGE-GUARD OPEN → CLOSED** (gap counts: 25 OPEN / 17 PARTIAL / 9 CLOSED, total 51). MG-G04's §9.1 range-guard dimension is satisfied; the **r-multiple SCALE divergence (4 vs 8) remains open as MG-RMULTPLE-SCALE/MG-RMULTIPLE-SCALE and is NOT touched** (parity scale change is a financial-semantics question for the owner). Audit §9.1 table itself remains immutable.
- **Authorization:** Autonomous Execution Charter (owner message 2026-10-04, task 4; A-class — closure criteria "Guard implemented", no owner decision required).

## AC-14 — 2026-10-04 · JalaliCalendar ported to packages/domain (MG-DOMAIN-LEGACY-ONLY → PARTIAL) (charter wave 1, task 5)

- **Commit:** this entry's commit — subject "feat(domain): Jalali calendar port - legacy JalaliCalendar parity (MG-DOMAIN-LEGACY-ONLY, AC-14)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-domain-legacy-only-jalali`, stacked on `feat/mg-range-guard` (charter §5).
- **Classification:** DOMAIN + TESTS (`packages/domain/src/jalali.ts` NEW, `jalali.test.ts` NEW, `index.ts` +1 export). No API/schema/contracts change, no owner decisions.
- **Change:** the legacy `JalaliCalendar.php` (Phase 3) ported as a pure, IO-free domain module — `gregorianToJalali` verbatim; `jalaliToGregorian` + `isJalaliLeap` ported verbatim from `TradeTimeNormalizer` (the legacy single algorithm owner — legacy delegated to avoid duplicate math; the modern side keeps the same single-owner shape); `isGregorianLeap`, `formatJalaliDate` (sprintf padding semantics). Contract preserved: DISPLAY/HELPER ONLY, never part of canonical-time resolution. Cosmetic documented divergence: named fields instead of PHP arrays.
- **Evidence discipline — the port was verified against the ACTUAL legacy PHP (executed 2026-10-04, PHP 8.4.26, algorithms copied verbatim to a /tmp harness; the legacy repo itself untouched):** spot vectors J1/J2/J4 reproduce identically. The verification **disproved the legacy header's own claim**: "round-trips are stable for 1925..2124 (jy 1304..1503)". Measured (legacy PHP itself): gregorian-first round-trips EVERY day of **2000..2100** and drifts in 1901..1999 / 2101..2160 (47,116 failing days in 1900..2130); jalali-first round-trips **jy 1379..1478** except Esfand-30 of the 9 in-window leap years {1382, 1407, 1411, 1415, 1440, 1444, 1448, 1473, 1477}. Decision (parity over correction): the port reproduces legacy **verbatim**, including the drift — changing the algorithm would alter legacy display output (an owner decision, recorded in the register row). Tests pin both the clean-window edges (full-day sweeps of 2000 and 2100) and the out-of-window drift vectors (e.g. 1925-01-01 → 1303/10/11 → 1924-12-31; 1407/12/30 → 2029-03-20 → 1408/01/01) so any future change is loud.
- **Gates:** domain tests **11/11** (J1–J8 legacy vectors, full-day sweeps 2020..2030 + 2000/2100, leap vectors, parity pins) · full battery **ALL TEST FILES PASSED** (includes the new file) · typecheck **0 errors** · secret-scan **PASS 0 findings**.
- **Impact on migration state:** **MG-DOMAIN-LEGACY-ONLY OPEN → PARTIAL** (24 OPEN / 18 PARTIAL / 9 CLOSED). Jalali dimension done; `TradingSessionEngine` + achievements remain (next charter tasks).
- **Authorization:** Autonomous Execution Charter (owner message 2026-10-04, task "Jalali domain port"; A-class).

## AC-15 — 2026-10-04 · TradingSessionEngine ported to packages/domain (MG-DOMAIN-LEGACY-ONLY, session dimension) (charter wave 1, task 6)

- **Commit:** this entry's commit — subject "feat(domain): TradingSessionEngine port - legacy parity with DST-aware windows (MG-DOMAIN-LEGACY-ONLY, AC-15)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-domain-legacy-only-session-engine`, stacked on `feat/mg-domain-legacy-only-jalali` (charter §5).
- **Classification:** DOMAIN + TESTS (`packages/domain/src/tradingSession.ts` NEW, `tradingSession.test.ts` NEW, `index.ts` +1 export). No API/schema/contracts change, no owner decisions.
- **Change:** legacy `TradingSessionEngine.php` + `SessionWindow.php` (Phase 3) ported as a pure domain module: classify(canonicalUtc | null) → explicit status (`unconfigured`/`unresolved`/`invalid`/`outside`/`open`) + matched sessions + `hourUtc`/`dayOfWeekUtc`/`engineVersion`/`windowCount`. Hard rules preserved verbatim: the engine NEVER invents windows (no configuration → `unconfigured`, empty sessions — the legacy fixed-UTC marketing copy is deliberately NOT wired in); windows reference explicit IANA zones; sessions are derived from canonical UTC and never fed back into canonical-time resolution. `SessionWindow` validation ported (id/label/minutes/daysOfWeek/priority rules; fixed offsets and abbreviations like `EST`/`GMT+3` rejected — legacy `TimezoneResolver::isValidIana` port).
- **Mechanism (documented divergence):** DST via the platform timezone database through `Intl.DateTimeFormat` with explicit `timeZone` + fixed `en-US` locale (legacy used PHP `DateTimeZone`); UTC epochs are compared, wall→UTC conversion uses two-probe offset refinement across DST edges. IANA admission = the runtime's canonical Intl zone set (legacy admitted `ALL_WITH_BC`; canonical zones behave identically, the surface is strictly cleaner). Input requires the exact canonical `YYYY-MM-DD HH:MM:SS` shape.
- **Evidence:** tests **19/19** (legacy golden vectors S1–S21 ported: unconfigured/unresolved/invalid, overlap, inclusive-open/exclusive-close boundaries, summer + winter DST, weekday filter, cross-midnight incl. early-hours-from-yesterday, config validation). **Plus a direct cross-check (2026-10-04): the ACTUAL legacy PHP classes (READ-ONLY require, PHP 8.4.26) and this port produce IDENTICAL output on all 14 classification vectors** — `2026-08-31 12:00:00|open|london,newyork|12|1`, DST-winter variants, boundary minutes 06:59/07:00/15:29/15:30, Sunday-filter, cross-midnight 03:00/05:30/06:30/07:30 — byte-for-byte equal (diff clean).
- **Gates:** domain tests 19/19 · full battery **ALL TEST FILES PASSED** (includes the new file) · typecheck **0 errors** · secret-scan **PASS 0 findings**.
- **Impact on migration state:** MG-DOMAIN-LEGACY-ONLY remains **PARTIAL** (24 OPEN / 18 PARTIAL / 9 CLOSED) — Jalali + session dimensions done; achievements engine port remains (next charter task).
- **Authorization:** Autonomous Execution Charter (owner message 2026-10-04, task "TradingSessionEngine"; A-class).

## AC-16 — 2026-10-04 · Achievements engine ported to packages/domain (MG-DOMAIN-LEGACY-ONLY, achievements dimension) (charter wave 1, task 7)

- **Commit:** this entry's commit — subject "feat(domain): achievements engine port - legacy repository semantics + catalog (MG-DOMAIN-LEGACY-ONLY, AC-16)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-domain-legacy-only-achievements`, stacked on `feat/mg-domain-legacy-only-session-engine` (charter §5).
- **Classification:** DOMAIN + TESTS (`packages/domain/src/achievements.ts` NEW, `achievements.test.ts` NEW, `index.ts` +1 export). No API/schema/migration change, no owner decisions.
- **Change:** legacy `UserAchievementRepository` (READ-ONLY source-read 2026-10-04) ported at the domain level: the complete two-definition catalog legacy actually ships — `FIRST_TRADE` (unlocked by TradeService after the first created trade) and `EMAIL_VERIFIED` (unlocked by AuthService after verification), each with its legacy i18n keys; `normalizeAchievementKey` (mb_strtoupper/trim parity); the exact `metadata_json` field set/order and timestamp formats (`gmdate('Y-m-d H:i:s')` for `achieved_at`, `gmdate('c')` — `+00:00`, no milliseconds — for `unlockedAt`); the **idempotent first-unlock decision** (false when already unlocked, no second insert); **fail-silent error semantics** (legacy `catch (Throwable)` — preserved deliberately and documented: an achievement must never break its caller's flow); `listForUser` with degrade-to-[] parity. Storage is the injected `AchievementStore` port — the domain stays IO-free per house rules. The achievements EMAIL is not ported here (notification concern; the `achievement_notifications` email flag already survives in modern, and sending is a live-service boundary).
- **Evidence:** domain tests **11/11** (catalog exactness, normalization, timestamp formats, metadata byte-shape, idempotent unlock, per-user isolation, fail-silent exists/insert/list failures, malformed-metadata degrade) · full battery **ALL TEST FILES PASSED** · typecheck **0 errors** · secret-scan **PASS 0 findings**.
- **Impact on migration state:** MG-DOMAIN-LEGACY-ONLY stays **PARTIAL** (24 OPEN / 18 PARTIAL / 9 CLOSED) — all three §9.3 dimensions (Jalali, TradingSessionEngine, achievements) now have domain ports; what remains is the product-integration layer (user_achievements storage via an additive migration, unlock triggers at the first-trade/email-verification call sites, and the achievements email), which is API/product surface, tracked here and related to MG-G01.
- **Authorization:** Autonomous Execution Charter (owner message 2026-10-04, task "achievements domain port"; A-class).
