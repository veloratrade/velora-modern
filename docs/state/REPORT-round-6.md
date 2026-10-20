# Round 6 — GitHub main sync, Cloudflare staging deploy, database at head, VPS portability: consolidated report

Scope per the owner brief: verify the working tree, land everything relevant on `veloratrade/velora-modern`
`main`, redeploy the Cloudflare **staging** environment with real post-deploy tests, prepare and prove the
staging database, make the deploy path reproducible and host-portable, and report with exact evidence.
Staging only — **no production exists and none was created.** Every claim below carries a status:
`PASS` (executed green) · `FAIL` · `BLOCKED` (needs credential/owner action) · `NOT VERIFIED` (insufficient
evidence) · `SKIPPED` (with reason). Mock evidence is never presented as live-provider evidence.

---

## 1 — GitHub

| Item | Evidence |
|---|---|
| Starting state | HEAD `354edaa`, branch `main`, tree 45 M / 48 ?? (round 5's exact closure; nothing lost) |
| Remote configuration | `origin` was MISSING from the local clone (refs present, config absent) → re-added `https://github.com/veloratrade/velora-modern.git`; remote `main` confirmed == `354edaa` via API before any push |
| Commits | 13 grouped by dependency & content (below), plus the two closure commits at the end of this file |
| Push | `354edaa..47f4b4c  main -> main` — fast-forward; **no force, no history rewrite, no stash/reset/clean at any point**; verified from GitHub API: `remote main now: 47f4b4ccf` |
| CI on the pushed SHA | run **39392383493** (`ci` workflow) → **completed / success** @ `47f4b4ccf` — PASS |
| Commit grouping | `18f129a` fix(ratelimits) → `7c64b5a` feat(db) 0036–0041+tests → `bf64c50` feat(ai) agent/planner/catalog/budgets/admin → `6a93ef1` feat(auth) audit vocabulary → `ef35073` feat(telegram) agent+templates+standby+banner → `3fdc212` fix(journal) read-authority+stats → `18b7ca7` feat(web) admin tools tab (round-5 contract) → `6e01b94` feat(worker-cf) → `0f21ae1` feat(web-edge-cf) → `2ab6ca0` chore(deps lock) → `06779d6` chore(tools rig/benches) → `f7f6529` docs(telegram) → `47f4b4c` state(rounds 3–5 evidence) |
| Pre-stage review | every commit's `--stat` inspected; final sweep: `git status` clean before push; whole-tree diff re-checked (`git diff 354edaa..HEAD`, 27,648 added lines) |
| Secrets in git | repo `npm run secret-scan` **PASS** (exit 0) + independent pattern sweep (private keys, sk-/ghp/cfat/napi/xox/AIza/AKIA, JWT triples, password-URLs, and the three credentials pasted into chat) → **0 hits**; the 3 sub-hits were the public staging URL's subdomain text. `.gitignore` covers `.env*`/`.dev.vars`; the deploy-generated `wrangler.deploy*.jsonc` is gitignored per-package and stayed out |
| Working tree now | 0 M / 0 ?? (after the closure commits) — every pre-existing user/agent modification is now committed, none deleted or overwritten |

## 2 — Cloudflare staging (deployed + verified live)

| Item | Result |
|---|---|
| Staging ownership check | account `9ef5ad52…` lists exactly: `tgpl` (not ours — untouched, guard against overwrite intact), `velora-modern-staging` (created 2026-10-06, 3 versions, read via API), `velora-telegram-bot` (this project's, v38 running) — the URL in the brief **is** this project's staging edge — PASS |
| Bot redeploy | `velora-telegram-bot` deployed from the committed tree with deploy-kit discipline (tsc 0 → 60/60 tests → `--dry-run` → deploy): **version `9ba84512-91f4-46dd-912d-a9e410dca5a5`**, triggers include the `*/4` cron and `LATENCY_PROBE=1`, over the same `HYPERDRIVE` binding — PASS |
| Post-deploy live checks | `/health` 200 `storage:postgres, access:armed` · `/ready` 200 `database:ok, telegram:enabled` · webhook POST without secret **401** · with wrong secret **401** · diagnostics without bearer **401** — PASS |
| Edge (`velora-modern-staging`) | live behavior verified (landing 200 + `x-robots-tag: noindex, nofollow`; `/_next/static` 200 `immutable` from assets; `/en/dashboard` 302 guard; `/robots.txt` OK). **Not redeployed**: its uploaded source (v#3) was never in the repo, and replacing a working manual upload with a behavior reconstruction is the owner's decision — `apps/web-edge-cf/deploy.sh` gates on `CONFIRM_EDGE_DEPLOY=yes` and prints rollback from API-read state. Reconstruction: tsc 0, 7/7 tests — PASS (edge verified) / NOT VERIFIED (byte-fidelity to #3, stated in README) |
| App behind the edge | Railway `velora-modern-staging.up.railway.app` answers `Application not found` on every route **directly, bypassing the edge** — the staging app service is DOWN. Pre-existing (observed before any push), Railway ops are outside this round's authority (no RAILWAY_TOKEN; the sanctioned path is the gated `deploy-staging-gated.yml` + the owner-closed trigger bypass) — BLOCKED (Railway restart), NOT VERIFIED (app-level flows on staging) |
| Secrets/binding hygiene | no secret values were ever printed, stored in git, or written to a repo file; Hyperdrive password change was passed via CLI from a 0600 /tmp file (deleted below); Worker secrets (Telegram token, webhook secret, admin token) were not read, changed, or needed — PASS |
| Untouched by design | DNS, zones, Cloudflare Access, WAF, billing, `tgpl`, any non-staging resource — nothing outside the two staging Workers + their Hyperdrive config was mutated — PASS |

## 3 — Database (staging)

| Item | Result |
|---|---|
| Architecture, from code | product = PostgreSQL via `pg`/`postgres.js` behind ports; Workers reach it ONLY via Hyperdrive (`velora-pg-nonprod` → Neon `velora_journal`, ap-southeast-2, **caching disabled**); D1 in `worker-cf` is an explicit private TEST surface with PostgreSQL precedence in `storageMode`; PGlite is dev/test in the runner — **no D1 migration, no engine swap, nothing invented** — verified by reading `db/migrate.ts`, `apps/worker-cf/src/index.ts`, `runtime.ts` |
| State found | `schema_migrations` head **0036** (applied 2026-10-18); 0037–0041 (created in rounds 3–4, already tested on PGlite) were pending on staging |
| Backup before change | Neon branch snapshot `pre-round6-snapshot-20261020` (`br-dry-waterfall-a7o7t5gn`) created from `main` — restorable, retained; deletion is the owner's call |
| Migration run | official tool only: `MIGRATION_DATABASE_URL=… npm run migrate:dev` → `applied: 0037…0041`, `migration head: 0041…`; ledger read back independently (41 entries, timestamps today) — PASS |
| Credential path (documented because it's the real procedure) | verification role via Neon API lacked schema DDL rights (`permission denied for schema public` — correct PG15+ behavior, noted not fought); owner `reset_password` API rotated `neondb_owner` (DDL needs owner), migration ran as owner, **`wrangler hyperdrive update … --password --caching-disabled` re-synced the config in the same session** (Hyperdrive stores the old password; skipping this strands the Worker — the failure mode is documented), `/ready` confirmed `database:ok` after — PASS |
| Read/write proof | scratch table create/insert/select/delete over TLS as a non-owner role: OK; new feature tables verified (`telegram_post_templates` 0 rows readable, `telegram_outbox_posts` publish constraints present incl. `…_publish_requires_approval`, `telegram_channels_standby_not_revoked`) — PASS |
| Pooling/contract | transaction-mode semantics respected (overlapping single-statement autocommit reads — unchanged from earlier rounds' contract); Hyperdrive origin limit 20 (free) — not a staging bottleneck |

## 4 — Code audit & fixes this round (beyond re-verifying rounds 1–5)

1. **Rate-limit snapshot aliasing** (real defect, user-impacting): `memory`/`pg` stores returned the live
   bucket object; same-tick mutation made burst decisions read the FINAL count — a 20-request burst against
   a limit of 5 refused all 20, the first 5 included. Fixed in both stores; `rateLimiter.test.ts` pins the
   boundary. (The `pg` store had the same aliasing via its snapshot-less read path.)
2. **Journal read-authority inversion**: `COALESCE(strategy_tag, strategy)` treated the 0022 legacy mirror
   as authority in `analyticsStore`, `tenancyRoutes`, `portfolioRoutes` — a user's edited strategy could be
   shadowed by an imported label. Inverted to `COALESCE(strategy, strategy_tag)`; comments carry the
   2026-10-18 owner decision; `journalingReadAuthority.test.ts` pins the reads.
3. **Reproducibility gap of the staging edge** — closed as described (`apps/web-edge-cf/`).
4. **Staging DB drift** (0036 vs head) — closed as described.
   Nothing else in the audited lists (agent path, planner, multi-step execution, search/capture, timeout/
   retry, API+permissions, admin page, secret handling, Telegram queue, OCR, build/runtime) revealed further
   real defects; those areas were re-verified green by the full battery rather than merely re-asserted.

## 5 — Tests, builds, gates (executed against the committed lock `2ab6ca0`)

| Gate | Result |
|---|---|
| `npm ci` (fresh) | 0 |
| `npm test` full | **exit 0** — general 1733 (1732 pass / **0 fail** / 1 named skip `NO_TESSERACT_BINARY`) + PGlite 85/85 |
| `tsc -b --force` (contracts, domain, api, worker, web) | 0 (plain `-b` hits TS6305 after any `dist` wipe — stale tsbuildinfo; `--force` documented) |
| `npm run build -w apps/web` (production) | 0 |
| worker-cf: `tsc --noEmit` · `node --test` | 0 · 60/60 |
| web-edge-cf: `tsc --noEmit` · tests | 0 · 7/7 |
| `npm run secret-scan` (repo tool) | 0 |
| GitHub CI on pushed main | run 39392383493 **success** |
| Migrations battery (PGlite) + real-DB ledger | green / head 0041 |

## 6 — Real-environment (staging) checks per brief §8

health+landing: PASS (edge) / NOT VERIFIED (app — Railway down) · login+auth flows: NOT VERIFIED on staging
(app down); the same flows are suite-green locally incl. cookie semantics · main APIs: proxy contract
through the edge verified live (faithful 404/302/`request_id` envelopes prove pass-through), route content
NOT VERIFIED on staging · DB read/write + migration compatibility: PASS (live Neon) · permissions
user/admin/super: PASS (round-5 browser matrix, same committed code; CI re-passed the suite) · admin Agent
Tools page: PASS in-browser (round 5) against this exact admin surface code · real Web
Search/BrowserCapture states: `VERIFIED_WITH_MOCK_API` only — no provider credentials exist here; `Not
configured` states verified truthful · timeout/retry/rate-limit: suite-level PASS (incl. this round's
burst fix), live-rate-limit on staging NOT VERIFIED (app down) · secret non-disclosure in API/UI/logs:
PASS (sentinel scan round 5 + this round's diff scan; nothing new leaked on staging checks — 401/404
envelopes carry no upstream detail) · Telegram/Queue live delivery: BLOCKED (Bot API token lives only as a
Worker secret by design; webhook registration is owner-gated `CONFIRM_SET_WEBHOOK` — unchanged posture) ·
OCR: BLOCKED_BY_ENVIRONMENT (no tesseract binary in sandbox; named skip; VPS doc covers installing it) ·
screenshot capture on Worker runtime: PASS — the admin panel reports `unsupported` truthfully (the runtime
limitation itself, verified) · Persian/RTL: PASS locally (round-5 browser fa screenshots in the committed
evidence); on staging web NOT VERIFIED (app down) · typecheck/tests/prod-build re-run this round: PASS (table 5).

## 7 — Architecture: Cloudflare is a host, not a dependency

Documented in `docs/architecture/deployment-portability.md` against real files: core (`packages/*`,
`apps/api/src`, `apps/web`, `db/`) imports **zero** Cloudflare modules (`grep 'from "@cloudflare\|from
"wrangler' apps/api/src → 0`); platform surfaces are the two edge packages (`apps/worker-cf`,
`apps/web-edge-cf`) + gitignored generated configs; adapter seams (Hyperdrive↔DSN, crons↔timers,
webhook↔polling, Browserless URL, tesseract/resvg native-only capability honestly reported) each have their
VPS equivalent named. D1 remains test-only, never a product store. What must never change during a move is
stated as a rule; nothing in this round added a new parallel implementation.

## 8 — Rollback

- **Bot/edge Workers**: Cloudflare version history — `POST …/versions/{id}/rollback` to
  `40e22f89…` (v38, previous) for the bot; edge untouched so nothing to roll; both `deploy.sh`s print the
  exact command with API-read ids. Secrets survive rollbacks.
- **Hyperdrive**: config is mutable; previous state = same config with old password (now rotated once more
  by the owner if desired).
- **Database**: `schema_migrations` is append-only — rollback = reset/restore the Neon branch to
  `pre-round6-snapshot-20261020` (branch exists, retention is the owner's call); no destructive path taken.
- **Git**: all 13 commits are on `main`; any revert is forward-only (`git revert`), per the standing ban on
  history rewrites.
- **Railway**: untouched (no token, gated workflow remains the only sanctioned path).

## 9 — Owner actions this round deliberately did NOT take

1. Restart/inspect Railway staging (no credential; its trigger bypass is owner remediation per workflow header).
2. Swap the live edge to the reconstruction (fidelity caveat; `CONFIRM_EDGE_DEPLOY=yes` awaits an explicit word).
3. Register the Telegram webhook (`webhook.sh` requires `CONFIRM_SET_WEBHOOK=yes`).
4. Delete the snapshot branch, rotate the staging DB password again (recommended after this session), and
   **rotate the three chat-pasted credentials (GitHub PAT, Cloudflare token, Neon key) — they sat in the
   transcript; the Cloudflare token additionally worked with trailing-dot trimmed. Treat all three as
   exposed-in-conversation.**
5. Create anything production-shaped, paid, or permanent: none was needed; nothing was created beyond a
   free-plan Neon snapshot branch, a temporary DB role (dropped), and Worker version history entries.

`docs/state/evidence/round6-staging/verification.json` carries the machine-readable version of the tables
above (no secrets in it, by construction).
