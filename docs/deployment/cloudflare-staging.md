# Cloudflare staging — what runs where, and how to change it safely

**Scope.** Everything here is the **staging** deployment on the `yadgar-s-ict` Cloudflare account
(id `9ef5ad…`, Workers **Free** plan). There is no production environment and none should be inferred.
Three resources exist; touching any of them requires the credential handover rules of
`docs/architecture/deployment-portability.md` §seams.

| Resource | What it is | Source of truth |
|---|---|---|
| `velora-modern-staging` (Workers) | Edge shell for the web app: static assets served from the assets binding, everything else proxied to `VELORA_API_ORIGIN` (currently the Railway staging service) | `apps/web-edge-cf/` — reconstructed 2026-10-20; the live version #3 predates the package (see its README "Fidelity caveat"); swapping is gated on `CONFIRM_EDGE_DEPLOY=yes` |
| `velora-telegram-bot` (Workers) | The Telegram bot host (webhook + crons), reusing `apps/api` modules over Hyperdrive | `apps/worker-cf/` + `/home/user/velora-telegram-bot-deploy/deploy-kit/` (repo-external operator kit, by design) |
| `velora-pg-nonprod` (Hyperdrive) | Connection pooler in front of Neon `velora_journal` (ap-southeast-2); **query caching disabled by design** | Cloudflare-side config; provisioning procedure documented in deploy-kit `provision-neon-hyperdrive.sh` |

## Prerequisites

- Node 20 (`engines.node: >=20 <23`), `npm ci` at the repo root.
- A Cloudflare API token, Account-scoped with `Workers Scripts: Edit` + `Hyperdrive: Edit`. It is
  handed over as a **0600 file outside the repo** (`TOKEN_FILE=/tmp/…`) or a single-command
  environment value — never committed, never printed. wrangler additionally needs
  `CLOUDFLARE_ACCOUNT_ID` set (an account token may not call `/memberships`).
- For the bot only: the three `wrangler secret put` values (`TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET`, `WORKER_ADMIN_TOKEN`) plus `TELEGRAM_TEST_USER_ID` as a secret —
  they live in the Worker's secret store, survive deployments, and are deliberately absent from every
  config file in the repository.

## Build & deploy

**Bot (redeploy of an existing Worker).** `deploy-kit/deploy.sh` refuses to overwrite an existing name —
that is its first-deploy guard, verified live. The sanctioned redeploy is:

```bash
cd apps/worker-cf
../../node_modules/.bin/tsc -p tsconfig.json --noEmit                      # gate 1
../../node_modules/.bin/tsx --test src/*.test.ts                           # gate 2 (60 tests as of 2026-10-20)
npx wrangler@4.86.0 deploy --dry-run --outdir dist -c wrangler.deploy-shell.jsonc  # gate 3 (bundle builds)
npx wrangler@4.86.0 deploy -c wrangler.deploy-shell.jsonc                  # upload — reads secrets/Hyperdrive from the account
```

`wrangler.deploy-shell.jsonc` is git-IGNORED by design (it is generated per DB mode); it currently pins
`hyperdrive.id = 769298b9…`. Re-running after a deploy must show a new `Current Version ID`.

**Edge (web staging).** `apps/web-edge-cf/deploy.sh` — typecheck, handler tests, assets staging from the
web build, `--dry-run`, then upload only with `CONFIRM_EDGE_DEPLOY=yes`. It reads the current version id
back from the API before uploading and prints the exact rollback command afterwards.

**Railway (the app behind the edge).** Not deployable from this repository's Cloudflare paths. The ONLY
sanctioned path is `.github/workflows/deploy-staging-gated.yml` (gated chain CI→backup→verify→…→controller),
and the owner must first close the documented `checkSuites=false` trigger bypass. As of 2026-10-20 the
Railway staging service answers `Application not found` for every route (it is down/idle) — the edge
degrades to assets + proxied 404s, which is why post-deploy checks below distinguish edge behavior
(verified) from app behavior (NOT VERIFIED, upstream offline).

## Environment variables & bindings

Edge Worker: `VELORA_API_ORIGIN`, `VELORA_NOINDEX=true`, `VELORA_SITE_ORIGIN` (plain_text, non-secret),
`ASSETS`. Bot Worker: `TELEGRAM_UPDATE_MODE=webhook`, `APP_ENV=production` (= "not a dev harness", per
ADR-019's resolver rule, even on staging), `TELEGRAM_BOT_USERNAME`, `LATENCY_PROBE=1`, `HYPERDRIVE`
binding, `VELORA_TEST_DB` (D1, **test-only storage** — `/ready` reports `storage` so the mode is always
visible), plus the four secrets above. `VELORA_APP_URL` is deliberately UNSET: unset ⇒ `TG-005` +
"linking disabled" rather than mailing a live token to a guessed origin.

## Database & migrations

`db/migrate.ts` is the official runner (forward-only, `schema_migrations` ledger, ADR-010). Against a
real PostgreSQL it takes `MIGRATION_DATABASE_URL` and refuses to fall back to PGlite silently. The
staging sequence actually used on 2026-10-20 (documented so it is repeatable, not cargo-culted):

1. Backup: Neon branch `pre-round6-snapshot-20261020` created from `main` (API `POST /branches`).
2. Credentials: a verification role was created via the Neon API; the owner password was rotated via
   `reset_password` (DDL needs owner rights; the rotated password is NOT in the repo — the operator keeps
   it or rotates again).
3. `MIGRATION_DATABASE_URL=… npm run migrate:dev` → applied `0037–0041`; head now `0041_audit_ai_tool_action.sql`.
4. **Immediately after a rotation:** `wrangler hyperdrive update 769298b9… --password … --caching-disabled`
   and re-check `/ready` — Hyperdrive caches the OLD password in its config; a rotation without this step
   strands the Worker on pool eviction.
5. The temporary role was dropped.

## Health & API checks after a deploy

```bash
curl https://velora-telegram-bot.yadgar-s-ict.workers.dev/health   # 200 storage:"postgres" mode:"private-test"
curl https://velora-telegram-bot.yadgar-s-ict.workers.dev/ready    # 200 checks.database:"ok" access:"armed"
curl -X POST https://velora-telegram-bot.yadgar-s-ict.workers.dev/api/v1/webhooks/telegram -d '{}'   # 401 — secret gate
curl https://velora-telegram-bot.yadgar-s-ict.workers.dev/api/v1/telegram/diagnostics                 # 401 without bearer
curl https://velora-modern-staging.yadgar-s-ict.workers.dev/        # 200, x-robots-tag: noindex, nofollow
curl https://velora-modern-staging.yadgar-s-ict.workers.dev/en/dashboard   # 302 → /en/login (auth guard)
```

All six were run live on 2026-10-20 against bot version `9ba84512-91f4-46dd-912d-a9e410dca5a5` — see
`docs/state/REPORT-round-6.md`. `deploy-kit/journal-acceptance.sh` remains the full four-leg acceptance
script when a DB-mode change is made.

## Rollback

- **Worker/edge:** `POST /accounts/$ACC/workers/scripts/<name>/versions/<id>/rollback` (history is never
  pruned by our tooling; `deploy.sh` in each package reads back ids before uploading and prints the
  exact command). Secrets are Worker-level and survive rollbacks.
- **Hyperdrive:** config is mutable; revert the password flag and re-check `/ready`.
- **Database:** the ledger is append-only. To roll a staging DB back, reset the Neon branch to the
  snapshot branch's HEAD (`POST /projects/…/branches/{snapshot}/set_head` on a scratch branch, or reset
  `main`) — do NOT hand-delete tables; `schema_migrations` rows must match the schema exactly.
- **Git:** staging runs from pushed `main`; revert-forward (`git revert`, never `reset --hard`/force push).
