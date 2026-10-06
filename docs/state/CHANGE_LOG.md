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

## AC-9 — 2026-10-04 · Telegram journal client implemented on a branch (ADR-018) — later pushed, not merged

- **Branch:** `feat/telegram-journal-client`, created from `main` @ `0e9c4d7e6e1f984287490ce02f5681c208e35c7a` (verified baseline `ab0eed7` + the AC-8 curation commit). **Pushed 2026-10-04 with the later phases (the branch tip is read back with `git fetch` + `git rev-parse` in AC-15); not merged** — PR #9 is open against `main`. `current_verified.modern_sha` is therefore **deliberately NOT advanced**: it records what is verified on `main`, and nothing here is on `main`. Running `tools/agent-context.mjs` on this branch correctly reports `DRIFTED` (application-path commits since `ab0eed7`) — that verdict is the tool doing its job, not a state defect.
- **Commits on the branch (5):**
  - `e0887afc59a7dd9ad38d78fc47e0e644510bf04c` — `feat(telegram): decision record, migration 0023 and the domain foundation`
  - `55ac1e4512b08481e033115247a437df810dc1e8` — `feat(telegram): bot, update pipeline, linking service, HTTP surface and AI seam`
  - `745d6418e888c89d48a2b75f40f9855a07457c57` — `test(db): migration 0023 constraints and the real PgTelegramStore statements`
  - `e8d8d045b103c08dc56e0ad7f8b8364f9c17e18d` — `feat(web): Settings -> Telegram connection (website-first linking)`
  - `e6d861a5c3c62bedcfc42daa0dc73efb1263dc01` — `docs(telegram): operator guide, design map and security notes`
  - this entry's commit is the sixth, self-referential by exact ASCII subject: `state: record the AC-9 Telegram branch, gap rows and evidence battery`.
- **Classification:** APPLICATION-PATH (new capability: `apps/api/src/telegram/**`, `apps/api/src/journal/**`, `apps/api/src/aicoach/{mediaInterpreter,geminiProvider}.ts`, `apps/web/{src/app/(app)/settings, messages/*/telegram.json}`, `db/migrations/0023`, `db/tests/telegram*`, `packages/{contracts,domain}/src/{telegram*,journalExtraction,time}`) plus governance paths (`docs/adr/ADR-018`, `docs/telegram/**`, `docs/state/**`). Existing files touched only where the new capability must attach: `kernel/server.ts` (one capability slot), `routes/extendedRoutes.ts` (one handler entry), `server-main.ts` (one composition block inside `if (pool !== undefined)`), `auth/auditStore.ts` (vocabulary widened to match 0023 §7), `aicoach/{aiProvider,aiCoachService,aiCoachRoutes}.ts` (feature discriminator for `ai_coaching_logs.feature`).
- **Decision record:** `docs/adr/ADR-018-telegram-journal-client.md`. It records what was deliberately NOT built, which is the part future sessions are most likely to re-propose: no `journal_entries` table (the journal remains the ADR-002 ledger reached through `TradeService`), no second auth system, no separate Telegram database, no n8n relay transport (it does not exist in Modern — see MG-TG-2), and no second update-stream consumer.
- **Migration impact:** `0023_telegram_journal.sql` (6 mutable tables, widened audit vocabulary 7→13 actions and `provider ∈ {METAAPI, TELEGRAM}`, `ai_coaching_logs.feature` NOT NULL DEFAULT `'coach'`). Every new table is mutable, so §5 of `db/roles.sql` requires no new append-only REVOKE. Additive: no existing column or row is rewritten, and no other feature reads these tables.
- **Evidence (all captured against the branch HEAD above; commands re-runnable):**
  - `npm run typecheck` → **exit 0** (built after clearing stale `*.tsbuildinfo` state, which had been restored without its `dist/` outputs).
  - `node tools/run-tests.mjs` → **945/945 passed, 0 failed, 0 cancelled, 0 skipped** (~180 s), including `db/tests/telegramJournal.test.ts` (6) and the new `db/tests/telegramStoreAdapter.test.ts` (7). Baseline was **851/851** after the Phase E wiring — the delta is the Phase F batteries.
  - `bash tools/secret-scan.sh` → **PASS (0 findings)**. Two test files were found carrying key-shaped STRINGS during development; both were rewritten to non-credential shapes rather than allow-listed.
  - `npx next build` (apps/web) → **exit 0**, with `/settings` and `/en/settings` in the route table.
  - `tools/agent-context.mjs` → `DRIFTED` on this branch, by design (see the first bullet); `main` is untouched.
- **Fixes found by writing the tests (not cosmetic):** the poller reset its backoff after a successful *read* even when the batch then threw, so a persistently failing update was retried once a second forever; the analysis payload's declared sample bound (25) was unreachable because the journal read path clamps to 20, so the constant documented a weaker guarantee than the code delivered; the update pipeline reported the update-id string as the update `kind`, and the poller bypassed the pipeline's schema validation entirely (a schema-invalid update would have stalled the stream forever while the offset refused to move). All three are fixed and pinned by tests.
- **Gaps opened:** `MG-TG-1` (no live round trip — no bot token, no provider credential, no deployed webhook), `MG-TG-2` (n8n relay not implemented), `MG-TG-3` (synchronous API-process processing; no worker path). Gap register JSON + Markdown updated together; totals now **31 OPEN / 16 PARTIAL / 6 CLOSED = 53**.
- **What is NOT claimed:** nothing here is pushed, merged, deployed, or verified against live Telegram or Gemini services. The atomic-claim guarantees rest on single-statement SQL plus PGlite (single-session) evidence, not on a race observed against a real server. `docs/telegram/DEPLOYMENT.md` §7 lists the full set.
- **Authorization:** owner instruction (implement the complete Telegram journal client as a first-class client; do not push unless the workflow permits).

## AC-10 — 2026-10-04 · Telegram finalization: audit round two, real-PostgreSQL concurrency, one canonical web surface

- **Branch:** `feat/telegram-journal-client` (unchanged base `main` @ `0e9c4d7e6e1f984287490ce02f5681c208e35c7a`). **Later pushed 2026-10-04; not merged, PR #9 open.** This entry records work done BEFORE the push gates were evaluated (AC-15 records the push itself). `current_verified.modern_sha` remains `ab0eed7` for the same reason as AC-9: nothing here is on `main`.
- **Commits added by this round (three, in the order the directive prescribed):**
  - `3dbd72d` — `web(telegram): one canonical Telegram surface inside the account page` (UX)
  - `6b08c62` — `fix(telegram): enforce the declared limits and bound every input` (security)
  - this entry's commit — `test/docs: real-PostgreSQL concurrency battery, catalog render guard and state records`
- **Why the round happened:** the feature was `IMPLEMENTED + TESTED + COMMITTED` after AC-9. An evidence-first audit then found three claims that the code did not support and one UX structure that contradicted the single-canonical-surface decision. Details and fixes are in `docs/adr/ADR-018-telegram-journal-client.md` (Amendment 1) and `docs/telegram/SECURITY.md` §5a/§7/§9.
- **Security findings (all fixed, all now pinned by tests):**
  1. `telegram:journal` (20/h) and `telegram:analyze` (8/h) were declared in the frozen contract and described in `SECURITY.md` but **enforced nowhere**. Both are now checked before the work they bound (media download / provider call), and a test exhausts each key and asserts the expensive work never happened. Contract values unchanged — nothing was loosened to make a test pass.
  2. The media path ignored `getFile`'s declared `file_size`, so an oversized file was fetched in full before the API layer's cap refused it. The declared size is now checked first (5 MiB); the post-download measurement stays.
  3. The webhook ingress used the kernel's 1 MiB JSON default. It is now 256 KiB, refused before the pipeline with the platform's existing oversized-body contract (400 `VALIDATION_FAILED`).
- **UX decision (recorded because it changes a claim, not a capability):** `/settings` remains the ONE canonical Telegram surface, now titled as the account page with a "Connected accounts" section; the sidebar nav item is labelled with the page's own name instead of the feature's, and the signed-in user card became a `<Link>` to that surface (it was plain `div`s, so the account chrome had no path to the account screen). **No existing user capability was removed**; the only catalog change is three ADDED keys per locale.
- **Real-PostgreSQL evidence (this is the round's headline):** `db/tests/telegramConcurrency.pg.test.ts` — **9/9 on PostgreSQL 16.15** (PGDG build, disposable local cluster, `initdb` + trust auth, `DATABASE_URL` only): the one-time link token is spent exactly once (two identities race one token; a variant FORCES the interleaving by holding the row lock in a third session), the same identity double-sending still yields one link, an expired token cannot be spent late, and `claimUpdate` / `claimDraftForConfirmation` / `claimChannelPost` each admit exactly one winner. In the same environment and cluster: D1 smoke **S1–S9 ALL PASSED on a fresh database with all 23 migrations applied**, trade-concurrency battery **14/14**, the seven store/capability batteries **47/47**, and the new Telegram battery 9/9 — **70 real-PG tests in total**, plus the S1–S9 smoke. No production statement was weakened to make any of this pass; PGlite is still never described as concurrency evidence.
- **Apparatus defect found and fixed (MG-OBS-6, closed):** `tools/pg-smoke.ts` asserted a hard-coded `[0001..0005]` migration list, so the D1 smoke failed on every database since the sixth migration — which would have stopped `.github/workflows/postgres-evidence.yml` at step one and prevented the new battery from ever running. **The owner had already pushed an equivalent fix on `feat/mg-obs-6-pg-smoke-expectation` (`9d59bca`, not merged).** This branch therefore carries the owner's EXACT file content (verified byte-identical with `diff`) instead of a competing implementation, so the two branches cannot conflict on that file. Both versions derive the expectation from `db/migrations/`; the owner's adds a `>= 22` floor that this branch retains. Verified here: `npx tsx tools/pg-smoke.ts` → **S1–S9 ALL PASSED** on fresh PostgreSQL 16.15 with 23/23 migrations.
- **Battery (local, this round):** `npm run typecheck` → exit 0; `node tools/run-tests.mjs` → **957/957, 0 failed, 0 cancelled, 0 skipped** (baseline 945/945 at AC-9; delta = 6 new bot-wiring tests + 6 new catalog render tests, the latter added because the Persian-string defect class this project already hit is a RESOLUTION-time defect that source inspection cannot catch); `bash tools/secret-scan.sh` → **PASS (0 findings)**; `npx next build` (apps/web) → **exit 0** with `/settings`, `/en/settings` in the route table. A live smoke of the web app against the API on PostgreSQL 16.15 registered a user and returned 200 for `/settings` and `/en/settings` with clean UTF-8 transport (the authenticated surface renders client-side, so that check proves boot + transport, not layout — stated plainly rather than implied).
- **Gaps:** `MG-OBS-6` closed; `MG-TG-4` opened and closed in the same round (the enforcement/bounds defects above); `MG-TG-1/2/3` remain as recorded.
- **What is still NOT claimed:** no push, no PR, no deployment, no live Telegram delivery, no live Gemini call, no staging verification. Those remain exactly where AC-9 left them, with provider credentials as the blocker.
- **Authorization:** owner finalization directive (2026-10-04) — audit, correct UX placement without redesign, validate security and PostgreSQL concurrency, run regressions, then push only if every gate passes.

## AC-11 — 2026-10-04 · Phases 1 and 2 landed on the branch: account surface, auth/security, RBAC map

- **Branch:** `feat/telegram-journal-client` (base `main` @ `0e9c4d7e`). **Later pushed 2026-10-04; not merged** (PR #9 open). The "not pushed" wording in AC-9…AC-13 was correct when written — each push then needed a fresh single-use PAT — and is corrected here to the state verified in AC-15; the branch is still not merged into `main`.
- **Why this entry exists:** the phase work below landed as APP commits while the ledger stopped at AC-10, so `tools/agent-context.mjs` reported them UNLOGGED. Recording them here is the repository's own rule (ADR-017), not a formality: an unlogged APP commit is evidence nobody can date.
- **Phase 1 — account / profile / settings (commits `2f60753`, `e5f84a0`, `a3bd138`):**
  - `2f60753` — locale **provenance** is now recorded (`users.locale_source`, `users.locale_updated_at`), so "why is this user in fa?" is answerable from the database instead of guessed from the current value.
  - `e5f84a0` — the account surface stops being a shell: a real **read-only `/profile`** built from live user data, **change password** (ACC-04) with the API's own validation and rate limit, **AI consent** (ACC-08) as an explicit stored decision, **e-mail preferences** (ACC-09) with merge semantics rather than replace, and the locale switch wired to the provenance column.
  - `a3bd138` — shell correctness: localized nav/chrome strings (no English leaking into the fa shell), an **SSR-stable locale toggle** (the first render and the hydrated render must not disagree, or React throws the tree away), and the RTL drawer behaviour.
  - One canonical location per capability was the constraint: `/settings` is the management surface, `/profile` is a read-only identity overview, no new top-level nav item, no `/account`, `/security` or `/integrations` route. **No existing user capability was removed.**
- **Phase 2 — auth / security / RBAC (commits `9fb8fe5`, `d6f6c94`, `cacaa34`, `865c111`):**
  - `9fb8fe5` — **SEC-02** (declare and ENFORCE the limiter per route; the limiter runs before capability checks so a brute force cannot outrun it), **SEC-03** (`auth_events`, append-only, fail-open write / fail-loud read), **SEC-04** (rotating refresh cookie `__Host-velora_refresh; Path=/; HttpOnly; Secure; SameSite=Strict`, CAS rotation) and a read-only `GET /api/v1/auth/session` probe.
  - `d6f6c94` — the **edge gate**: a protected HTML route is not served until the API confirms a live session; an unavailable API fails CLOSED (`gate-unavailable`) instead of open, and the refusal is a 302 to the locale's login with `no-store`.
  - `cacaa34` — **SEC-01**: Legacy's 24 permissions mapped to Modern capabilities, each with its meaning, owner, enforcement point and test (`docs/security/RBAC-CAPABILITY-MAP.md`).
  - `865c111` — the phase-2 delivery record (§17 of the capability audit) and the refreshed capability matrix.
  - Evidence: real-PostgreSQL batteries 26 files / 283 tests green at that point; a 6/6 visual battery with zero horizontal overflow (details in the audit doc §17).
- **Also recorded here (governance commits that were UNLOGGED):** `42f38cb` (AC-10 finalization report + push/PR record) and `f310bca` (Telegram docs: pinned final-HEAD battery, the not-built modules list). Neither changes application behavior.
- **What is NOT claimed:** no push, no deployment, no live provider calls. `current_verified.modern_sha` remains `ab0eed7` on `main` by design.

## AC-12 — 2026-10-04 · TRD-06 user-triggered sync (implemented on one shared window rule) + phase-3 web surfaces

- **Branch:** `feat/telegram-journal-client` (base `main` @ `0e9c4d7e`). **Later pushed 2026-10-04** with the later phases (AC-15); `main` untouched.
- **Commits this round:** `24733fa` (TRD-04: the trade list contract aligned with Legacy — page/limit/filters/ordering), `f3d1bdc` (test runner: the PGlite batch is serialized so the suite cannot fake-fail), `5724045` (web builds on webpack so it can bundle workspace TS sources), `050d881` (dashboard + trade journal on the real analytics API), `c703b88` (web guards, incl. the date-formatter crash), `73cc8b6` (TRD-06 backend), `9a34a9f` (TRD-06 tests incl. the real-PG battery), `ddfb01c` (test runner: re-run OS-killed files instead of reporting a red suite), `e0bfc2a` (web sync control + Persian-digit fix).
- **TRD-06 — what was missing and why it mattered:** Modern could REPORT sync state but had no way to ASK for one; only the hourly tick and a MetaAPI webhook could produce a sync job. `POST /accounts/{id}/sync` now exists: ownership-scoped (foreign and missing are the same non-disclosing 404), 202 `{status:"queued", dispatched, deduplicated, window}` on acceptance, 200 `up-to-date` when the cursor is already at/after now (no job invented for an empty window), 422 `METAAPI_REQUIRED` for an account with no provider link, 401 anonymous, 503 when the capability is unwired, and Legacy's dispatch-level throttle (20/300) — which had been documented as an unowned gap precisely because no route existed to bound.
- **The real defect the work uncovered (fixed):** the webhook ingress asked for a **24-hour** window while the scheduled tick asked for **12 months** for the same account, under the SAME idempotency key shape `sync:{accountId}:{from}` — a key that can only deduplicate jobs that agree on their window. "How much history do we import" therefore depended on which trigger fired. The window rule now lives once in `@velora/contracts` (`syncWindow`), used by all three producers; the pg-boss trigger is constructed once in the composition root and injected into both API-side producers; the durable `CONNECTING` marker exists once (`accounts/syncPending.ts`) instead of twice.
- **Evidence (this round):** `npm test` **991 + 63 = 1054 tests, 0 failed, 0 skipped** (two-batch runner); `npm run typecheck` clean; `npm run secret-scan` PASS (0 findings); `npx next build --webpack` → exit 0, **37 routes** in the route table (every page plus its `/en` variant) — the earlier "28" figure counted a pre-phase-3 build; real-PostgreSQL batteries `tools/run-pg-batteries.sh` → **27 batteries / 54 runs (forward AND reverse) / 0 failures**; TRD-06 runtime battery on real PostgreSQL + real queue → **16/16** (202/200/422/401/404, CONNECTING marker, a CONNECTED account not dragged backwards, `up-to-date` with no job, the pg-boss row present with identifiers only, 21st request 429); phase-3 web regression battery → **33/33** (fa RTL `/trades` with KPI 2 / 50% / +241.00 / 1.95 and the live preview closed-loop against the server's own R, en LTR dashboard with Total Trades 2 / +241.00 / 1.95 / Avg R 1.65, mobile 390 overflow 0); TRD-06 UI battery → **10/10** (fa + en click → 202, row reflects CONNECTING).
- **Defects found by inspection this round and fixed:** (1) the web dashboard and journal were fed by an INVENTED analytics contract hidden behind `??` fallbacks (zeros + a flat equity line instead of an error); (2) `fmtDateLong` merged caller components onto `dateStyle:"long"`, which Intl forbids — it threw inside a render and took `/trades` down to "This page couldn't load"; (3) the accounts page rendered Persian digits ("۱۴۰۵/۷/۱۲") against the Latin-digit product rule; (4) the trade form's controls had no `name`, so nothing could address them but their visible Persian labels.
- **Also fixed (harness):** `tools/run-tests.mjs` re-runs a test FILE that died by SIGKILL once, alone — the container OOM-killing an in-process WASM PostgreSQL is not a test result, and assertion failures are still never retried.
- **Gaps:** `MG-METAAPI-CADENCE` narrows to the cadence decision alone (manual trigger closed); `MG-WORKER-DEPLOY` gains runtime evidence that the queue path works and has no production consumer; `MG-AI-OCR` gains the TRD-03 recon result (the endpoint's deterministic half needs a real OCR engine — fail-closed, not stubbed).
- **What is NOT claimed:** no merge, no deployment, no live MetaAPI call (no platform token), no OCR engine (none on this host), no Telegram verification.

## AC-13 — Phase 4: data integrity & migration (2026-10-04)

**Commits (phase start `e2849ac`):** `492e3f5` (MG-RMULTIPLE-SCALE parity rule) ·
`ec2f94a` (0025 financial guards + 10 fixture alignments) · `1c847b8` (test-runner
verdict fix) · `a02a38d` (restore drill + evidence) · `b301596` (load rehearsal +
fixture + evidence) · docs commit.

**What this delivery establishes**

1. **`r_multiple` scale (MG-RMULTIPLE-SCALE) — CLOSED.** `packages/domain/src/legacyParity.ts`
   (+8 tests) fixes the comparison rule: imported values preserved BY VALUE, a
   historical recomputation compared at the legacy scale (4) with the legacy mode
   (`bcmath-truncate`). The mode is load-bearing: `1.000099999` truncates to
   `1.0000` but half-even rounds to `1.0001`.
2. **Financial invariants enforced by the database (PLT-02).** `db/migrations/0025_trade_financial_guards.sql`
   translates Legacy's `v0.3` guard list to the modern column set; a real-PG battery
   (9 tests) proves the migration ABORTS on a database holding a stale unresolved row
   (not recorded as applied, no half-guard left). Runtime probe 8/8 against the live
   API. 10 test files' fixtures were aligned (OPEN where no financial outcome was
   claimed, complete CLOSED where the real writer produces one) — no assertion weakened.
3. **A red suite can no longer be reported green.** The OOM-retry logic excused a
   batch that failed with zero OS kills; `tools/lib/testRunnerVerdict.mjs` (+9 tests)
   now requires every failure to be accounted for by a SIGKILLed, mappable file. Found
   because the 0025 run was `# fail 7` + `ALL TEST FILES PASSED` + `EXIT=0`.
4. **A real backup, restored and verified (MG-BACKUP-RESTORE → PARTIAL).**
   `ops/backup/restore_drill.mjs` (+13 tests): artifact 32 926 B / sha256 `b289558f…`,
   restored into a disposable database, parity PASS (44 tables, 49 numeric columns,
   exact decimal sums), smoke 11/11 on the restored copy → `RESTORE_VERIFIED`.
   The FIRST run failed and is kept as evidence (the smoke asserted a fresh apply,
   the wrong claim for a restored copy); `tools/pg-smoke.ts` gained
   `PG_SMOKE_SCHEMA=restored` asserting the ledger instead, and S2's incomplete trade
   fixture was completed. Offsite storage + production drill + RPO/RTO remain open.
5. **The load rehearsal runs and refuses (MG-DATA-MIGRATION → PARTIAL).**
   `tools/load_rehearsal.ts` + `tools/lib/legacyLoadGates.ts` (+12 tests) execute
   `docs/migration-strategy.md` §6: A-gates (vocabularies, money digits, symbol
   canonicalisation, time census, canonical-email uniqueness, referential integrity,
   v0.3 guards, and **A12**: every exported column declared or the load refuses),
   an id-preserving load, B-gates, and gate 6 (PnL recomputation under the legacy
   mode). Executed on a labelled SYNTHETIC fixture: exact row- and money-parity,
   quarantine recorded (never invented), 5/5 recomputations matched.
   **Finding:** Modern `subscriptions` (0017) is the Stripe object and is NOT a target
   for Legacy's provider-less lifecycle → those columns are recorded as unmapped with
   the reason; the decision is `OD-AC-SUBMAP`.
6. **Gates:** `npm test` 999+63 / 0 fail · real-PG batteries 27→**28 files** / 56 runs
   / 0 failures · typecheck clean · secret-scan PASS · smoke 11/11 in both modes.

**Evidence files:** `ops/backup/evidence/restore-drill-staging-20261004T095454Z.json`
(+ the failed run `…T095423Z.json`), `ops/backup/evidence/load-rehearsal-20261004T095828Z.json`,
`ops/backup/evidence/quarantine-legacy-export.FIXTURE.jsonl`,
`docs/audits/2026-10-04-PHASE4-STATUS.md`.

**Nothing was removed.** No legacy table, column or row was dropped, rewritten or
archived; no user capability was taken away.

**Push status:** pushed 2026-10-04 under the phase-by-phase push directive, together
with the phase-5 delivery; the remote tip is read back with `git fetch` +
`git rev-parse` and recorded in **AC-15**, the push-verification commit that follows
AC-14. The tokens are still never stored anywhere: each is used inline for one push.
Delivery state for AC-13: **PUSHED** — and nothing above it (no merge, no deploy).

## AC-14 — Phase 5: support (2026-10-04)

**Commit(s):** this delivery's commits on `feat/telegram-journal-client` (phase start
`1f6c4bb`).

**What this delivery establishes**

1. **The support capability is real, not a shell (GAP-SUP → IMPLEMENTED, TESTED).**
   Legacy's ticket center (`support/index.html` + `api/src/Support/*` +
   `v1.8_support_tickets.sql`) is migrated by capability: `db/migrations/0026_support_tickets.sql`
   (two tables, three functions, four indexes, five CHECK constraints),
   `apps/api/src/support/supportService.ts` (service + `PgSupportStore` +
   `MemorySupportStore`), `apps/api/src/support/supportRoutes.ts` (the user surface
   and `/admin/communications/tickets`), the kernel slot + `support:write` throttle
   (20/300), and `support.tickets.view` / `support.tickets.manage` on admin AND
   super_admin (Legacy `P_COMM_VIEW` / `P_COMM_REPLY`).
2. **Two axes, both SERVER-DERIVED.** `status` (open|pending|closed|archived) and
   `waiting_for` (admin|user|none) are consequences of the event — create / user
   reply / admin text reply / close / reopen — never values a client sends. A forged
   body carrying `status: "closed"` is ignored (route test). The counters and
   `first_reply_at` (an idempotency sentinel, not a display timestamp) are derived in
   the same statement as the message.
3. **Two Legacy defects were found and are NOT reproduced.**
   (a) An admin INTERNAL NOTE moved the ticket (status→pending, waiting_for→user,
   `unread_user_count+1`, `first_reply_at` stamped, `last_message_at` moved —
   `SupportRepository::addMessage`, admin branch). It runs unconditionally there,
   notes included, so a message the user cannot read told the user "we replied",
   raised a badge for something they cannot open and reordered their list. Modern
   derives state from the message's TYPE: a note moves nothing, and the DB's own
   test pins status, both axes, both counters, the sentinel and the ordering key.
   (b) Legacy granted an internal note to super_admin only, but an ADMIN asking for
   one silently got a USER-VISIBLE reply instead (the controller computed
   `!empty($body['internal']) && $role === SUPER_ADMIN`) — a privilege check whose
   failure mode LEAKED the note. Modern refuses the request outright (403).
4. **The persistence guarantees live in PostgreSQL, and a real battery proves them**
   (`db/tests/supportTickets.pg.test.ts`, 14 tests, 29 files / 58 runs in the full
   battery sweep): `require_live` refuses a reply into a closed ticket and inserts
   NOTHING; the transition function is a compare-and-set and the API maps a lost
   race to 409; two concurrent replies both count (no lost increment); the CHECKs
   refuse an axis combination that contradicts the status and a system note with an
   author; deleting a user takes their tickets while a deleted ADMIN's replies
   survive unattributed.
5. **A bug in the migration was found by the battery and fixed at the source.**
   `ON DELETE SET NULL` on `support_messages.sender_user_id` (Legacy's own FK action)
   contradicted a strict "non-system messages always have an author" CHECK — and
   because PostgreSQL does not order RI triggers, `SET NULL` could fire before the
   ticket cascade, so **`DELETE FROM users` FAILED** (reproduced: 23514). The
   constraint now enforces the half that carries meaning and cannot be broken by a
   deletion (a system note has no author); the authorless residue of a deleted
   author is allowed and documented, and the application never writes one.
6. **The web surface is Legacy's ticket center on the Modern design system.**
   `apps/web/src/app/(app)/support/page.tsx` (the PLANNED shell is gone): three KPIs,
   the create form (subject ≤ 200 / message ≤ 5000), the open/closed split list with
   status + whose-turn + unread badges, the thread with `?ticket=<id>` deep linking,
   the reply box HIDDEN while closed, reopen, and the toasts/empty/error copy Legacy
   already had. **34 of the 38 catalog keys are byte copies from Legacy
   `public/locales/{fa,en}.json` @edede31** (`pages.support.*`); the four authored
   keys are letter-prefixed `support.*`; `errors.support.*` were already in the
   `errors` chunk and the page maps API error CODES onto them.
7. **Visual QA defect found and fixed BEFORE commit (Phase 5 = 29/29 in a real
   browser, `tools/visual-qa/phase5-support.mjs`, screenshots in
   `docs/audits/phase5-ui/`).** Three real defects were caught by the loop, not by
   the build: (a) `style={{…}}` is blocked by the production CSP
   (`style-src 'self' 'nonce-…'`), so the page rendered degraded while tsc/webpack
   stayed green — removed, and a source guard now forbids it; (b) reading
   `window.location.pathname` during render made the server paint Persian and the
   client repaint English on `/en/support` (React hydration error #418) — the
   locale now comes from `usePathname()`, the shell's own rule; (c) `.v-latn-num`
   carries `direction:ltr`, which is right for a raw ISO stamp but reorders a
   FORMATTED Jalali date around its comma (measured in the browser by character
   position) — formatted timestamps now use a `.ts-mixed` class that keeps the
   digits Latin without imposing direction.
8. **Gates:** `npm run typecheck` clean · `npm test` **1064 + 63 = 1127 pass, 0 fail,
   0 skip, EXIT=0** · real-PG batteries **29 files / 58 runs / 0 failures** ·
   support service 15/15 · support routes 10/10 · support real-PG 14/14 · throttle
   guard 18/18 (extended for the support writes) · web build 38 routes ·
   secret-scan PASS · visual QA 29/29.

**Evidence files:** `docs/audits/2026-10-04-PHASE5-STATUS.md`,
`docs/audits/phase5-ui/` (14 screenshots + `visual-qa-results.json`),
`tools/visual-qa/phase5-support.mjs`, `db/tests/supportTickets.pg.test.ts`,
`apps/api/src/support/*.test.ts`, `apps/web/src/i18n/supportSurface.test.ts`.

**Nothing was removed.** No existing capability, route, table or string was taken
away; `/support` went from a PLANNED shell to the real capability, and the rest of
the app is untouched (the only cross-cutting changes are the throttle table, the
RBAC permission list and the kernel slot).

**Push status:** committed and pushed to `feat/telegram-journal-client` in the same
delivery. A commit cannot contain the result of its own push, so the VERIFIED remote
tip (read back with `git fetch` + `git rev-parse`) is recorded in the small
push-verification commit that follows this one — until that commit exists, no state
above COMMITTED is claimed for AC-14.

## AC-15 — 2026-10-04 · push verification for phases 3–5 (the branch is on GitHub)

**Why this entry exists.** AC-9…AC-14 each recorded work as local, because each push
until now needed a fresh single-use token. The owner restored the phase-by-phase
directive (push after every phase, keep going to the last phase) and supplied a token
in-conversation, so the backlog went up in this delivery. A commit cannot contain the
result of its own push, so the result is recorded here, in the commit that follows it.

**Verified transcript** (token redacted; the token is used inline and stored nowhere —
no file, no git config, no credential helper, no commit):

```
local HEAD before push : 69d132e8e385d6c4c363837472ede0902319d326
--- git push ---
To https://github.com/veloratrade/velora-modern.git
   1f6c4bb..69d132e  HEAD -> feat/telegram-journal-client
--- git fetch (verification, not the push's own output) ---
remote tip (FETCH_HEAD) : 69d132e8e385d6c4c363837472ede0902319d326
--- git ls-remote (independent) ---
69d132e8e385d6c4c363837472ede0902319d326  refs/heads/feat/telegram-journal-client
0e9c4d7e6e1f984287490ce02f5681c208e35c7a  refs/heads/main
checked at (UTC)       : 2026-10-04T17:47:25Z
```

**Reading of that transcript, stated conservatively.**
- The remote branch moved `1f6c4bb → 69d132e`. That single range contains the phase-3,
  phase-4 and phase-5 deliveries: `1f6c4bb` was already the phase-4 tip, so phases 3
  and 4 were on the remote before this push and this push carried **phase 5** —
  `eb1646b` (API/DB), `d36c022` (web), `69d132e` (evidence + state).
- `69d132e` is confirmed by a **fresh fetch** and by an independent `git ls-remote`,
  not by the push's own stdout.
- `main` is untouched at `0e9c4d7e` — the branch is **not merged**, and nothing is
  claimed about any deployed environment (see §"delivery states" in the phase-5
  report: DEPLOYED is `NOT_CLAIMED`).
- AC-15's own commit becomes the new tip; its SHA is recorded in the phase-6 push
  transcript. This recursion is the honest form of "record the tip" — a commit cannot
  name itself.

**Delivery states after this push:** phases 1–5 = **PUSHED**. Not merged, not deployed,
no PR merge. PR #9 still open against `main`.

## AC-16 — Phase 6: admin console (2026-10-05)

**Commit(s):** `caf16bf` (API/DB + contracts) · `ec4e8e9` (web + i18n) · the evidence/docs/state commit
that follows, all on `feat/telegram-journal-client` (phase start `73fc5ee`, the AC-15
push-verification commit).

**What this delivery establishes**

1. **`/admin` is a console, not a 34-line shell (MG-ADMIN → PARTIAL; ADM-01, ADM-04,
   SUP-02 → VERIFIED).** Seven permission-driven tabs — overview, user 360, support
   queue, audit, security & access, system & health, analytics & revenue — on a real
   console API, in fa (rtl) and en (ltr), rendered from `apps/web/messages/{fa,en}/admin.json`.
2. **A reproducible Legacy inventory replaces an unreproducible one.** Parsing every
   `$router` statement in Legacy `api/index.php` lines 109–251 (method + path +
   permission constant, multi-line included) yields **75 `/api/v1/admin/*` routes across
   19 path segments**. The audit's "59/62 endpoints, 38 modules" figure is superseded by
   that count, and the method is written down
   (`docs/audits/2026-10-04-PHASE6-ADMIN-CAPABILITY-MAP.md` §1) so anyone can re-run it.
3. **14 console routes + the extended per-user admin API**, with divergences recorded
   rather than silently accepted (§3.2 of the map): ONE `session-revocations` path
   instead of Legacy's two; per-user audit via `/admin/audit-logs?targetUserId=` so there
   is exactly one implementation of "read the trail"; `PATCH` rather than `POST` for
   status/role; `/admin/permissions` → `/admin/rbac/matrix` (`rbac.matrix.view`,
   super_admin-only); Legacy's `/admin/analytics/overview` → the composed Overview tab;
   `/admin/users/{id}/activity` → the audit trail plus separately authorized blocks.
4. **Sensitive data is OMITTED, not nulled.** `ConsoleSecurityEventView` removes
   `ipAddress`/`userAgent` from the response body for a caller without
   `audit.view_sensitive`, and the console *labels* the omission («بدون مجوز … نمایش داده
   نمی‌شود») instead of showing a blank cell — a null and a withheld field must not look
   the same to an operator.
5. **Health attestation is honest.** Nine components are attested with latency
   thresholds; the ones Modern has not built (worker, e-mail, AI provider, MetaAPI, n8n
   relay) report `not_applicable` **with the phase that owns them** — never a green
   check. The expected-migration count is read from the manifest the process can actually
   see, and reported UNKNOWN when it cannot, rather than invented.
6. **The audit trail now carries `before_state`/`after_state`** (found by this phase's
   real-PG battery: the console renders "what changed" but the store never selected the
   columns), and migration `0027` closes the action vocabulary — an unknown action is now
   a `23514` CHECK violation, not a silent row. 15 actions total, including the two this
   phase adds (`USER_SESSIONS_REVOKED`, `USER_EMAIL_VERIFIED`).
7. **The user-mutation guard order is frozen and tested**: self-action 403 →
   `USER_NOT_FOUND` 404 → System Owner protected → privileged target → super_admin peer →
   privilege-escalation denial → no-op without revoking sessions → `LAST_SUPER_ADMIN` 409.
   A no-op verify-e-mail returns `changed:false` and writes **no** audit row, because
   nothing changed.
8. **Localization reuses Legacy's own words.** 148 keys per locale = 29 authored
   (`adminConsole.*` + `admin.status.active`) + **119 byte copies** of Legacy's admin
   vocabulary at `edede31`; a guard asserts the copies are byte-identical, that every key
   the page can render resolves in both locales, that fa renders Persian and en English
   *on rendered values*, and that **every CSS class the page applies exists in the
   stylesheet** (that last check caught three invented classes).
9. **The RBAC map moved from 6 to 12 of 24 Legacy permissions ENFORCED** (rows 1, 7, 9,
   10, 11, 15, 16, 22), each with its real enforcement point and test; its guard
   (`rbacCapabilityMap.test.ts` 5/5) fails if a row claims a permission that does not
   exist in code, so the document cannot drift ahead of the implementation.
10. **Browser QA found three defects and all three were fixed in this phase** (first pass
    49/56 → final **62/62**): wide tables widened the page on mobile (123 px at 390,
    193 px at 320, 515 px on the audit tab → now 0 at 1440/390/320 in both locales, using
    the canonical `.overflow-auto` wrapper the journal already uses); raw enums (`open`,
    `admin`) leaked into the Persian console while the filter above them spoke Persian;
    and the ticket thread offered transitions the service refuses (close on closed = 409,
    archive on open = 422, reply to archived = 422) while `close` dismissed the record,
    making `archive` — legal only from `closed` — unreachable. Three further failures were
    **harness expectations that were wrong**, and the product behaviour was the stronger
    one: numerals render Latin by product rule, a no-op writes no audit row, and a
    signed-in non-admin is *redirected* away from `/admin` by the proxy rather than shown
    an in-page refusal.

**Gates (exact results, this session)**

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (contracts, domain, api, worker, web) |
| `npm test` | **1106 node + 63 PGlite**, 0 fail / 0 skip, EXIT=0 |
| Real-PostgreSQL batteries | **30 files × 2 orders = 60 runs, 0 failures** — `REAL-PG EVIDENCE: PASS` (PostgreSQL 17.11, migrations at head `0027`) |
| Phase-6 tests | `adminConsoleRoutes` 17/17 · `adminConsoleService` 16/16 · `db/tests/adminConsole.pg` 14/14 · `i18n/adminSurface` 8/8 · `i18n/supportSurface` 7/7 · `extendedCapabilities.pg` 15/15 · `rbacCapabilityMap` 5/5 |
| `next build` | `✓ Compiled successfully` — 38 routes, `/admin` and `/en/admin` both real |
| Secret scan | PASS, 0 findings |
| Visual / responsive QA | **62/62** in Chromium 153 against the production build + live API on PostgreSQL — 20 screenshots + `visual-qa-results.json` in `docs/audits/phase6-ui/`, harness `tools/visual-qa/phase6-admin.mjs` |

**Delivery states (mission §23) — claimed only as far as the evidence reaches**

`AUDITED` → `IMPLEMENTED` → `TESTED` → **`COMMITTED`** for the seven console modules.
`PUSHED` is claimed only in the push-verification entry that follows this one (a commit
cannot contain the result of its own push). **Nothing here is `DEPLOYED` or
`LIVE VERIFIED`**: no environment was touched, and the QA run's accounts
(`adm-qa-*@velora.test`) are local test data in a disposable cluster.

**Still open, each with a named owner (never stubbed):** AI admin module (14 routes) →
phase 7 · integrations admin (12) + worker/e-mail + A2 logs → phase 8 · settings (3),
feature flags (2), log viewer (1), billing (2) and the ai/operations/revenue analytics
blocks → phase 9 or until a reader exists · user creation + invitations (2) → **owner
decision** on invite policy (TTL, who may invite) · per-user login history (1) → phase-6
follow-up. No existing user capability was removed.

## AC-17 — 2026-10-05 · push verification for phase 6 (the admin console is on GitHub)

**Why this entry exists.** AC-16 recorded phase 6 as `COMMITTED` and claimed nothing above
it, because a commit cannot contain the result of its own push. The owner supplied a token
in-conversation (used inline, stored nowhere — no file, no git config, no credential
helper, no commit), the push ran, and the result is recorded here.

**Verified transcript** (token redacted):

```
local HEAD before push : 83be9c4c2ee83c86165ab585e27da6cf57db8b15
--- git push ---
To https://github.com/veloratrade/velora-modern.git
   73fc5ee..83be9c4  HEAD -> feat/telegram-journal-client
--- git ls-remote (independent read-back, not the push's own stdout) ---
83be9c4c2ee83c86165ab585e27da6cf57db8b15  refs/heads/feat/telegram-journal-client
0e9c4d7e6e1f984287490ce02f5681c208e35c7a  refs/heads/main
checked at (UTC)       : 2026-10-05T03:22:35Z
```

**Reading of that transcript, stated conservatively.**
- The remote branch moved `73fc5ee → 83be9c4`, carrying exactly this phase's three
  commits: `caf16bf` (API/DB + contracts), `ec4e8e9` (web + i18n), `83be9c4`
  (evidence + docs + state).
- The tip is confirmed by an independent `git ls-remote`, and equals the local HEAD.
- `main` is untouched at `0e9c4d7e` — the branch is **not merged**. PR #9 remains open
  against `main`; nothing here is a property of `main`, of production, or of any deployed
  environment. No deploy was attempted and no webhook, worker or external service was
  exercised: the phase-6 QA run drove a local production build against a local API on a
  disposable PostgreSQL 17 cluster.
- AC-17's own commit becomes the new tip; its SHA is recorded in the next push transcript.
  This recursion is the honest form of "record the tip" — a commit cannot name itself.

**Delivery states after this push:** phases 1–6 = **PUSHED**. Not merged, not deployed,
not live-verified. `DEPLOYED` and `LIVE VERIFIED` remain `NOT_CLAIMED`.

## AC-18 — Phase 7 (API slice): the AI capability (2026-10-05)

**Commit:** `d5710fe` on `feat/telegram-journal-client` (pushed; verified with an
independent `git ls-remote` at 2026-10-05T05:26:28Z).

**What this delivery establishes**

1. **The AI layer is a configuration + governance system, not a wrapper.** Migration
   `0028` adds the chains (`ai_feature_routes`), the flags with a deterministic
   rollout (`ai_feature_flags`), per-provider daily budgets (`ai_provider_quotas`),
   credential METADATA with an HMAC fingerprint and **no secret column at all**
   (`ai_provider_credentials`), admin-managed secrets encrypted with the EXISTING
   `credentialCrypto` envelope in 0010's column convention (`ai_platform_secrets`),
   AI settings and feedback — and extends the ONE ledger (0017/0023) with `route`,
   `fallback_index`, `latency_ms`, `input_hash`, the `tesseract` provider and six
   features, instead of adding Legacy's four attempt tables.
2. **The order of operations is the security property.** flag gate → chain →
   deadline → consent (external providers only) → ONE atomic quota reservation →
   image anonymization **fail closed** → call → validate → record. Success, refusal
   and error all reach the ledger, so "the budget was gone", "the user never
   consented" and "the relay rejected us" stay distinguishable afterwards.
3. **The n8n Gemini relay is kept** (MG-TG-2 → PARTIAL): Legacy's exact contract,
   https-only, the token in the request header and nowhere else, normalized error
   mapping, admin-configurable with the value stored encrypted and never returned
   (the response carries `host`, `configured`, `tokenPresent`).
4. **The Tesseract fallback is proved, not mocked.** tesseract 5.5.0 is installed in
   this environment, so the test reads a real screenshot with the real binary and
   parses `XAUUSD / BUY / 2000.50 / SL 1995.00 / TP 2020.00` out of it. It is the one
   AI path this repository can verify live without a credential.
5. **The user capability**: `POST /ai/analyze-trades`, `/ai/weekly-report`,
   `/ai/feedback`, `GET /ai/attempts`, `GET /ai/status` — ids resolved server-side
   with ownership (a body carrying `trades` is refused outright), Legacy's prompt
   templates verbatim including their untrusted-data fence, Legacy's output
   whitelists, Legacy's locale rule and Legacy's rate limits (10/5/20 per hour).
6. **The admin surface**: 21 routes, `aiManage` reads and `aiRouteManage`
   (super-admin-only, as Legacy grants it) writes secrets/route/relay/probes/quotas.
   Probes are REAL calls; an unprobed credential is reported `UNVERIFIED`, never
   assumed healthy.
7. **The support assists phase 5 deferred**: translate, copilot, copilot/draft —
   gated by `support.tickets.manage`, degrading to `available:false` + a reason
   instead of breaking the console, and a draft is **never sent**.
8. **Two Legacy defects were found and are NOT reproduced**: the weekly report asks
   for a capability (`reports`) that no Legacy provider declares, so its chain
   resolves empty and the route can only fail — Modern derives the requirement from
   the feature in one place; and Legacy wraps unparseable model prose into
   `{summary: prose}`, which Modern refuses as `INVALID_PROVIDER_OUTPUT` because
   storing unvalidated model text as a structured insight is how a hallucination
   acquires a database row.

**Gates (re-run from scratch after a sandbox restore wiped the toolchain: `npm ci`,
package builds, PostgreSQL 17 reinstalled, all 28 migrations applied 0001→0028)**

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (5 projects) |
| `npm test` | **1148 + 63**, 0 fail / 0 skip, `ALL TEST FILES PASSED`, EXIT=0 |
| Real-PostgreSQL batteries | **31 files × 2 orders = 62 runs, 0 failures** — `REAL-PG EVIDENCE: PASS` |
| Phase-7 tests | `aiCapability` 23/23 · `aiRoutes` 19/19 (through the real kernel) · `aiCapability.pg` 12/12 · `rbacCapabilityMap` 5/5 · `rateLimitRoutes` 18/18 |
| Secret scan | PASS, 0 findings |

One pre-existing battery was corrected, not weakened: `adminConsole.pg.test.ts`
asserted the applied-migration count as a literal `27`. It now derives the expected
count and head from the migrations directory, so the assertion means "every
migration this repository ships is applied" and survives 0029 without editing — a
migration that fails to apply still fails the test.

**Delivery states (mission §23).** `AI-01`, `AI-02`, `AI-03` move MISSING →
**BACKEND_ONLY** (the vocabulary's exact meaning: server capability, no user-facing
surface). `MG-AI-OCR` OPEN → **PARTIAL**; `MG-TG-2` OPEN → **PARTIAL**;
`MG-AI-ANONYMIZE` **opened** with its owner decision named. The slice is
`IMPLEMENTED` + `TESTED` + `COMMITTED` + `PUSHED`. It is **not** `VERIFIED` as a
capability: verification would need a live provider round trip, and no Gemini key,
OpenAI key or relay URL+token is in scope. Nothing is `DEPLOYED` or `LIVE VERIFIED`.

**Next (named, not hidden).** The phase-7 web slice: `/intelligence` becomes a real
surface over analyze/report/attempts + consent — **without** Legacy's simulated
answers (`pages.intelligence.simulatedAnswer`, "72٪ نرخ برد", "✦ بهترین استراتژی
هفته" are demo content, and reproducing them would be fabrication); the console
gains an AI tab; both get fa/en chunks built on Legacy's own 80 `admin.ai.*` keys;
then a browser QA run. After that: phase 8 (integrations/worker/email), phase 9
(secondary parity), then the §29 report. No existing user capability was removed.


> **Provenance note (AC-19…AC-26):** these entries were recorded on branch
> `feat/mg-domain-legacy-only-achievements` ("charter wave 1" session) under the
> IDs AC-9…AC-16, in parallel with the `feat/telegram-journal-client` lineage
> (AC-9…AC-18 above). Both lineages branched from `main` @ `0e9c4d7`. They were
> renumbered AC-19…AC-26 during the 2026-10-05 lineage reconciliation merge so
> the ledger stays append-only with one linear numbering; original branch-local
> IDs are preserved in each heading's tail.

## AC-19 — 2026-10-03 · MG-OBS-6 fixed: pg-smoke S1b drift-proof expectation (charter wave 1, task 1) *(branch-local ID: AC-9)*

- **Commit:** this entry's commit — subject "fix(tools): pg-smoke S1b derives migration expectation from db/migrations (MG-OBS-6, AC-19)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-obs-6-pg-smoke-expectation` (charter §5; no direct-`main` implementation).
- **Classification:** TEST-TOOLING + STATE (`tools/pg-smoke.ts`, `docs/state/**`). No application code, no schema, no contract change.
- **Change:** S1b's hard-coded D1-era list `[0001..0005]` replaced by an expectation **derived from `db/migrations/`** (sorted `.sql` filenames, floor assertion ≥ 22 files) — the smoke can no longer drift behind the tree. Header check-list line updated accordingly.
- **Evidence (executed 2026-10-03 on this branch, fresh disposable cluster):** `DATABASE_URL=… npx tsx tools/pg-smoke.ts` → **PASS S1a…S9, ALL CHECKS PASSED** (S1b: `0001_core.sql…0022_legacy_contract_parity.sql applied (22 files)`; S1c idempotency no-op). **PG 17.11 caveat (not PG16).** Gates: clean-rebuild typecheck **0 errors** (a stale-`*.tsbuildinfo`/missing-`dist` sandbox artifact produced TS6305 first — resolved by `tsc -b --clean` + rebuild; environmental, not a regression; noted for session recovery) · local battery **804/804, 0 fail/0 skipped** · migration tests **19/19** · secret-scan **PASS 0 findings** · agent-context integrity OK.
- **Impact on migration state:** **MG-OBS-6 → CLOSED** (gap counts: 27 OPEN / 16 PARTIAL / 7 CLOSED). MG-G11's D1-smoke caveat is satisfied; MG-G11 remains PARTIAL (coverage scope unchanged).
- **Authorization:** Autonomous Execution Charter 2026-10-03 §4 task 1 (A-class); fix previously owner-gated — the charter's explicit task list authorizes it.

## AC-20 — 2026-10-03 · Worker one-tick runtime proof; MG-OBS-7 first-cron crash found and fixed (charter wave 1, task 2) *(branch-local ID: AC-10)*

- **Commit:** this entry's commit — subject "fix(worker): cron-fired ticks carry a full job descriptor; malformed jobs DLQ not crash (MG-OBS-7, AC-20)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-obs-7-worker-tick-descriptor`, stacked on `feat/mg-obs-6-pg-smoke-expectation` (charter §5; no direct-`main` implementation).
- **Classification:** WORKER RUNTIME FIX + TESTS + STATE (`apps/worker/src/**`, `db/tests/pgBossAdapter.pg.test.ts`, `docs/state/**`, `docs/evidence/**`). No schema, no contracts, no API, no owner decisions.
- **What happened:** the charter's local one-tick proof booted the real worker against real PostgreSQL and the FIRST dispatched tick job killed the process (`safeDlqReason("NO_HANDLER", undefined)` → TypeError → unhandled rejection → exit 1). Root cause: pg-boss schedules were registered without job data, and the timekeeper copies the schedule's `data` verbatim into fired jobs — so every cron-fired tick arrived with an empty descriptor. The worker would have died on its first real cron fire (analytics hourly at :20, FX daily, MetaAPI sync tick). No cron tick had ever executed anywhere (worker undeployed), so only a runtime proof could surface this.
- **Fix (MG-OBS-7):** (1) `pgBossAdapter.schedule()` passes a complete maintenance-policy `JobDescriptor` as the schedule data; (2) `runner.ts` + `safeError.ts` dead-letter descriptor-less jobs with reason `NO_HANDLER:unknown` instead of crashing. Full record: `docs/evidence/WORKER-ONE-TICK-RUNTIME-PROOF-2026-10-03.md`.
- **Evidence (executed 2026-10-03 on this branch, disposable PG 17.11):** pre-fix crash reproduced (process exit 1) → post-fix: malformed job inserted into a live polled queue → `job.no_handler jobClass=unknown` logged, **process alive**; real pg-boss timekeeper fired the analytics tick (cron accelerated to `* * * * *`, adapter-written data preserved verbatim) → `scheduler.analytics_tick count=1` → `job.done analytics.recompute-tick` (idempotencyKey `tick:analytics.recompute-tick`) → `analytics.recomputed count=1` → `job.done analytics.recompute-daily` (key `analytics:daily:1:2026-10-03T19`) → `user_analytics_daily` row materialized (user 1, trades_count 1, net_pnl 493.50); `SIGTERM` → `worker.shutdown` logged. **PG 17.11 caveat (not PG16); superuser role caveat (not least-priv velora_worker); FX tick not fired (live ECB call — charter-excluded); MetaAPI tick token-gated; copy tick no transport.**
- **Gates:** typecheck **0 errors** (clean rebuild) · local unit battery **ALL TEST FILES PASSED** (0 fail, 0 skipped) · `db/tests/pgBossAdapter.pg.test.ts` on real PG **16/16** (3 new MG-OBS-7 subtests) · secret-scan **PASS 0 findings**. Migration tests not rerun (no `db/migrations` change).
- **Impact on migration state:** **MG-OBS-7 → CLOSED** (new §E row; gap counts: 27 OPEN / 16 PARTIAL / 8 CLOSED, total 51). MG-G09 + MG-WORKER-DEPLOY: verification advanced to `RECORDED_RUNTIME` (local analytics tick proven; both remain **OPEN** — deployment is OD-AC-WORKER owner-gated). MG-G11 unchanged (coverage scope unchanged).
- **Authorization:** Autonomous Execution Charter 2026-10-03 §4 task 2 (A-class runtime evidence + defect fix; fix-and-re-verify per charter failure policy).

## AC-21 — 2026-10-03 · First real backup + restore drill (local disposable; MG-BACKUP-RESTORE → PARTIAL) (charter wave 1, task 3) *(branch-local ID: AC-11)*

- **Commit:** this entry's commit — subject "evidence(backup): local disposable backup + restore drill on real PG 17.11 (MG-BACKUP-RESTORE, AC-21)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-backup-restore-local-drill`, stacked on `feat/mg-obs-7-worker-tick-descriptor` (charter §5).
- **Classification:** EVIDENCE + STATE ONLY (`docs/evidence/**`, `docs/state/**`) — no code change; the drill exercised existing tooling (`ops/backup/create_pg_backup.sh`, `backup_gate.py`, `pg_restore`) exactly as shipped.
- **Drill (per `infra/backup/DR-RUNBOOK.md` dev/staging procedure, disposable local PG 17.11):** real producer run → backup `db-backup-staging-20261003192242-bdf0265c449e`, sha256 `5b3455636e7b39d59e0dfed90e04848646d5141a4769eefaaf67887fe904ef9a`, 31,969 bytes, INTEGRITY_VERIFIED, storage_status=NONE (honest). Gate on the real evidence → **FAIL exit 1** (fail-closed proven against real producer output, not fixtures). Artifact re-read + re-hash → MATCH. `pg_restore` into fresh disposable DB → **exit 0, 199 ms**; `schema_migrations`=22, `users`=1, `trades`=1, `user_analytics_daily` exact aggregate `(1, 2026-09-13, 1, 493.50)`, `pgboss.schedule` descriptors preserved; **per-table content hashes ALL MATCH**. Drill DB dropped; no dump bytes committed.
- **Caveats (recorded in the evidence file):** "staging" is the producer's only non-production label — the environment was the disposable LOCAL cluster, not Railway staging; no official storage/upload (nothing claimed); no API-level `GET /health` (row-level recovery proven; API check belongs to a staging drill); PG 17.11 not PG16; superuser role.
- **Gates:** backup suite 167/167 Python tests PASS; secret-scan PASS 0 findings (pre-commit); no code touched → typecheck/battery not rerun for this commit (unchanged tree `821f92b` + docs).
- **Impact on migration state:** **MG-BACKUP-RESTORE OPEN → PARTIAL** (gap counts: 26 OPEN / 17 PARTIAL / 8 CLOSED); MG-G13 verification → `RECORDED_RUNTIME (local)` — both remain open for staging/production backup, official storage, RPO/RTO, ADR-012 A.6 wiring.
- **Authorization:** Autonomous Execution Charter 2026-10-03 §4 task 3 (A-class local evidence; hard boundaries respected — no production, no network upload, no deploy).

## AC-22 — 2026-10-04 · Evidence-precision correction to AC-20 (MG-OBS-7 DLQ wording; owner-directed) *(branch-local ID: AC-12)*

- **Commit:** this entry's commit — subject "docs: precision correction to AC-20 evidence - MG-OBS-7 DLQ persistence wording (AC-22)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `docs/mg-obs-7-evidence-precision`.
- **Classification:** GOVERNANCE/EVIDENCE ONLY (`docs/evidence/**`, `docs/state/**`) — no code, no tests, no behavior change.
- **What changed:** the AC-20 evidence record and the MG-OBS-7 register rows previously said the runner "dead-letters descriptor-less jobs". Per the owner's evidence-discipline instruction (2026-10-04), three facts are now strictly distinguished: (1) the no-handler/error **path** executed (live log evidence `job.no_handler jobClass=unknown`); (2) the **process survived** (live evidence); (3) **physical persistence into `velora.dlq` is NOT claimed for the live malformed job** — its final DB state was not inspected on the live cluster. What IS proven, by direct SQL in the real-PG integration test: the raw-inserted malformed job is terminally failed **in place** (`state='failed'`, `output={dlq:true, reason:"NO_HANDLER:unknown"}`, never redelivered) because a raw row carries no `dead_letter` target; physical `velora.dlq` routing is proven **only for `send()`-enqueued jobs** (pre-existing exhaustion test), and the runner's `deadLetter()` call is proven to physically move the job only on MemoryQueue (unit test).
- **Impact on migration state:** none to statuses or counts (27→26 OPEN etc. unchanged; MG-OBS-7 remains CLOSED with sharper evidence wording).
- **Authorization:** owner message 2026-10-04 ("IMPORTANT: do NOT claim that the malformed job was physically persisted into the DLQ unless the evidence explicitly proves physical DLQ storage").

## AC-23 — 2026-10-04 · MG-RANGE-GUARD implemented: runtime PnL range guard (legacy assertFits port) (charter wave 1, task 4) *(branch-local ID: AC-13)*

- **Commit:** this entry's commit — subject "feat(domain): runtime PnL range guard - legacy assertFits port (MG-RANGE-GUARD, AC-23)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-range-guard`, stacked on `docs/mg-obs-7-evidence-precision` (charter §5; no direct-`main` implementation).
- **Classification:** DOMAIN + API + TESTS (`packages/domain/src/pnl.ts`, `apps/api/src/trades/tradeService.ts`, two test files). No schema, no migrations, no contracts change, no owner decisions — the limits are derived verbatim from the legacy source (READ-ONLY) and the audit §9.1 row.
- **Change:** `computePnl` returns a new explicit `out-of-range` result kind when a calculated value cannot fit the supported range — the port of legacy `PnlCalculator::assertFits` (`/\A-?\d{1,N}(?:\.\d{1,F})?\z/D`): **netPnl (legacy `profitLoss`) 16 integer / 8 fraction digits, rMultiple 10/8** — checked on the final rescaled strings, net first (legacy assert order, so out-of-range shadows undefined-risk exactly as the legacy throw did). The limits are stricter than the modern storage columns (`trades.net_pnl NUMERIC(20,2)` = 18 integer digits, `r_multiple NUMERIC(20,8)` = 12), so a passing value always fits the schema. `tradeService` maps the kind to the legacy `ApiException` vocabulary at BOTH call sites (create + exit recompute): **422 `VALIDATION_FAILED`, details `code: OUT_OF_RANGE`, `messageKey: errors.validation.range`, field `profitLoss`/`rMultiple`** (field mapped to the API vocabulary, which — like the legacy error — says `profitLoss`).
- **Deliberate mechanism divergence (documented in code):** legacy throws `ValidationException`; modern returns a result kind so the type system forces every caller to handle the branch — the same house style the audit itself notes ("modern makes the branch explicit"), and the reason `undefined-risk` is a kind.
- **Evidence (executed 2026-10-04 on this branch):** domain **17/17** (6 new boundary tests: 16-integer-digit net passes / 17 rejected; negative sign not counted as a digit; out-of-range net shadows undefined-risk; r-multiple 10 digits passes / 11 rejected — vectors constructed so risk survives the scale-2 rescale: riskDelta 1e-8 × volume 1e6 = 0.01) · service **28/28** (3 new integration tests: create net overflow ≈1e30 from individually-valid 10,8 inputs; create r-multiple overflow 1e10; exit recompute overflow ≈1e21) · full local battery **ALL TEST FILES PASSED** (re-run after correcting an invalid test-mode string caught by typecheck — `"parity"` → `"bcmath-truncate"`; environmental authoring slip, not a regression) · typecheck **0 errors** · secret-scan **PASS 0 findings**. No DB change → migration tests not applicable; no real-PG behavior touched (guard is pure domain logic).
- **Impact on migration state:** **MG-RANGE-GUARD OPEN → CLOSED** (gap counts: 25 OPEN / 17 PARTIAL / 9 CLOSED, total 51). MG-G04's §9.1 range-guard dimension is satisfied; the **r-multiple SCALE divergence (4 vs 8) remains open as MG-RMULTPLE-SCALE/MG-RMULTIPLE-SCALE and is NOT touched** (parity scale change is a financial-semantics question for the owner). Audit §9.1 table itself remains immutable.
- **Authorization:** Autonomous Execution Charter (owner message 2026-10-04, task 4; A-class — closure criteria "Guard implemented", no owner decision required).

## AC-24 — 2026-10-04 · JalaliCalendar ported to packages/domain (MG-DOMAIN-LEGACY-ONLY → PARTIAL) (charter wave 1, task 5) *(branch-local ID: AC-14)*

- **Commit:** this entry's commit — subject "feat(domain): Jalali calendar port - legacy JalaliCalendar parity (MG-DOMAIN-LEGACY-ONLY, AC-24)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-domain-legacy-only-jalali`, stacked on `feat/mg-range-guard` (charter §5).
- **Classification:** DOMAIN + TESTS (`packages/domain/src/jalali.ts` NEW, `jalali.test.ts` NEW, `index.ts` +1 export). No API/schema/contracts change, no owner decisions.
- **Change:** the legacy `JalaliCalendar.php` (Phase 3) ported as a pure, IO-free domain module — `gregorianToJalali` verbatim; `jalaliToGregorian` + `isJalaliLeap` ported verbatim from `TradeTimeNormalizer` (the legacy single algorithm owner — legacy delegated to avoid duplicate math; the modern side keeps the same single-owner shape); `isGregorianLeap`, `formatJalaliDate` (sprintf padding semantics). Contract preserved: DISPLAY/HELPER ONLY, never part of canonical-time resolution. Cosmetic documented divergence: named fields instead of PHP arrays.
- **Evidence discipline — the port was verified against the ACTUAL legacy PHP (executed 2026-10-04, PHP 8.4.26, algorithms copied verbatim to a /tmp harness; the legacy repo itself untouched):** spot vectors J1/J2/J4 reproduce identically. The verification **disproved the legacy header's own claim**: "round-trips are stable for 1925..2124 (jy 1304..1503)". Measured (legacy PHP itself): gregorian-first round-trips EVERY day of **2000..2100** and drifts in 1901..1999 / 2101..2160 (47,116 failing days in 1900..2130); jalali-first round-trips **jy 1379..1478** except Esfand-30 of the 9 in-window leap years {1382, 1407, 1411, 1415, 1440, 1444, 1448, 1473, 1477}. Decision (parity over correction): the port reproduces legacy **verbatim**, including the drift — changing the algorithm would alter legacy display output (an owner decision, recorded in the register row). Tests pin both the clean-window edges (full-day sweeps of 2000 and 2100) and the out-of-window drift vectors (e.g. 1925-01-01 → 1303/10/11 → 1924-12-31; 1407/12/30 → 2029-03-20 → 1408/01/01) so any future change is loud.
- **Gates:** domain tests **11/11** (J1–J8 legacy vectors, full-day sweeps 2020..2030 + 2000/2100, leap vectors, parity pins) · full battery **ALL TEST FILES PASSED** (includes the new file) · typecheck **0 errors** · secret-scan **PASS 0 findings**.
- **Impact on migration state:** **MG-DOMAIN-LEGACY-ONLY OPEN → PARTIAL** (24 OPEN / 18 PARTIAL / 9 CLOSED). Jalali dimension done; `TradingSessionEngine` + achievements remain (next charter tasks).
- **Authorization:** Autonomous Execution Charter (owner message 2026-10-04, task "Jalali domain port"; A-class).

## AC-25 — 2026-10-04 · TradingSessionEngine ported to packages/domain (MG-DOMAIN-LEGACY-ONLY, session dimension) (charter wave 1, task 6) *(branch-local ID: AC-15)*

- **Commit:** this entry's commit — subject "feat(domain): TradingSessionEngine port - legacy parity with DST-aware windows (MG-DOMAIN-LEGACY-ONLY, AC-25)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-domain-legacy-only-session-engine`, stacked on `feat/mg-domain-legacy-only-jalali` (charter §5).
- **Classification:** DOMAIN + TESTS (`packages/domain/src/tradingSession.ts` NEW, `tradingSession.test.ts` NEW, `index.ts` +1 export). No API/schema/contracts change, no owner decisions.
- **Change:** legacy `TradingSessionEngine.php` + `SessionWindow.php` (Phase 3) ported as a pure domain module: classify(canonicalUtc | null) → explicit status (`unconfigured`/`unresolved`/`invalid`/`outside`/`open`) + matched sessions + `hourUtc`/`dayOfWeekUtc`/`engineVersion`/`windowCount`. Hard rules preserved verbatim: the engine NEVER invents windows (no configuration → `unconfigured`, empty sessions — the legacy fixed-UTC marketing copy is deliberately NOT wired in); windows reference explicit IANA zones; sessions are derived from canonical UTC and never fed back into canonical-time resolution. `SessionWindow` validation ported (id/label/minutes/daysOfWeek/priority rules; fixed offsets and abbreviations like `EST`/`GMT+3` rejected — legacy `TimezoneResolver::isValidIana` port).
- **Mechanism (documented divergence):** DST via the platform timezone database through `Intl.DateTimeFormat` with explicit `timeZone` + fixed `en-US` locale (legacy used PHP `DateTimeZone`); UTC epochs are compared, wall→UTC conversion uses two-probe offset refinement across DST edges. IANA admission = the runtime's canonical Intl zone set (legacy admitted `ALL_WITH_BC`; canonical zones behave identically, the surface is strictly cleaner). Input requires the exact canonical `YYYY-MM-DD HH:MM:SS` shape.
- **Evidence:** tests **19/19** (legacy golden vectors S1–S21 ported: unconfigured/unresolved/invalid, overlap, inclusive-open/exclusive-close boundaries, summer + winter DST, weekday filter, cross-midnight incl. early-hours-from-yesterday, config validation). **Plus a direct cross-check (2026-10-04): the ACTUAL legacy PHP classes (READ-ONLY require, PHP 8.4.26) and this port produce IDENTICAL output on all 14 classification vectors** — `2026-08-31 12:00:00|open|london,newyork|12|1`, DST-winter variants, boundary minutes 06:59/07:00/15:29/15:30, Sunday-filter, cross-midnight 03:00/05:30/06:30/07:30 — byte-for-byte equal (diff clean).
- **Gates:** domain tests 19/19 · full battery **ALL TEST FILES PASSED** (includes the new file) · typecheck **0 errors** · secret-scan **PASS 0 findings**.
- **Impact on migration state:** MG-DOMAIN-LEGACY-ONLY remains **PARTIAL** (24 OPEN / 18 PARTIAL / 9 CLOSED) — Jalali + session dimensions done; achievements engine port remains (next charter task).
- **Authorization:** Autonomous Execution Charter (owner message 2026-10-04, task "TradingSessionEngine"; A-class).

## AC-26 — 2026-10-04 · Achievements engine ported to packages/domain (MG-DOMAIN-LEGACY-ONLY, achievements dimension) (charter wave 1, task 7) *(branch-local ID: AC-16)*

- **Commit:** this entry's commit — subject "feat(domain): achievements engine port - legacy repository semantics + catalog (MG-DOMAIN-LEGACY-ONLY, AC-26)" (self-referential by exact ASCII subject, per the AC-6b protocol lesson). Branch `feat/mg-domain-legacy-only-achievements`, stacked on `feat/mg-domain-legacy-only-session-engine` (charter §5).
- **Classification:** DOMAIN + TESTS (`packages/domain/src/achievements.ts` NEW, `achievements.test.ts` NEW, `index.ts` +1 export). No API/schema/migration change, no owner decisions.
- **Change:** legacy `UserAchievementRepository` (READ-ONLY source-read 2026-10-04) ported at the domain level: the complete two-definition catalog legacy actually ships — `FIRST_TRADE` (unlocked by TradeService after the first created trade) and `EMAIL_VERIFIED` (unlocked by AuthService after verification), each with its legacy i18n keys; `normalizeAchievementKey` (mb_strtoupper/trim parity); the exact `metadata_json` field set/order and timestamp formats (`gmdate('Y-m-d H:i:s')` for `achieved_at`, `gmdate('c')` — `+00:00`, no milliseconds — for `unlockedAt`); the **idempotent first-unlock decision** (false when already unlocked, no second insert); **fail-silent error semantics** (legacy `catch (Throwable)` — preserved deliberately and documented: an achievement must never break its caller's flow); `listForUser` with degrade-to-[] parity. Storage is the injected `AchievementStore` port — the domain stays IO-free per house rules. The achievements EMAIL is not ported here (notification concern; the `achievement_notifications` email flag already survives in modern, and sending is a live-service boundary).
- **Evidence:** domain tests **11/11** (catalog exactness, normalization, timestamp formats, metadata byte-shape, idempotent unlock, per-user isolation, fail-silent exists/insert/list failures, malformed-metadata degrade) · full battery **ALL TEST FILES PASSED** · typecheck **0 errors** · secret-scan **PASS 0 findings**.
- **Impact on migration state:** MG-DOMAIN-LEGACY-ONLY stays **PARTIAL** (24 OPEN / 18 PARTIAL / 9 CLOSED) — all three §9.3 dimensions (Jalali, TradingSessionEngine, achievements) now have domain ports; what remains is the product-integration layer (user_achievements storage via an additive migration, unlock triggers at the first-trade/email-verification call sites, and the achievements email), which is API/product surface, tracked here and related to MG-G01.
- **Authorization:** Autonomous Execution Charter (owner message 2026-10-04, task "achievements domain port"; A-class).

## AC-27 — 2026-10-05 · Lineage reconciliation: both unmerged branches integrated into one verified tree

- **Commits:** merge `ce78ad07467b` (`feat/mg-domain-legacy-only-achievements`) + merge `af782f4745b2` (`feat/telegram-journal-client`) onto `integration/reconcile-lineages` (from `main` @ `0e9c4d7`), plus the merge-fallout fix commit `06fd3a99673a` (PnlResult union narrowing in `apps/web/src/app/(app)/trades/page.tsx` + `apps/web/src/features/trades/pnlPreview.test.ts` — the domain lineage made `PnlResult` a discriminated union (AC-23) while the telegram lineage's web code still read the flat shape).
- **What was reconciled:** two parallel session lineages, both branched from `main` @ `0e9c4d7`, both pushed and never merged, with COLLIDING AC numbering (telegram AC-9…AC-18; domain AC-9…AC-16). The telegram numbering is kept (its IDs are cited by dozens of committed evidence documents); the domain entries are renumbered **AC-19…AC-26** with branch-local IDs preserved in each heading. `MIGRATION_GAP_REGISTER.md` + `.json` are the union: the more advanced status wins per gap, evidence lists are merged, and every merged row carries a `reconciled_2026_10_05` provenance note. Register JSON evidence entries that were prose (not paths) moved to `evidence_note` so `tools/agent-context.mjs` validation passes.
- **Verification (merged tree, this session):** `npm run typecheck` 0 errors · `npm test` **1281 → (after AC-28) 1282**, 0 fail / 0 skip, ALL TEST FILES PASSED · `bash tools/secret-scan.sh` PASS 0 findings · **real-PG batteries 32 files × 2 orders = 64 runs, 0 failures** on disposable PostgreSQL 17.11 (migrations 0001→0029 applied from scratch); the pgRoles battery requires its documented CREATEROLE/superuser prerequisite (GHA runs it as the container superuser) and passes **23/23** when run under that prerequisite — under a plain CREATEROLE role it fails on `ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner`, which is the environment, not the tree.
- **Impact on migration state:** no gap opened; ~15 gaps' evidence now applies to one tree instead of two branches. `MG-OBS-6` closed by BOTH lineages (telegram's superset kept). `MG-RANGE-GUARD` → CLOSED (AC-23). `MG-DOMAIN-LEGACY-ONLY` → PARTIAL (AC-24/25/26). `MG-OBS-7` added+closed (AC-20). Statuses for code that had landed with stale register rows (MG-SEC-EDGE-AUTHZ, MG-AUTH-EVENTS, MG-METAAPI-CADENCE manual trigger) are re-audited in the register **after** independent code verification this session — see the AC-27 register note.
- **Authorization:** owner instruction 2026-10-05 ("autonomously implement every actionable gap you can safely resolve… Do not wait for another prompt"). Merge to `main` is prepared on `integration/reconcile-lineages`; push remains owner-gated (no credentials, and the repo is intentionally public — pre-push secret-scan required).

## AC-28 — 2026-10-05 · MG-METAAPI-ASSEMBLY implemented + S1/S2 security regressions closed

- **Commits:** `761227b36d24` (assembly: domain assembler + migration 0029 + roles.sql + reconciler + importBatch rework + batteries + ops remediation tool + evidence doc), `dde116cfa595` (S1 cookie body-token removal + 128-char cap + S1 proof test; S2 CSP nonce fail-closed), `b500525ead8d` (register/CHANGE_LOG sync: MG-METAAPI-ASSEMBLY → PARTIAL, MG-SEC-COOKIE → CLOSED, MG-SEC-CSP → PARTIAL, MG-SEC-EDGE-AUTHZ + MG-AUTH-EVENTS re-audited → PARTIAL); on top of `06fd3a99673a` (AC-27 merge fallout).
- **MG-METAAPI-ASSEMBLY (audit §9.2, "the largest behavioural divergence"):** implemented per `docs/reconciliation/METAAPI_POSITION_ASSEMBLY_BRIEF.md` §4 with owner decisions **OD-M-PA-1/2/3 adopted per their recorded recommendations, pending owner ratification** (flagged, not silently decided):
  - `packages/domain/src/metaApiPositionAssembly.ts` — pure port of Legacy `MetaApiDealAssembler` (VERIFIED line-by-line @ `edede31`): `pos-<positionId>` grouping, in/out side filter, fill-level dedup, the emit gate (Σvol(OUT) ≥ Σvol(IN)), VWAP entry/exit at bcmath scale 8 (truncate), volume = Σ IN, profit/commission/swap summed across ALL fills, earliest-IN / latest-OUT boundaries, the full 10-reason skip vocabulary. **19/19 golden vectors** (`metaApiPositionAssembly.test.ts`).
  - `db/migrations/0029_metaapi_position_assembly.sql` — `sync_position_state` companion table (received → aggregated | skipped; shape CHECKs; pending partial index). The append-only REVOKE on `sync_fills` is **NOT relaxed** (roles.sql §4 comment preserved): the fill ledger stays byte-immutable evidence — a control Legacy lacked — while the workflow state machine moves to a mutable companion, exactly like `sync_reservations`. `db/roles.sql` adds `REVOKE DELETE, TRUNCATE` for both runtime roles (assessment history is unerasable). **pgRoles battery extended: 23/23** including new P19 (worker can INSERT/UPDATE the state machine; DELETE refused 42501; sync_fills still UPDATE-refused).
  - `apps/worker/src/metaapi/positionReconciler.ts` — port of `MetaApiService::reconcileAccount`: pending positions answered from the FILLS (self-healing for pre-0029 data — positions with no state row are assessed, so no backfill is needed), `insertExternalTrade` on `pos-<positionId>` with `ON CONFLICT DO NOTHING` (OD-M-PA-2), TRADE_IMPORTED with deterministic uid `metaapi:<account>:pos-<id>`, terminal skips (`close_before_open`, `unknown_direction`) durable, repairable skips stay received, re-open on later fills (OD-M-PA-1 semantics). `importBatch` slimmed to ledger + state upserts + in-transaction reconciliation (one tx incl. cursor — Legacy parity).
  - `db/tests/metaapiAssembly.pg.test.ts` — **8/8 on real PG 17.11**: cross-batch completion, scaled-in/partial-close VWAP through real SQL, terminal-skip durability + no re-assessment, re-open convergence (1 trade / 1 event after a late fill), lone-OUT repairable, keyless/balance never assessed, **self-healing** (pre-0029 ledgered fills assessed on the next sync), concurrent imports converge (reservation or DB UNIQUE — exactly one trade).
  - `db/tests/metaapiSync.pg.test.ts` E7/E8/E11 rewritten to the per-position contract (the old expectations pinned the divergent per-fill behavior the audit ruled wrong — test-side fix, justified here): **13/13**.
  - `ops/metaapi/retirePerFillTrades.ts` — OD-M-PA-1(a) remediation: DRY-RUN by default; `--execute` tombstones per-fill-era trades (source='metaapi', external_deal_id NOT LIKE 'pos-%') with TOMBSTONE_SET events, idempotent; **verified end-to-end** (dry-run no-op → execute 1 → re-run 0 → empty-batch sync re-assembled `pos-OLD` from the ledger with correct entry≠exit prices).
  - Remaining for full closure: a LIVE provider round trip (`NOT_VERIFIED` — no MetaAPI credentials in this environment) and owner ratification of OD-M-PA-1/2/3.
- **MG-SEC-COOKIE (S1, HIGH) → CLOSED:** the refresh credential is now accepted ONLY from the `__Host-velora_refresh` HttpOnly cookie — the `body.refreshToken` fallback is removed (Legacy's body exchange was a time-boxed 7-day migration window, `AuthController.php:352-386`, long expired), and Legacy's 128-char token cap is ported (INVALID_TOKEN before the store is ever consulted). **`authRoutes.test.ts` 12/12** including the new S1 proof (a valid token sent body-only → 401 REFRESH_COOKIE_MISSING, indistinguishable from no token). Flagged for the human review AGENTS.md rule 7 requires for auth changes.
- **MG-SEC-CSP (S2) → PARTIAL:** the `Math.random()` nonce fallback is replaced with FAIL-CLOSED 503 (a predictable nonce is a policy bypass, never a degraded mode). The release pinning/manifest model remains owner-gated (OD pinning model).
- **Verification:** `npm run typecheck` 0 errors · `npm test` **1282** (1219 general + 63 PGlite), 0 fail / 0 skip · secret-scan PASS · real-PG: assembly 8/8, metaapiSync 13/13, pgRoles 23/23, full 32-battery set 64 runs 0 failures on the pre-AC-28 tree + the three changed batteries re-run green on the post-AC-28 tree.

## AC-29 — 2026-10-05 · MG-SEC-HSTS re-audited and closed at the app layer (S4): redirect-path HSTS + unit pins on both sides

- **Commits:** this change (`apps/web/src/proxy.ts` redirect-normalization HSTS + `apps/web/src/proxy.headers.test.ts` + the `server.test.ts` HSTS assertion + register rows).
- **Finding (re-audit):** the audit's §10.2 S4 claim — "absent from `proxy.ts` by explicit design comment" — was stale on the integrated tree: the telegram lineage's SEC-04 work already emits `Strict-Transport-Security: max-age=31536000` (Legacy `.htaccess:49`'s exact value; no `includeSubDomains`/`preload`, commitments Legacy never made) from the API kernel `SECURITY_HEADERS` on **every API response** (`server.ts:1459`) and from the proxy's **served-page** and **edge-gate-denial** paths. One app-layer hole remained: **redirect-normalization responses** (`/en` → 308 `/en/`) carried nosniff/DENY/Referrer-Policy but not HSTS — while Legacy's `Header always set` applies to every response Apache emits, redirects included. A redirect is precisely a downgrade/SSL-strip surface, so this is fixed, not documented away.
- **Tests (new):** `apps/web/src/proxy.headers.test.ts` — the proxy is now unit-testable via `next/server` under tsx: (S4) served page carries HSTS + the full header set incl. nonce-CSP, Permissions-Policy, COOP, Vary; (S4) redirect normalization carries HSTS; (S5, bonus evidence) a protected route with an unreachable session-probe API **fails closed** — 302 to login, `X-Velora-Edge-Gate: gate-unavailable`, `no-store`, HSTS, never the protected HTML; (S2, bonus evidence) nonce-generation failure is **refused** with 503 + `Retry-After: 30` and NO CSP header (crypto restored afterwards). `apps/api/src/kernel/server.test.ts` now pins the API-side HSTS value on the every-response header set.
- **Verification:** `npm run typecheck` 0 errors · `npm test` **1223 + 63 = 1286**, 0 fail / 0 skip (4 new proxy tests). The API's `VELORA_API_ORIGIN` in the test points at discard port 9 — the runner isolates each file in its own process, so no cross-file env leakage.
- **Migration state:** `MG-SEC-HSTS` OPEN → **PARTIAL** (RECORDED_RUNTIME at the app layer, both sides unit-pinned). What remains is genuinely deploy-gated: whether the PRODUCTION edge (Railway's reverse proxy / any CDN) preserves the header — the same evidence class as MG-WORKER-DEPLOY, unreachable from this sandbox. Register: 16 OPEN / 28 PARTIAL / 12 CLOSED.
- **Authorization:** owner instruction 2026-10-05 (autonomous gap implementation). No owner decision needed — the change restores Legacy's exact standing behavior; no stronger commitment (preload/includeSubDomains) was added, deliberately.

## AC-30 — 2026-10-05 · MG-API-MISSING-ROUTES re-audited on the integrated tree: 76→27 absent; auth alias attempted and reverted on OD-14

- **Commits:** this change (register/CHANGE_LOG only — the code attempt was reverted; see below).
- **Method:** per-entry re-enumeration of the audit §4.2 missing set against the integrated tree's actual route surface, extracted from the literal route tables + regex dispatchers of every `*Routes.ts` + `kernel/server.ts` (non-test source only).
- **Result:** of the audit's 76-entry missing set (78 at per-entry granularity): **49 now have modern counterparts** (phases 1–7 + AC-28 work: accounts sync/connect, all 7 admin-AI, all 7 admin communications incl. copilot/draft/translate, admin identity trio via `rbac/self`+`rbac/matrix`, providers verify/test-connection, security logins/signups, 9 of 13 user-management reads/actions incl. login-history and session revocations, user AI 3, support 5, dashboard summary/equity-curve via `/analytics/*`), **2 are recorded intentional non-migrations** (webhook test — `webhookRoutes.ts:13`; auth alias — **OD-14**), and **27 remain absent**: 21 admin blocks already owned by the AC-16 phase-8/9 inventory, 4 owner-decision-gated (invitations, per-user subscription [SUBMAP], admin create-user, dashboard/strategies [R9]), extract-screenshot (MG-AI-OCR — its `trades:extract-screenshot` rate-limit bucket is already declared in contracts, reused by the Telegram image path), content-translations/lookup (MG-SCHEMA-MAPPING — Legacy's cache-only content-localization endpoint needs the `content_translations` storage + worker ingestion).
- **The OD-14 finding (governance event, recorded):** the one route classified "actionable now" — the Legacy alias `POST /api/v1/auth/resend-verification-email` — was implemented (same handler, same 4/3600 bucket per Legacy `index.php:268-270`, alias-parity tests green), then the existing `rateLimitRoutes.test.ts` failed its exactness guard and revealed the recorded decision: **OD-14 — "exactly ONE canonical resend endpoint; the Legacy alias is deliberately not reproduced"** (`authService.ts` "single canonical endpoint — OD-14"; pinned by test). The implementation was **reverted in full** (`git checkout` of `server.ts` + both test files; 26/26 re-green). A recorded owner decision is never overridden autonomously (AGENTS.md rule 9). The audit's gate-1 complaint ("only one carries a recorded decision") is now stale for this route too: two of the 76 carry records.
- **Migration state:** `MG-API-MISSING-ROUTES` OPEN → **PARTIAL** (RECORDED_RUNTIME): the row becomes an umbrella — every remaining absence is owned by a specific gap row (MG-ADMIN, MG-AI-OCR, MG-SCHEMA-MAPPING) or a named owner decision (SUBMAP, R9, invitations/create-user policy). Register: 15 OPEN / 29 PARTIAL / 12 CLOSED.
- **Verification:** reverted tree re-verified: `rateLimitRoutes` + `passwordResetRoutes` 26/26; full `npm test` on the reverted tree ran during the attempt cycle (1223 + 63 green apart from the two intentionally-failing guard tests that triggered this finding, both explained above); typecheck 0 errors after a `--force` project rebuild (fresh-sandbox `tsbuildinfo`/`dist` desync — environmental, not a tree defect).
- **Environment notes (fresh sandbox):** `node_modules` and the tesseract binary do not survive sandbox restores — `npm install` + `apt-get install tesseract-ocr` were re-run before any battery; three executable scripts lost their exec bit in the restore and were re-chmodded (`ops/backup/create_pg_backup.sh`, `ops/backup/sample_e2e.py`, `tools/run-pg-batteries.sh`).
- **Authorization:** owner instruction 2026-10-05 (autonomous gap implementation). The revert itself is the governance-required action; no new owner decision was created — OD-14 already governs the alias.

## AC-31 — 2026-10-05 · MG-SCHEMA-MAPPING re-audited: full 45-table legacy inventory reconciled

- **Commits:** this change (`db/MIGRATION_MAP.md` + register rows).
- **What changed:** the audit-era "8+ tables without target" claim is replaced by a complete per-table reconciliation (new §"Legacy table inventory reconciliation (AC-31)" in `db/MIGRATION_MAP.md`). 45 legacy tables (deduplicated across `_database/database_corrected.sql` + `api/database/migrations/*.sql`): **33 mapped** — 27 direct/renamed + the 6 ai_* attempt/analysis/report tables that phase 7 deliberately collapsed into ONE `ai_coaching_logs` ledger; **3 replaced or dropped by design** (`sync_jobs` → pg-boss + reservations + state, `metaapi_operations` → fills/events/webhooks evidence, `support_message_translations` → never created empty); **9 without targets**, each owned by a named capability/phase/decision — none silently dropped. Column-level: only the users subscription lifecycle remains unmapped (OD-AC-SUBMAP, unchanged).
- **Verification:** STATIC — every claim is a table-name-to-migration citation, re-derivable by grepping `CREATE TABLE` across both repos (commands recorded in the map section).
- **Migration state:** `MG-SCHEMA-MAPPING` stays **PARTIAL** (its own remainder is now precisely the 9 owned absences + SUBMAP). Register: 15 OPEN / 29 PARTIAL / 12 CLOSED.

## AC-32 — 2026-10-06 · MG-FRONTEND-SURFACES + MG-I18N-COVERAGE: the content surfaces become real (performance, wallet, intelligence, markets, news, blog, privacy, terms, checkout)

- **Commits:** this change (web app surfaces + messages + guard test + register rows).
- **What changed (capability-first, not template copies):**
  - **performance** — monthly PnL re-derived through `Intl` persian-calendar month attribution (`jalaliMonthIndex`/`jalaliMonthLabel`), so FA months attribute identically to Legacy's Jalali grouping without any hand-rolled calendar; render is locale-aware; the stale `JALALI_MONTH_KEYS` table is gone.
  - **wallet** — real `listAccounts` + `getSubscriptionMe`: totals, per-account table, subscription card. Capability-state keys (`surface.realAccounts/account/provider/status`) authored in `wallet.json` fa+en (probes proved `common.*` had no such strings — nothing duplicated).
  - **intelligence** — real `GET /api/v1/ai/status` + `getAiCoachInsights(10)` + `POST /api/v1/ai/weekly-report` (`period_start` = ISO date −7d). Header comment cites the legacy verbatim anchor `pages.intelligence.simulatedAnswer` — the legacy page simulated; Modern renders the real AI ledger.
  - **markets** — legacy watchlist keys only + `surface.snapshotNote`; NO fabricated quotes (Legacy's page was a static demo; Modern says so instead of inventing data).
  - **news** — static key cards `CARDS[when,teaser]×4` + `SIDEBAR×3` from the ported news chunk (Legacy shipped a static page; parity is the content, not a fake feed).
  - **privacy/terms** — shared server components `features/legal/{PrivacyDocument,TermsDocument}.tsx` (locale prop) + thin route wrappers: FA canonical (`/privacy`, `/terms`) + EN mirrors (`/en/privacy`, `/en/terms`) with `generateMetadata`; terms carries the full 8-section order (service→accept→account→payments→risk→data→changes→contact) + footer notice.
  - **checkout** — `CheckoutForm.tsx` (client): region/method cards shown NON-ACTIVE with `surface.providerNote` (legacy rial/crypto had no real gateway — honest state), interval month/year toggle, continue → `postSubscriptionCheckout` → `res.url` redirect; `503 BILLING_NOT_CONFIGURED` → `surface.billingOff`, `401` → `surface.loginRequired`. Routes `/checkout`, `/en/checkout`, alias `/fa/checkout`.
  - **blog** — `posts.ts` is the provenance record: the ordered `data-i18n` key sequences of Legacy's five post pages (chrome keys excluded); FA + EN index and `[slug]` pages with `generateStaticParams`; EN mirrors link under `/en/blog/<slug>`.
  - **i18n** — +10 namespaces ported byte-verbatim (markets, news, performance, wallet, intelligence, privacy, terms, checkout, blog) + 107 `common.*` lifts from Legacy's canonical root catalog (Legacy loaded root + chunks together; the lifts are byte copies, not rewrites). `PUBLIC_ROUTES` += the four new public paths. `profile.json` folded into `settings`/`common` (21 duplicate keys removed — one-string-one-home). All shared styling in `features/content/styles/content.css` imported by the root layout.
- **Guard test:** `apps/web/src/i18n/contentSurfaces.test.ts` — 5/5: (1) fa/en key parity for all 10 content namespaces + wrappers; (2) every `t()` key extracted from the 8 rewritten page files resolves through the real `createTranslator`/`messagesFor` in BOTH locales; (3) every `posts.ts` key resolves; (4) legacy chunks byte-verbatim in modern (anchor keys incl. the AI-simulation anchor); (5) the root-catalog lifts byte-identical to `legacy/public/locales/{fa,en}.json`. The parity test taught the digit rule twice: authored values must already be Latin-digit (product rule), and `t()`-equality assertions must allow runtime latinization (byte equality is the verbatim test's job).
- **Coverage honesty:** raw fa=en = 1,263/1,994 (63%). Live-reference extraction over every Legacy HTML/JS file: 1,444 keys actually referenced, 411 missing — all owned: admin 187 (MG-RBAC-VOCAB), accounts 37, trades 28, dashboard 26, ai 13, nav/common/auth 63 (shell), and 45 INTENTIONALLY_NOT_MIGRATED (31 duplicate EN blog key-family — same articles already served from the ported chunk family; 14 legacy `test-localization.html` fixtures). No dead-key padding: coverage grows only with real surfaces.
- **Verification:** `npm run typecheck` 0 errors (one fresh-sandbox `--force` rebuild needed); web build green — all new routes compiled (`/blog/[slug]`, `/en/blog/[slug]`, `/checkout`, `/en/checkout`, `/fa/checkout`, `/en/privacy`, `/en/terms`, …); full `npm test` = 1,291 pass / 0 fail (1,228 node + 63 PGlite); `contentSurfaces` 5/5; `localeKernel` 4/4. Import-depth regressions in the `en/` mirrors were caught by tsc and fixed (en pages sit one level deeper than their FA siblings).
- **Migration state:** `MG-FRONTEND-SURFACES` OPEN→PARTIAL (remainder: `/admin` surface = MG-RBAC-VOCAB; `/support` was Phase 5); `MG-I18N-COVERAGE` PARTIAL (63%, remainder mapped to queue items). Register: 15 OPEN / 29 PARTIAL / 12 CLOSED (both rows were already PARTIAL; AC-32 advances their evidence, not their count).
- **Authorization:** owner instruction 2026-10-05 (autonomous gap implementation). No new owner decisions; MG-AI-OCR's rate-limit bucket reuse and OD-14 remain as recorded.

## AC-33 — 2026-10-06 · MG-EMAIL-TYPES: all ten transactional email types become real (template, copy, icons, gating, delivery log)

- **Commits:** this change (domain + api + migration + tests + register).
- **What changed (capability port of Legacy NotificationService/EmailTemplate/Mailer, @edede31 read-only):**
  - **Domain (pure):** `packages/domain/src/notifications/` — `emailCopy` (88 keys/locale byte-verbatim; one-time extraction proof byte-identical), `emailTemplate` (the XHTML table shell: fa-RTL/en-LTR, gold identity, CID logo + per-type icon, localized footer with manage-preferences link; plus `htmlToPlain` so no mail is HTML-only), `emailLocale` (stored-locale-first resolution + the "Hi ," fix), `emailMessages` (all ten builders; BUG-A3 `localizeEmailCopy` — catalog keys translate, unknown keys fall back, raw keys never render).
  - **MailPort/Resend:** `inlineImages` → Resend `attachments[{filename,content,content_id}]`; `reply_to` + RFC 2369 `List-Unsubscribe` set at the provider level exactly like Legacy `Mailer::sendResend`; CID capped at 127 (Legacy mb_substr). OD-12 untouched — Resend stays the only provider; fail-closed on missing key.
  - **NotificationService:** ten send methods; preference gating EXACTLY where Legacy gated (welcome→welcome_email, new-device→security_alerts, first-trade→trade_notifications, achievement→achievement_notifications — the six essential/security mails are never a preference); missing icon asset ⇒ failed send + failed log row (sendWithIcon parity); every attempt logged (sent/failed + reason) — never throws.
  - **Migration 0030:** `email_notifications` (Legacy's ten event types as a CHECK list), `user_achievements` (UNIQUE(user_id, achievement_key) — idempotent unlock at the storage boundary), and `user_devices` **extended, not duplicated** — 0001 already had the table with the race-closing UNIQUE(user_id, fingerprint); 0030 adds Legacy's `ip_address`/`user_agent`. This makes the login path the table's FIRST writer, closing the recorded MG-DEVICE-TRACKING gap (admin console device list becomes real).
  - **Wiring:** authService (register/resend → branded verification; FIRST verification → welcome + EMAIL_VERIFIED unlock + email; login → device fingerprint → new-device alert once per (ip|ua); forgot/reset/change → reset + password-changed mails; anti-enumeration uniforms preserved bit-for-bit); TradeService `onTradeCreated` → the tested `FirstTradeNotifier` (active-count===1 → first-trade email + FIRST_TRADE unlock; ONE shared instance serves the HTTP and Telegram-journal paths, as Legacy's single TradeService did); SupportService (createTicket → desk mail to SUPPORT_NOTIFY_EMAIL; first admin TEXT reply → user mail; internal notes excluded — Phase 9A parity).
  - **Assets:** the 9 icon/logo PNGs vendored md5-identical under `apps/api/assets/email-icons/` (40KB).
- **Bugs found & fixed while testing (all caught by the new tests):** a `require("node:crypto")` in ESM (silent catch had hidden it — the device fingerprint threw on every login, killing the alert); the pg test initially asserted a REJECTION from `log()` whose contract is fail-open (the test now proves the DB state); migration 0030's first draft re-created `user_devices` that 0001 already owned — caught by the PGlite schema dump showing the 0001 column shape, rewritten as ALTER per the reuse-not-duplicate house rule.
- **Verification:** domain 7/7; mail adapters 12/12 (3 new); NotificationService 7/7; auth wiring 6/6 (real icons, real builders, LogMailProvider outbox); FirstTradeNotifier 6/6; support wiring 3/3; trades hooks 3/3 (32/32 file); PGlite stores 3/3 (fail-open log, UNIQUE race-closure, newest-first ordering). Full battery **1,263 + 63 = 1,326 pass / 0 fail**; `tsc -b --force` clean across the monorepo (fresh-sandbox desync needed one `--force`); `npm run secret-scan` 0 findings.
- **Migration state:** `MG-EMAIL-TYPES` PARTIAL → PARTIAL with the code capability complete; what remains is deploy-gated runtime evidence (a real Resend delivery — the MG-WORKER-DEPLOY evidence class) and the OD-gated invitation wiring (admin-invite email implemented + tested, unwired by the recorded owner decision). Register: 15 OPEN / 29 PARTIAL / 12 CLOSED.
- **Authorization:** owner instruction 2026-10-05 (autonomous gap implementation; continuation confirmed 2026-10-06 with "no need to rebuild" — the web build was not rerun for this API/domain-only change).

## AC-34 — 2026-10-06 · MG-RBAC-VOCAB reconciled: 15 of 24 legacy permissions enforced; remainder precisely owned

- **Commits:** this change (contracts test + register row).
- **Method:** re-enumeration of Legacy `api/src/Auth/Role.php` @edede31 (24 permission constants, admin=18 grants, super_admin=24, six SA-exclusive) against the Modern vocabulary AND its enforcement points (every declared permission was verified to guard a real route: admin console READ_ROUTES table, AI admin route table, user management, support, rbac self/matrix — several guards found via `requireAuthority`/`permissionFor` seams the first grep missed).
- **Result:** 15 legacy permissions are enforced on real operations — 10 VERBATIM names + `users.suspend`/`users.activate` merged into `users.manage_status` (one status-mutation operation, documented) + `communication.view`/`communication.reply` as `support.tickets.view`/`support.tickets.manage` (the Phase 5 rename). Modern adds three diagnostics legacy lacked (`rbac.self.view`, `admin.panel.access`, `rbac.matrix.view`).
- **SA-exclusive parity:** Legacy's six super-admin-only permissions split 3/3 — `users.change_role`, `audit.view_sensitive`, `aiRouteManage` are landed SA-only; `system.settings.manage`, `feature_flags.edit`, `integrations.manage` MUST NOT be declared until their operations exist (the no-fabricated-surface rule, now enforced by test).
- **Remainder, each with a named owner:** `settings.view` + `system.settings.manage` were DEAD IN LEGACY (declared "reserved (Module K)", zero controller references — nothing to migrate, INTENTIONALLY_NOT_MIGRATED); `users.create` (admin create-user policy) and `users.manage_subscription` (OD-AC-SUBMAP) stay owner-gated; `system.logs.view`, `billing.view`, `feature_flags.view`/`edit`, `integrations.view`/`manage` are owned by their MG-ADMIN segments and land with those operations — exactly what this row's closure criteria states.
- **Guard test:** 6 new tests in `packages/contracts/src/rbac.test.ts` (23/23): the verbatim-ten exist; the merge is granted to both roles legacy granted; the support rename holds for both roles; exactly the three landed SA-exclusives exist and are SA-only; the seven unported names are asserted ABSENT (a future declaration without its operation fails the build); grant parity — admin holds nothing legacy did not grant (minus the two modern diagnostics).
- **Verification:** rbac 23/23; contracts suite green; register row updated with the full diff table.
- **Migration state:** `MG-RBAC-VOCAB` PARTIAL (vocabulary work complete; the row now tracks its 9-name remainder through the MG-ADMIN segments and the two owner decisions). Register: 15 OPEN / 29 PARTIAL / 12 CLOSED.
- **Authorization:** owner instruction 2026-10-05 (autonomous gap implementation).

## AC-35 — 2026-10-06 · MG-METAAPI-CADENCE: cadence made operational config; manual trigger verified landed; default value raised as OD-AC-CADENCE

- **Commits:** this change (worker scheduler + tests + register).
- **What changed:** the audit's "hourly vs per-minute" finding decomposed into its three parts. The MANUAL TRIGGER half of the closure criteria was already landed (POST /accounts/{id}/sync → 202 {jobId,status,deduplicated}); Modern is WEBHOOK-FIRST where Legacy was poll-only, so the scheduled tick is the safety net for missed webhooks, not the primary feed. The sweep cadence is now operational config: `METAAPI_SYNC_CRON` (strict 5-field minute-precision grammar, range-checked, day-names deliberately rejected; invalid values fall back to the audited default LOUDLY — `scheduler.cadence_rejected` warn). The DEFAULT IS UNCHANGED (hourly) because changing it is a business call; the value is recorded as **OD-AC-CADENCE** with three explicit options (keep hourly / `*/5` recommended middle ground / legacy per-minute parity at 60× volume). Legacy's reference cadence is pinned as `LEGACY_SYNC_CRON`.
- **Tests:** 5 new (default unchanged, absent/empty env silent, valid override verbatim incl. `*/5` and legacy parity, invalid values fall back loudly incl. 6-field crons + range violations, grammar/range validators) — worker suite 58/58.
- **Verification:** worker tests green; `tsc -b` clean. Runtime cadence behavior is deploy-gated (MG-WORKER-DEPLOY evidence class) — the scheduling mechanism itself is the pg-boss native cron already unit-pinned.
- **Migration state:** `MG-METAAPI-CADENCE` PARTIAL — the code half of the closure criteria is met (cadence decided-and-configurable + manual trigger); the row now waits on OD-AC-CADENCE (default value) and the deploy-gated runtime evidence. Register: 15 OPEN / 29 PARTIAL / 12 CLOSED; owner_decisions now 10.
- **Authorization:** owner instruction 2026-10-05 (autonomous gap implementation). The default was deliberately NOT changed autonomously — governance rule (business ambiguity → owner decision).

## AC-36 — 2026-10-06 · MG-OPS-TOOLING: legacy ops-probe capability landed as read-only `ops:verify` CLI; row CLOSED

- **Commits:** this change (verify core + CLI + battery + README + register).
- **What changed:** the legacy `velora-mgmt` probe capability (audit §17.1) decomposed into its four parts. Session-status report → already covered by `tools/agent-context.mjs` (ADR-017); backup probe → already ported and extended (`ops/backup/`, audit §17.2); CI cost guard → moot (GitHub Actions disabled per owner cost policy, documented in agent-context.mjs). The remaining gap — a SAFE, LEAST-PRIVILEGE, READ-ONLY live-environment probe — is now `npm run ops:verify` (`tools/ops-verify.mjs` + `ops/verify/verifyEnvironment.ts`): server identity, migration-ledger diff vs `db/migrations/` files (unmigrated AND phantom entries), per-table live row counts, connection-user privilege audit (report-only, like Legacy), FK orphan scan with constraint attribution. `--json` machine mode, `--check` gate mode (exit 1 on drift, exit 2 on failure). Driver errors log as CODE ONLY (message bodies can embed host/port); DSN passwords masked. Without `DATABASE_URL` it verifies a disposable PGlite instance migrated from the real files (labeled dev-evidence).
- **Read-only law, pinned twice:** AC36-05 runtime spy (every executed statement must begin with SELECT) and AC36-06 static scan of the core source with comments stripped (no INSERT/UPDATE/DELETE/TRUNCATE/DROP/ALTER/CREATE/GRANT/REVOKE). The FK-orphan test had to DISABLE the trigger to plant its corruption — PostgreSQL itself refuses to produce orphans through normal writes, which is the exact drift class the probe exists to catch post-legacy-import.
- **Tests:** 6 new (`db/tests/opsVerify.test.ts` AC36-01..06) — clean verdict on fully migrated instance, missing-ledger drift, phantom-ledger drift, orphaned-FK drift with attribution, both read-only pins. Full battery **1,343/1,343 pass**, `tsc -b` clean (5 projects), secret-scan 0 findings. Also fixed a latent `noUncheckedIndexedAccess` error in `syncCadence.ts` surfaced by the full rebuild (behavior unchanged, AC-35 tests still 5/5).
- **Verification:** all evidence above executed in this session; PGlite-labeled where applicable (live-PG path runs wherever `ops:verify` executes with DATABASE_URL — deployment verification class). Per-domain recompute probes (PnL etc.) intentionally deferred to MG-DATA-MIGRATION, which reuses this core.
- **Migration state:** `MG-OPS-TOOLING` **CLOSED/TESTED**. Register: 14 OPEN / 29 PARTIAL / 13 CLOSED (57 rows total incl. this row's union lineage).
- **Authorization:** owner instruction 2026-10-05 (autonomous gap implementation); CLOSED per governance requires owner sign-off — requested in the register row's closure_note.

## AC-37 — 2026-10-06 · MG-WORKER-DEPLOY local-evidence half + MG-DATA-MIGRATION rehearsal re-run + ops:verify live-PG hardening

- **Commits:** this change (evidence docs + register + probe hardening + tests).
- **Environment unlock:** real PostgreSQL 17.11 installed in the migration workspace (disposable local cluster; GitHub Actions remain disabled per owner cost policy — this is not a CI substitute, it is the same evidence class the runner produces). **Real-PG battery sweep: 33 batteries × forward+reverse = 66 runs, 642 tests, 0 fail, 0 skipped → REAL-PG EVIDENCE: PASS** (logs: `docs/state/evidence/pg-batteries-20261006T0444Z/`).
- **MG-DATA-MIGRATION (rehearsal at HEAD):** `tools/load_rehearsal.ts` re-run on the disposable real PG — all A-gates/B-gates/gate-6 PASS, id-preserving load parity exact (commission 16.50, swap -1.00, net 1484.50), verdict REHEARSAL_PASSED (SYNTHETIC FIXTURE). Owner blockers unchanged (OD-AC-ADR004 sampling, real export).
- **MG-WORKER-DEPLOY (AC-37 evidence doc):** full deployment-contract sequence executed end-to-end (provision pre → migrate as `velora_migrator` via `SET ROLE velora_owner` → provision post → privilege grid 8/8 incl. negatives). Worker booted **as the real least-privilege `velora_worker` role** (superuser caveat of the 2026-10-03 proof remedied), pg-boss timekeeper fired the **MetaAPI sync tick for the first time anywhere** — 7 fires / 7 completed / 0 failed, `count=0` fail-closed (zero connected accounts ⇒ zero manufactured jobs, zero external calls, dummy token never used). `METAAPI_SYNC_CRON="* * * * *"` override proven live in `pgboss.schedule` (AC-35 runtime evidence; analytics `20 * * * *` and FX `30 16 * * *` defaults untouched). Graceful SIGTERM shutdown logged. Row stays OPEN only on the owner-gated hosting deploy (OD-AC-WORKER) + the two externally-gated ticks (FX→ECB, copy→transport).
- **MG-OPS-TOOLING hardening (found by running the probe for real):** live-PG run as `velora_worker` failed 42501 (correctly denied `audit_log`/`auth_events`/`provisioning_operations`/`user_credentials`) → probe now RECORDS privilege boundaries (`nopriv` counts, `fkUnverifiable` constraints — never a crash, never drift). **Real bug found+fixed:** `array_agg(name)` returns a wire string under node-postgres (PGlite returns arrays — the battery hid it), so every FK constraint was silently skipped and "no orphaned child rows" was fabricated. Fix: `json_agg` (both drivers parse) + fail-closed guard (non-array payload aborts) + the report prints `constraints checked: N` (74/74 as admin; 68 checked + 6 nopriv as worker). Battery now 7/7 (AC36-06b + `fkConstraintsChecked >= 50` pin). **Lesson recorded:** PGlite-backed tests alone cannot certify driver-serialization behavior — a claim like "SELECT-only probe works live" needed the live run.
- **Migration state:** MG-WORKER-DEPLOY OPEN (deploy owner-gated; local evidence complete); MG-DATA-MIGRATION PARTIAL (unchanged blockers); MG-OPS-TOOLING stays CLOSED with hardening recorded.
- **Authorization:** owner instruction 2026-10-05 (autonomous gap implementation).

## AC-38 — 2026-10-06 · MG-BACKUP-RESTORE: restore drill re-run at migrations HEAD 0030 with data-loaded source

- **Commits:** this change (drill evidence + register).
- **What changed:** the 2026-10-04 drill predated migrations 0026–0030; this refresh re-ran the full chain at HEAD against a DATA-LOADED source (the rehearsal fixture loaded id-preservingly: 4 users / 3 accounts / 5 trades / 2 exits): real producer backup (31,853 bytes, sha256 `5bd21bcb4880…`), `pg_restore` into the disposable `_drill` target in 406 ms, catalog parity PASS across **56 tables / 49 numeric columns**, ledger head `0030`, application smoke **11/11** against the RESTORED copy, and the ADR-012 deployment gate verdict recorded as **REJECT** (release_tag absent, storage NONE — a created-but-not-stored backup must not pass the gate; fail-closed semantics re-proven).
- **Environment:** disposable local PostgreSQL 17.11 (reinstalled after sandbox recycle; same class as the 2026-10-03/04 drills — local, honestly labeled, NOT Railway staging).
- **Verification:** drill verdict RESTORE_DRILL_PASSED, evidence JSON in-repo; working tree battery/tsc/secret-scan gates re-verified post-reinstall (npm ci; suites unchanged since `80f6720`).
- **Migration state:** MG-BACKUP-RESTORE PARTIAL — machinery + local evidence now at HEAD; closure still waits on the three owner items (offsite upload credential, staging/prod drill, RPO/RTO).
- **Authorization:** owner instruction 2026-10-05 (autonomous gap implementation).

## AC-39 — 2026-10-06 · remote sync: integration branch PUSHED (state recorded)

- **What:** first remote sync of the integration lineage. Inventory check (owner request, with owner-provided token) found **remote main @ `0e9c4d7` with NONE of the AC-27..AC-38 work** — the earlier belief that AC-32 (`73bacfd`) was pushed was incorrect (verified: no AC-2x/AC-3x commit is reachable from any remote ref; remote has the two raw source lineages and the PR #8 governance campaign only).
- **Action:** pre-push secret-scan PASS (0 findings) → `git push` of `integration/reconcile-lineages` @ `7c6e246` as a NEW remote branch — **74 commits / 463 files (+59,460/−919) over remote main** — verified after push via `git ls-remote`.
- **Deliberately NOT done:** remote `main` untouched at `0e9c4d7`; merge/promotion remains owner-gated (repo PR pattern; https://github.com/veloratrade/velora-modern/pull/new/integration/reconcile-lineages). No tags pushed (MG-OBS-2 unchanged).
- **State sync:** `docs/state/current-state.json` + `CURRENT_STATE.md` updated (branch_work.pushed, current_verified.verification, last_battery re-captured at 7c6e246, last_updated 2026-10-06) in this same change.
- **Security note:** the owner-provided fine-grained PAT was used only in transient command URLs (never written to any file, .git/config, or credential store — secret-scan re-run PASS after the change). Owner should rotate it after use, as it was shared in conversation.

## AC-40 — 2026-10-06 · OWNER-INSTRUCTED PROMOTION: remote main fast-forwarded to the integration tip

- **What:** owner instruction ("همه رو main کنیم") — remote `main` fast-forwarded `0e9c4d7` → `be4732d` (the `integration/reconcile-lineages` tip). Fast-forward only: no force, no history rewrite; branch history fully preserved. Local `main` fast-forwarded to match.
- **Why now:** the owner reported seeing only SOME files on GitHub — they were viewing the default branch `main`, which AC-39 had deliberately left untouched at `0e9c4d7` pending the owner-gated promotion decision. That decision was made in-chat by the owner; this change executes it.
- **Verification:** pre-push secret-scan PASS (0 findings) → push → `git ls-remote` confirms `refs/heads/main = be4732d` (= `refs/heads/integration/reconcile-lineages`). main now contains the full lineage: PR #8 governance campaign, both source lineages (AC-27 merge), AC-28..AC-38 campaign, AC-39 sync record.
- **State sync (same change):** `current-state.json` (`current_verified.modern_sha` → `be4732d`, `branch_work.pushed=true`, `pushed_at`, heads/notes) + `CURRENT_STATE.md` State row.
- **Not done:** no tags pushed (MG-OBS-2 unchanged); Legacy repo untouched (READ ONLY).
