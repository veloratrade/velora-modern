# Deployment portability — Core vs Infrastructure, and what a move actually costs

**The rule this repo holds to:** Cloudflare is a *host*, not a dependency. The product logic lives in
`apps/api`, `apps/web`, `packages/*`; anything platform-shaped sits in named packages at the edge
(`apps/worker-cf`, `apps/web-edge-cf`) or in operator kits outside git. This file maps the seam exactly
— and states honestly where the seam is not yet complete.

## Core (moves unchanged)

- `apps/api/src/` — the whole application kernel: routes (Hono), auth, journals, AI tool layer,
  Telegram client, rate limiting, audit. It imports **no** Cloudflare module anywhere
  (`grep -rn 'from "@cloudflare\|from "wrangler' apps/api/src → 0 hits`; the only textual mentions are
  four doc-comments that explain the boundary, e.g. `bannerRaster.ts:5`). Platform capabilities arrive
  only via composition: `createApp({...})` takes `fetchImpl`, store adapters and config resolution from
  env (`MIGRATION_DATABASE_URL`, `DATABASE_URL`, `API_ALLOWED_ORIGINS`, `TELEGRAM_*`, `TAVILY_API_KEY`,
  `BROWSERLESS_URL/TOKEN`).
- `packages/domain`, `packages/contracts` — pure logic + zod API contracts; zero platform types.
- `apps/web` — Next.js standalone; the only host coupling is `next.config`'s `/api/:path*` rewrite to
  `VELORA_API_ORIGIN` — one env var, works pointing at a container, a VM, or the Workers edge.
- `db/` — SQL migrations + the runner (`MIGRATION_DATABASE_URL` ⇒ real PG; PGlite only when explicitly
  chosen). No platform SQL (no D1 dialect, no RLS-less multi-tenancy shortcuts) — **D1 is NOT a product
  store**; it is a private test surface inside `apps/worker-cf` only, and `storageMode` gives PostgreSQL
  precedence whenever `HYPERDRIVE` exists.

## Infrastructure adapters (replace each independently)

| Capability | Today (Cloudflare) | On a VPS | Where the seam lives |
|---|---|---|---|
| Postgres access | Hyperdrive binding (transaction pooling, caching **disabled**) | direct PG or pgbouncer; same `postgres`/`pg` drivers | `apps/worker-cf/src/pgHyperdrive.ts` (Workers: `env.HYPERDRIVE.connectionString`) vs `apps/api/src/**/pg*Store.ts` (Node: `DATABASE_URL`) |
| Background jobs / queue | Cloudflare cron triggers (`*/4` upkeep) driving the SAME `pg-boss` schema the Node host uses | pg-boss native on Node; crons → systemd timers or keep Workers crons pointed at the VPS | `apps/worker/src/index.ts` (pg-boss runner), `apps/api` processor factory |
| Object storage | none used (backups are local files; `storage_status=NONE` is an honest state, see `infra/backup/DR-RUNBOOK.md`) | unchanged; add S3 only if the product later needs it | `infra/backup/` |
| Browser automation / raster | Worker runtime reports `unsupported` for `banner_raster` (native resvg cannot load in workerd); Browserless via `BROWSERLESS_URL` | resvg/Vazirmatn/tesseract all available natively — this is the ONE place a VPS is strictly richer; the admin UI already renders that state truthfully | `apps/api/src/ai/aiToolAdmin.ts` capabilities() + `apps/worker-cf` runtime probe |
| HTTP ingress for the web app | edge Worker (assets + proxy) | any reverse proxy (Caddy/nginx; compose files in `infra/`) | `apps/web-edge-cf/src/handler.ts` (100-line pure function, fully tested without Cloudflare) |
| Secrets | `wrangler secret put` store; env at boot for the Node host | process env / systemd credentials / vault — same names, same fail-closed codes (`TG-001…TG-007`, `NO_DATABASE_BINDING`, gate states) | `apps/api` config resolvers; bot's private-access gate |

## Known direct couplings (deliberate, not drift)

1. `apps/worker-cf/**` imports `apps/api/src/**` modules directly — one-directional (api never imports
   worker-cf), so the Worker is a *host* of the core, never a fork of it. This is what makes the
   "port the bot to Workers" history not a rewrite: `git diff apps/api..worker-cf` shows glue only.
2. wrangler config files (`wrangler*.jsonc`) are platform-shaped by definition; they are quarantined to
   their edge packages, and the *generated* ones (`wrangler.deploy*.jsonc`, `.dev.vars`, `.wrangler/`)
   are gitignored per-package, so a deploy machine holds deployment state, the repo holds none.
3. `compatibility_date` pinning + the wrangler 4.86.0 workerd ceiling (2026-05-03) are deploy-tool
   constraints documented in `apps/worker-cf/README.md` — irrelevant to a VPS, kept from leaking into
   core because no core file reads them.
4. Telegram `TELEGRAM_UPDATE_MODE=webhook` is *required* on Workers (no long-lived loop). A VPS may run
   `polling` mode — the resolver already supports it (`getUpdates` path exists in `apps/api/src/telegram/telegramApi.ts`);
   the ban is platform-driven, not product-driven.

## What a move to VPS still costs (the honest list)

- Provision PG 16/17 + run the same `db/migrate.ts` chain (schema is portable; the Neon branch history is
  not — see `docs/deployment/vps-migration.md` §data).
- Recreate the four Worker secrets as process env; flip `TELEGRAM_UPDATE_MODE` at will.
- Replace the `velora-modern-staging` edge with a reverse proxy or run `apps/web` directly (the edge only
  adds asset offload + `x-robots-tag`; that header logic is ~10 lines of nginx/Caddyfile).
- Nothing in `packages/*`, `apps/api/src`, or `db/migrations` changes. No feature rewrites. No second
  implementation — the property this document exists to keep true.
