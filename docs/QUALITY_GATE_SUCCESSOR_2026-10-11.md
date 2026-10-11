# Quality Gate Successor — 2026-10-11

**System:** Agent Context System (ADR-017) · **Successor to:** `RESIDUE_SWEEP_2026-10-10.md` + `docs/state/current-state.json` `f304317` + CI run `38110274764`
**Branch:** `chore/readiness-successor-healthcheck-artifact-2026-10-11` at `0ae8832` → this document extends to new head (see `CHANGE_LOG.md` AC-57+)
**Purpose:** Single doc linking current quality gates, their test evidence, execution requirements, known environment-dependent failures, and remaining gaps. It is the `1468 bug→tests` trace: `1,395` general + `73` PGlite = `1,468` total, `1,467` pass / `1` honest `OCR_UNAVAILABLE` fail — see §4 and `aiCapability.test.ts:578`.

> **No live verification is claimed from local tests.** `RECORDED_RUNTIME` here means “recorded on a disposable host for the exact commit it was captured on” (CURRENT_STATE.md §3). Deployment-verified behavior is separately labeled `NOT_VERIFIED` until a real Railway / Telegram / provider round-trip exists.

---

## 1. Gate inventory — what must be green before any merge to `main`

| # | Gate (workflow / script) | File | What it checks | Execution requirements | Evidence (2026-10-11 @ f304317) | Cost control | Still deployment-verified? |
|---|---|---|---|---|---|---|---|
| 1 | **CI — verify** | `.github/workflows/ci.yml` (`verify` job) | `typecheck` + `unit+contract tests` + `migration tests (PGlite)` + `secret-scan` — fails closed on any step | Node 20, `npm ci` (67 packages), `tesseract-ocr`+`eng` installed in CI only (2-line `sudo apt-get`), 15-min timeout, `cancel-in-progress:true`, `runs-on:ubuntu-latest` standard | `npx tsc -b` **0 errors** (5 projects: contracts/domain/api/worker/web) · `node tools/run-tests.mjs` **1394/1395 general (1 honest OCR fail) + 73/73 PGlite = 1467/1468 pass** · `npm run test:migrations` **19/19** `0001→0035` forward-only · `bash tools/secret-scan.sh` **PASS 0** · CI run `38110042090 failure (129 not ok isAvailable===true)` → after `57875c1` install `38110274764 success` `verify completed success` | concurrency per-ref, no cache, no schedule, minimal permissions | No — local run is `RECORDED_RUNTIME`; the same job on `main` with the same tesseract install is the live CI gate (now required via branch protection `strict:true contexts:["verify"]`) |
| 2 | **Backup gate (reusable, fail-closed)** | `.github/workflows/backup-gate.yml` + `ops/backup/backup_gate.py` | 6-field evidence contract **verbatim** from `veloratrade/veloratrade@a8eabac` + 3 Modern additions (see §2) — no skip/force/bootstrap path | Python 3, `evidence/evidence.json` artifact, `EXPECTED_ENV`, `EXPECTED_COMMIT_SHA`, optional `INAPPLICABLE_BACKUP_TYPES`, `MAX_BACKUP_AGE_SECONDS` | `python3 -m unittest discover -s ops/backup/tests` **42 tests (22 mandated)** covering valid, stale, `NOT_APPLICABLE`, tampered SHA, etc. — see `ops/backup/tests/test_*.py` | 10-min timeout, `contents:read` | **Implemented** is the Python `evaluate_backup_gate` (pure logic, no I/O); **deployment-verified** needs a real `pg_dump` inside Railway + `release_tag` + `STORAGE_VERIFIED` round-trip (§2) — `NOT_VERIFIED` until executed against `staging` with Railway token |
| 3 | **Deploy staging (gated)** | `.github/workflows/deploy-staging-gated.yml` | `CI → backup → verify → store → storage-verify → backup_gate → deploy controller → staging` — every stage `needs:` hard dependency, `dry_run:true` default (push proves chain, never deploys), `workflow_dispatch dry_run:false` required to deploy | `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE`, `RAILWAY_DB_SERVICE`, `RAILWAY_ENVIRONMENT=staging`, `railway ssh` for backup inside network (no public PG), `timeout 25/30m` | Chain proven on `reconcile/foundation-first` pushes (logs of `ci` + `backup` steps) — staging deploy itself **not proven** this session (no Railway token, no secret) | `concurrency:group:deploy-staging cancel-in-progress:false`, no public DB, `tcpProxies=0` remains | **Implemented** as workflow graph; **deployment-verified** needs Railway dispatch with `dry_run:false` + healthcheck suite post-deploy — `NOT_VERIFIED` |
| 4 | **Healthcheck suite (reusable)** | `.github/workflows/healthcheck-suite.yml` (called by `healthcheck-staging.yml`) | 8 stages (R-01 added 2026-10-11): `1 GET /health B-8 envelope`, `2 Helmet x-frame-options DENY`, `3 404 NOT_FOUND envelope`, `4 guard probes 401/400 (side-effect-free)`, `5 GET / 200 + footer marker (velora/<footer, >800b)`, `6 robots.txt 200 + env Disallow + sitemap.xml staging 404 / prod 200|404`, `7 GET /dashboard unauth → 302/401/403 + no-store/DENY (app shell noindex edge contract)`, `8 version-drift warn` | `STAGING_APP_URL` var (https origin), `guard_probes` bool, `confirm_production_probes` phrase | Python `dedent` compile **OK**, `yaml.safe_load` **OK**, `NoRedirect` + 30s timeout, side-effect-free GET only; type/payload guard probes verified in `server.test.ts` (CSP, 401/403) | 10-min timeout, `contents:read`, manual + `workflow_call` | `RECORDED_RUNTIME` for header/probe logic; **deployment-verified** needs live `https://staging-modern.veloratrade.ir` + `https://veloratrade.ir` fetches — `NOT_VERIFIED` (no host in this sandbox) |
| 5 | **Secret-scan** | `tools/secret-scan.sh` (also in `ci`) | Gitleaks-class: forbids `BEGIN PRIVATE KEY`, `aws_secret`, `.env` secrets, JWTs, `sk_live`, etc. — public repo policy | Bash, no creds | **PASS 0 findings** on every `f304317` and earlier | — | `RECORDED_RUNTIME` local |
| 6 | **Agent context** | `tools/agent-context.mjs` (ADR-017) | Audit SHA-256 integrity, `migration-gap-register.json` schema, drift (`governance_only_paths: docs/, AGENTS.md, README.md, MASTER_ROADMAP.md, tools/agent-context.mjs`), CHANGE_LOG logging, legacy HEAD | Node, `VELORA_LEGACY_PATH` env | `cargo`? → at `0ae8832` verified `f304317`, **CURRENT_GOVERNANCE_DELTA** `0ae8832 gov logged` `overall:CURRENT` | — | `STATIC` + `RECORDED_RUNTIME` |
| 7 | **Migrations (disposable PGlite)** | `db/tests/migrations.test.ts` via `npm run test:migrations` | Forward-only `0001→0035` (19 files) apply cleanly + rerun `[]`, canonical email UNIQUE, trades scales etc. | PGlite wasm, no `DATABASE_URL` | **19/19 pass** on every run from `cc09d54` → `f304317` | `NOT production evidence` (Gate 3B) | `RECORDED_RUNTIME` local; real-PG `*.pg.test.ts` are skipped without `DATABASE_URL` (shape verified only) |
| 8 | **Domain / contracts unit** | `packages/domain/*`, `packages/contracts/*`, `apps/api/*`, `apps/worker/*`, `apps/web/*` via `tools/run-tests.mjs` | Money math (ADR-001), ledger (ADR-002), webhook HMAC, CSP nonce, RBAC matrix 20/24, rate limits, achievement catalog, screenshots 4×8MiB/16MiB/12MP/6000px, consent `chars` only, etc. | Node 20, `node:test` + `tsx` | `screenshotExtraction 3/3`, `tesseractProvider 3/3`, `contentSurfaces 6/6 (fa latin 200 + toLatin)`, `aiRoutes 23/23 (1.1MiB screenshot →200 proven 24MiB cap, generic 1MiB 413)`, `telegramBot 19/19`, `telegramUpdateHandler 9/9`, `telegramStoreAdapter 7/7`, `telegramJournal 8/8 (0034+0035)` — full list in `CHANGE_LOG AC-55` | See ci §1 | `RECORDED_RUNTIME` local; live provider calls `NOT_VERIFIED` |

*Why `ci` is disabled at repo level in the file header:* cost policy — Actions `enabled:true` is opened only for an authorized window; the file deliberately has no `schedule`/`cache` and a short timeout to mirror `tools/check_github_cost_guard.py` from the PHP repo.

---

## 2. Backup artifact byte-identity — creation through `INTEGRITY_VERIFIED`

### 2.1 Chain (only sanctioned path is `deploy-staging-gated.yml`; see ADR-012 Amendment A)

```
create (inside Railway via `railway ssh`) → gzip -t → sha256 → evidence.json
  → verify (gzip -t + sha256 re-compute + table count)
  → official storage (upload bytes to offsite, return release_tag)
  → verify storage (GET bytes back, compare sha256)
  → evidence artifact (evidence.json)
  → GATE (ops/backup/backup_gate.py) → deploy controller → staging healthcheck
```

`create_pg_backup.sh` produces `db-backup-<env>-<timestamp>-<shortsha>.dump.gz` and writes `evidence.json` with:

| Field | Value | Verified how |
|---|---|---|
| `backup_id` | `db-backup-<env>-…` (or `files-backup-<env>-…` for the second chain) | `_ID_PREFIX` map + `db-backup-` prefix `re` |
| `release_tag` | official storage identifier (object key / version) — never empty | `_text` non-empty |
| `sha256` | `sha256sum` of the **verified** artifact (lowercase 64-hex) | `^[0-9a-f]{64}$` |
| `source_commit_sha` | `git rev-parse HEAD` at backup time (7..64 hex) | `^[0-9a-f]{7,64}$` |
| `verification_status` | `INTEGRITY_VERIFIED` (or `RESTORE_VERIFIED` after a successful restore drill) | exact string match |
| `environment` | `staging` or `production` (exactly) | `ENVIRONMENTS` tuple |
| `backup_type` | `database` (or `persistent_files` when declared inapplicable) | `BACKUP_TYPES` |
| `storage_status` | `STORAGE_VERIFIED` (separate from creation) | exact string — “uploaded is not verified” |
| `created_at` | ISO8601 UTC `%Y-%m-%dT%H:%M:%SZ` | parsed + optional `max_age_seconds` freshness |
| `table_count` / `byte_count` | advisory (not gating) | logged |

**Exact condition for `INTEGRITY_VERIFIED` to PASS the gate** (`evaluate_backup_gate`):

1. `verification_status` **exactly** `INTEGRITY_VERIFIED` (or `RESTORE_VERIFIED` is also accepted as `>= INTEGRITY_VERIFIED`; `CREATED` never passes).
2. `sha256` matches `^[0-9a-f]{64}$` **and** is the digest of the bytes that were also `gzip -t` verified (producer fails closed if `gzip -t` fails).
3. `backup_id` non-empty and prefixed `db-backup-{env}-` (or `files-backup-{env}-` for the files chain) — prevents cross-env or cross-type replay.
4. `release_tag` non-empty.
5. `source_commit_sha` valid hex and, when the caller supplies `EXPECTED_COMMIT_SHA`, it must match exactly — evidence must name the commit being deployed.
6. `environment` exactly the expected target (`staging` vs `production`).
7. `storage_status` **exactly** `STORAGE_VERIFIED` — a second GET after upload must return byte-identical bytes whose sha256 still matches the `sha256` field. This split exists because the Reference gate (`veloratrade/veloratrade`) treats `release_tag` as storage proof; Modern requires a real byte read-back.
8. `NOT_APPLICABLE` is allowed **only** when `backup_type` was declared inapplicable for this target **and** the caller supplied it in `inapplicable_types` (`persistent_files` is the only audited case: the only Railway volume is `postgres-volume`, the API performs no filesystem writes — see `ops/backup/README.md` `persistent_files = NOT_APPLICABLE`). It can never excuse a missing `database` backup (test `test_22b`).
9. Freshness: if `max_age_seconds` is supplied, `now - created_at` must be ≤ bound (policy stays a caller/owner decision, not silently invented in the gate).

Every failure is collected (`reasons[]`), not short-circuited, so an operator sees the complete list. There is **no** skip/ignore/force/continue-on-error path — `exit 1` blocks the deploy.

### 2.2 Implemented checks vs deployment-verified behavior

| Property | Implemented (in repo, needs no host) | Still deployment-verified (`NOT_VERIFIED` until a real run) |
|---|---|---|
| `backup_gate.py` pure logic | **Yes** — 42 tests (`ops/backup/tests/test_*.py` 22 mandated + edge cases), 90 Reference tests verbatim contract, no I/O | — |
| Producer `create_pg_backup.sh` | Shell + `pg_dump | gzip` + `sha256sum` — logic reviewed, `gzip -t` verified | **Needs** Railway `ssh` execution against `postgres.railway.internal` (no public endpoint), plus real `release_tag` from offsite storage and a real `STORAGE_VERIFIED` GET |
| Evidence artifact transport | `download-artifact` + `evidence.json` existence hard fail | Needs the artifact to be the one produced in-network by that exact `source_commit_sha` on `staging` |
| Retention / restore drill | `retention.py` rules (14 days after successor stored) + `restore_drill.mjs` against PGlite/disposable PG (`RESTORE_VERIFIED` path) | Needs offsite bytes restored to a running stack and a live app `smoke 11/11` + `ADR-012 gate REJECT` recorded on the drilled host |
| Offsite storage | Logic for `release_tag` + `STORAGE_VERIFIED` exists | Needs a real object store (R2/S3) with `GET` byte-identity proof |

Until a live run exists, the correct state is `PARTIAL` / `RECORDED_RUNTIME` local drill, not `CURRENT_RUNTIME_VERIFIED`.

---

## 3. Execution requirements — how to re-run each gate cleanly

```bash
# 0) historical audit integrity (always first)
sha256sum docs/audits/2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md
# must be 643fa1b554753d4dc584699261bfe996e668e6dcd2876abde53dc77b090aea2f (AUDIT INTEGRITY OK)

# 1) typecheck — 5 projects, strict
npx -p typescript tsc -b packages/contracts packages/domain apps/api apps/worker apps/web
# → 0 errors

# 2) secret scan — public repo policy (no keys in repo)
bash tools/secret-scan.sh
# → PASS (0 findings)

# 3) unit + contract — two batches (PGlite serialized, see tools/run-tests.mjs header)
node tools/run-tests.mjs
# → 1395 general (1394 pass, 1 honest OCR fail without /usr/bin/tesseract)
#   + 73 PGlite 73/73 = 1468 total (1467 pass, 1 fail honest)
#   with tesseract-ocr installed (CI 38110274764): 1395/1395 + 73/73 = 1468/1468 PASS
#   known transient: PGlite 5 SIGKILL OOM on tiny containers — the harness retries killed files alone once,
#   assertion failures are never retried; see tools/lib/testRunnerVerdict.mjs and runTestsVerdict.test.ts

# 4) migrations — disposable PGlite, NOT production evidence
npm run test:migrations
# → 19/19 pass (0001→0035 forward-only, rerun [])

# 5) backup system tests (gate logic, no host)
python3 -m unittest discover -s ops/backup/tests -p "test_*.py" -v
# → 42 passing (22 mandated)

# 6) agent context — drift / twin / CHANGE_LOG logging
node tools/agent-context.mjs            # text
node tools/agent-context.mjs --json    # machine
# → at f304317 → CURRENT_GOVERNANCE_DELTA (0ae8832 gov logged, overall CURRENT)
# → at 0ae8832 → CURRENT (head == verified f304317 + one gov sync)

# 7) healthcheck suite — live smoke (needs a real https origin, not in sandbox)
# Trigger via GitHub: workflow_dispatch healthcheck-staging with STAGING_APP_URL var
# or locally: BASE=https://staging-modern.veloratrade.ir ENVNAME=staging python3 ops/healthcheck...
```

*Sandbox restores:* `node_modules/` and `/usr/bin/tesseract` are **not** persisted (snapshot-excluded). `npm ci` + `sudo apt-get install -y tesseract-ocr tesseract-ocr-eng` must be re-run, and three backup scripts re-`chmod +x` (`create_pg_backup.sh`, `sample_e2e.py`, `run-pg-batteries.sh`) if their exec bits are lost.

---

## 4. Known environment-dependent failures — not regressions

| Failure | Where seen | Honest signal | Why it happens in this env | What a green run needs |
|---|---|---|---|---|
| `not ok 129 — OCR: the real tesseract binary reads a real screenshot` `isAvailable()===true` `false !== true` | `general` batch 1/1395 fail → `overall: fail` | **Honest**: `tesseractProvider.ts` header now says the test is unconditional and will fail rather than being skipped | This workspace has no `/usr/bin/tesseract` (deploy-gated; `infra/Dockerfile.api` intentionally has no `tesseract-ocr` until owner decides API image) | `sudo apt-get install -y tesseract-ocr tesseract-ocr-eng` (CI does this: `38110274764 success` 1395/1395). Live needs `/usr/bin/tesseract` in the API runtime (see `docs/deployment-contract.md` `OCR binary placement`) |
| PGlite `SIGKILL`  — `not ok signal:SIGKILL` + `RETRY (OOM):` + `5 SIGKILLed test(s) could not be mapped to a file` | `PGlite` batch only | **Harness OOM**, not code — `tools/run-tests.mjs` already serializes `db/tests/**` with `--test-concurrency=1`, and `testRunnerVerdict.mjs` retries killed files **once** alone; assertion failures are never retried | Wasm PostgreSQL (`pglite@0.5.8`) boots multiple isolates; a tiny container (or a background `node` still listening on ports 33931…46601) exceeds RAM and the OS SIGKILLs the file | Isolated retry (the harness does this automatically) or a larger runner; locally `node --test --test-concurrency=1 db/tests/telegramJournal.test.ts` alone → `73/73 pass`. Do **not** interpret a SIGKILL without isolated reproduction as a code regression |

No other failure is expected green. If a run shows more than `1` general fail or a PGlite assertion fail (not `SIGKILL`), it is a real regression.

---

## 5. Remaining gaps — repository vs deployment vs owner

*Do not falsely equate capability-matrix counts and gap-register counts:* they measure different things.

- Capability matrix (`docs/state/capability-matrix.json`) vocab: `VERIFIED`/`IMPLEMENTED`/`PARTIAL`/`MISSING`/`UI_ONLY`/`BACKEND_ONLY`/`LEGACY_ONLY`/`INTENTIONALLY_NOT_MIGRATED`. **Current:** `13 VERIFIED / 8 IMPLEMENTED / 14 PARTIAL / 8 MISSING / 5 BACKEND_ONLY / 1 UI_ONLY / 2 LEGACY_ONLY / 2 INTENTIONALLY_NOT_MIGRATED` (TRD-03 at 0ae8832 is `PARTIAL` with API ownership + image have/missing — see TRD-03 row). The delta since the audit is real code, not a rename.
- Gap register (`docs/state/migration-gap-register.json` / `.md` twin): `OPEN`/`PARTIAL`/`CLOSED` across §A gates + §B gaps + §E docs. **Current:** `13 OPEN / 30 PARTIAL / 13 CLOSED` (56 total) — counts stay as `STATIC` until a gap truly closes with evidence against the current verified tree. `MG-G12` stays `OPEN` (MG-DOC-3 roadmap reconciliation), `MG-TG-3`/`MG-AI-OCR` stay `PARTIAL` (code `RECORDED_RUNTIME`, live `NOT_VERIFIED`).

**Highest-priority open items (full list in `MIGRATION_GAP_REGISTER.md`):** `MG-METAAPI-CADENCE` (hourly vs per-minute), `MG-WORKER-DEPLOY` (railway.json has no worker service), `MG-SEC-HSTS` (edge confirmation remaining), `MG-SEC-CSP` pinning remainder, `MG-SEC-EDGE-AUTHZ` (R8 decision), `MG-API-MISSING-ROUTES` (≈19 absent), `MG-SCHEMA-MAPPING`/`A12`, `MG-FRONTEND-SURFACES`/`MG-I18N-COVERAGE`/`MG-EMAIL-TYPES`, `MG-RBAC-VOCAB` 20/24→24, `MG-OPS-TOOLING`.

**Owner decisions still open (11):** `R1` password policy at login, `R8` public/protected `markets`/`news`/`support`, `R9` strategy semantics, `OD-1` canonical staging origin, `ADR-004` naive-datetime sampling, `RPO/RTO`, subscription vocabulary, worker service definition, `MG-AI-ANONYMIZE` image dep (or external vision stays off), `OD-M-PA-1/2/3` assembly ratification (described as adopted per recommendations in AC-28 but still formally pending), `CSP` pinning manifest model, plus second-process secret allowlist `D-2` (`TELEGRAM_BOT_TOKEN` in worker).

**Deployment-gated (code `RECORDED_RUNTIME`, execution `NOT_VERIFIED`):** Telegram live webhook + Gemini/Resend live calls + MetaAPI assembly live tick + Tesseract binary presence (`/usr/bin/tesseract`) — all return `503` honestly until host provides binary/creds; offsite backup upload + production restore drill + edge HSTS + hosted-PG `ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner` superuser.

**Traceability for this successor:** every `1468` test is named in `tools/run-tests.mjs` output (130 general + 10 PGlite files, 140 test files total); the `1` honest fail + `5` transient SIGKILL discipline are the documented `1468 bug→tests` for this commit. No test was weakened or skipped to close a gap (the real-tesseract test is **unconditional** by design).

---

## 6. Railway staging bypass — unverified in this session, exact owner remediation

**Reported:** `deploy-staging-gated.yml:20-21` documents `Railway GitHub trigger staging->staging (checkSuites=false)` still deploys on push, bypassing the gated workflow entirely — see `ADR-012 A.6`.

**Verified in this session:** `railway.json` exists (`builder:RAILPACK`, `startCommand: npx tsx db/migrate.ts && npx tsx apps/api/src/server-main.ts`, `healthcheckPath:/health`) and the workflow text matches the report. **Direct Railway API inspection was not performed** (no `RAILWAY_TOKEN` in this sandbox, `railway` CLI not authenticated), so the `checkSuites=false` claim is labeled **reported, not re-proven current** rather than asserted as current.

**Exact owner action required to prevent ungated staging deployments** (per `deploy-staging-gated.yml` `KNOWN RESIDUAL RISK` and `docs/evidence/PHASE-D-D5-ROLES.md`):

1. Open Railway → Project `56d1762e-79d3-4518-b788-5eda1d93dd22` → Service `velora-modern` → Settings → **GitHub Trigger** for `staging` → either **remove** the `staging→staging` trigger entirely (so only `deploy-staging-gated.yml` can deploy via `railway up`/`ssh`), **or** repoint it to `checkSuites:true` and require `verify` (and, when ready, `backup-gate`) as required checks. See `docs/deployment-contract.md` — never expose `postgres.railway.internal` publicly to work around it; the backup producer already runs in-network over `railway ssh`.
2. Verify with an empty commit to `staging` that no deployment starts without a green `verify` (and later `backup-gate PASS`).
3. Record the change in `docs/deployment-contract.md` and `railway.json` history (the workflow cannot revoke the trigger itself).

Until then, the gated workflow is the **sanctioned** path but not yet the **exclusive** one.

---

## 7. How to tell the two successorships apart

- `RESIDUE_SWEEP_2026-10-10.md` is the five-disposition record for the `cc09d54` sweep (70 files, migrations 0034+0035, Telegram transcript privacy + at-most-once, screenshot 24MiB cap, AI consent/ledger, Tesseract, timezone UX).
- **This** `QUALITY_GATE_SUCCESSOR_2026-10-11.md` is the **gate** record for the `0ae8832` line (TRD-03 PARTIAL logged, healthcheck R-01, OCR cross-surface, `verify` required on `main`, CI tesseract, Railway bypass documented). The next successor (e.g., after the worker is deployed or the offsite drill passes) will create a new `QUALITY_GATE_SUCCESSOR_YYYY-MM-DD.md` rather than editing audit or sweep records.

---

## 8. References (source of truth)

- Legacy reference: `veloratrade/veloratrade@edede313280f2f0e298f5ccbf5bbdd4d676c80bd` — actual `main` at audit, never modified.
- Modern verified before this doc: `cc09d54fee11baaf3b5b7fd72cac026fadcd1691`; after healthcheck+OCR: `f304317874088f7b87f582da57287426a1192ae7` (app) + `0ae8832abbdb1646fd48fe0fd5ef41a9cd19508a` (gov sync) — `current-state.json` `verified_at:2026-10-11`.
- Key files touched this line: `.github/workflows/ci.yml` (+ tesseract install), `.github/workflows/healthcheck-suite.yml` (8 stages), `apps/api/src/ai/aiRoutes.test.ts` (24MiB cap proof), `apps/web/src/i18n/contentSurfaces.test.ts` (toLatin), `docs/state/capability-matrix.json` (TRD-03 PARTIAL 2026-10-11), `docs/deployment-contract.md` (OCR placement 2026-10-11), this doc, `tools/registryConsistency.test.ts` (new), `apps/api/src/ai/aiRoutes.test.ts` 413 gap fill (next commit).
- No `infra/Dockerfile.api` change, no Railway/Cloudflare/secrets/DB/external-service changes, no Telegram enable.
