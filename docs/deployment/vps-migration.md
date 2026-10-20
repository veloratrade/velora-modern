# Moving staging to a Linux VPS — the concrete path

Every command here mirrors files that exist in this repo; nothing is aspirational. Where a step needs a
decision (TLS, domain, backup destination) it says so instead of inventing policy.

## 1. Server prerequisites

- x86_64 or arm64 Linux, 2 GB+ RAM (the web build has been OOM-killed on 2 GB *with* a dev server and a
  browser running at once — build separately from serving).
- Node 20.x (`engines.node: ">=20 <23"`), npm 10+.
- PostgreSQL 16 or 17 (`infra/docker-compose.yml` pins `postgres:16-alpine` for the reference stack).
- Optional, capability-gated: `tesseract-ocr` (OCR — the suite SKIPS with a named reason without it, and
  the admin UI will show `web_search`-style states honestly when tools lack credentials), fonts for the
  Persian banner (the repo vendors Vazirmatn via the `vazirmatn` npm dep; `@resvg/resvg-js` supplies its
  own rasterizer binary — both work natively on Linux, unlike Workers).

## 2. One-shot: the reference stack

`infra/docker-compose.yml` already defines `postgres`, `api` (`infra/Dockerfile.api`), `worker`
(`infra/Dockerfile.worker`) and `web` (`infra/Dockerfile.web`). Fill `infra/env/.env.example` → `.env`
(never committed). This stack is explicitly dev/staging — the file's own governance header says starting
it proves nothing about any other host, and it stays true here.

## 3. Bare-metal / VM without Docker

```bash
git clone https://github.com/veloratrade/velora-modern && cd velora-modern
npm ci
npm run build                                  # packages/contracts + packages/domain
npm run build -w apps/web                      # production Next build; serve with:
npm run start -w apps/web                       # binds 0.0.0.0:3000 (see apps/web/package.json)
node_modules/.bin/tsx apps/api/src/server-main.ts   # API on 8080 (same entry the Dockerfile uses)
npm run start:worker                         # pg-boss runner — REQUIRED for Telegram queue mode
```

systemd units: three services, `After=postgresql.service`, `EnvironmentFile=/etc/velora/staging.env`,
the worker restarted on failure, all three fronted by Caddy/nginx (TLS + the two
`X-Robots-Tag: noindex, nofollow` / `Cache-Control: no-store` staging conventions — for app routes only;
`/_next/static/*` keeps `immutable`).

## 4. Environment variables (the real list, all consumed in `apps/api/src` resolvers)

| Name | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | app PG connection | direct or pgbouncer; `pg` + `postgres` drivers both read it |
| `MIGRATION_DATABASE_URL` | migration runner only | `npm run migrate:dev`; fail-closed, never falls back silently |
| `API_ALLOWED_ORIGINS` | CSRF origin guard | exact-match list — add the VPS origin; a wrong value locks people OUT, it never leaks in |
| `JWT_*` / auth signing vars | session tokens | per `apps/api/src/auth` — rotate on the move (a migration is the natural time) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `WORKER_ADMIN_TOKEN`, `TELEGRAM_TEST_USER_ID` | bot | same names the Worker secrets used; `TELEGRAM_UPDATE_MODE=polling` is allowed here (Workers forced `webhook`) |
| `TAVILY_API_KEY`, `BROWSERLESS_URL`, `BROWSERLESS_TOKEN` | AI tools | optional; the admin UI's `Not configured` states are the contract when absent |
| `VELORA_API_ORIGIN` | web → API rewrite target | point at `http://127.0.0.1:8080` behind one proxy |

## 5. Schema & data transfer

1. `pg_dump -Fc` on the source (procedure + verification chain in `infra/backup/DR-RUNBOOK.md`;
   `infra/backup/backup.sh` / `restore.sh` are the tooling). Record the sha256 before transfer.
2. Restore into fresh PG; **`schema_migrations` travels inside the dump** — the runner will skip applied
   files automatically (it reads the ledger, never the clock). Do not edit the ledger.
3. `npm run test:migrations` (PGlite cross-check) then the real-DB battery per
   deploy-kit `journal-acceptance.sh` pattern.
4. If only schema parity is needed (new staging, no data): run `npm run migrate:dev` from zero against an
   empty DB — migrations are forward-only and self-contained up to the current head.

Queues: `pgboss.*` tables are in the same database; a dump/restore moves pending jobs too (pg-boss v10
keeps state in PG — no broker to migrate). Restart the worker first, resume traffic second.

## 6. OCR / browser / raster on VPS

Install `tesseract (+ traineddata: eng,fas)`; remove the suite's `NO_TESSERACT_BINARY` skip naturally.
Browserless: either run the container or point `BROWSERLESS_URL` at an existing service — `browser_capture`
then flips from `unavailable`/env-missing to live without any code change (that switch is exactly what
`apps/web`'s admin `Agent tools` tab was built to display).

## 7. Final verification & rollback

Health: `GET :8080/health` (api), `GET :3000/` (web), webhook 401 probe — mirror the list in
`docs/deployment/cloudflare-staging.md` §Health with the VPS ports. Data: the acceptance legs of
deploy-kit (`journal-acceptance.sh`) are host-agnostic (they take an API base + a DB URL file).
Rollback of a bad cutover = repoint the proxy at the old staging (both can run in parallel; the ledger is
forward-only so NEVER run migrations twice against the same DB after a fork — re-branch instead).
Cutover with Cloudflare DNS needs the owner's explicit word: DNS is outside this document's authority.

**What must NOT change in a move:** all of `packages/*`, all of `apps/api/src` business logic, the
migrations chain, the permission boundaries, and the credential fail-closed rules. If a VPS migration
asks you to edit those, the migration is wrong, not the architecture.
