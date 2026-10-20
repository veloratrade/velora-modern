# `@velora/api-cf` — the API kernel on Cloudflare Workers

The Velora API (`apps/api`) served from a Worker instead of a Node process. Staging only.

## What this is

A **host**, not a second API. `apps/api/src/kernel/server.ts` exports
`createRequestListener(config)`, which is the single place routing, authentication, RBAC, the JSON
envelope and the security headers live. The Node entry point (`server-main.ts`) calls it with a config
built from its environment; `src/runtime.ts` here calls the *same* function with a config built from
Worker bindings. `src/nodeHttpBridge.ts` is the only new code in the request path: it turns a fetch
`Request` into the six members the kernel actually reads, and the kernel's `writeHead`/`end` into a
`Response`.

```
browser → panel Worker → POST /api/v1/auth/login
                       → (proxy route) → this Worker → createRequestListener → AuthService → Hyperdrive → Neon
```

## Why it exists

The staging panel's login failed with `404 Application not found`. That string is not the API's: the
API's own 404 is `{"status":"error","error":{"code":"NOT_FOUND","requestId":"…"}}`. It came from a
rewrite pointing `/api/*` at an origin that no longer existed (a Railway host), so no API was ever
reached. The fix is not a proxy tweak — it is giving the API a Cloudflare origin of its own, which is
this Worker.

Railway is not used anywhere in this path.

## Bindings and configuration

| Name | Kind | Why |
| --- | --- | --- |
| `HYPERDRIVE` | Hyperdrive (`velora-pg-nonprod`) | Workers have no TCP stack; Hyperdrive fronts Neon staging. The id is a resource identifier, not a secret, but it is per-deployment, so `wrangler.jsonc` carries `REPLACE_WITH_HYPERDRIVE_ID` and the deploy shell substitutes it (same policy as `apps/worker-cf`). |
| `APP_ENV` / `APP_ORIGIN` / `CANONICAL_STAGING_ORIGINS` | vars | The same ADR-013 boot gate the Node server runs (`assertBootable`) refuses a mismatch. |
| `API_ALLOWED_ORIGINS` | var | The panel origin, and only that. |
| `PERSISTENCE` | var | `postgres`. |
| `DATABASE_URL` | **derived** | Taken from `HYPERDRIVE.connectionString` at request time (`runtime.ts`), so the connection string lives in one place (Hyperdrive) instead of being duplicated as a drifting secret. |
| `JWT_SECRET` | **secret** | `wrangler secret put JWT_SECRET`. Never a var, never in git. |
| `RESEND_API_KEY`, `SUPPORT_NOTIFY_EMAIL` | optional | Absent ⇒ mail is logged, never sent. A reset link is a bearer credential; nothing here invents delivery. |

## Capabilities wired (and not wired)

Wired: `auth`, `authEvents`, `ownership`, `adminUsers`, `adminConsole`, `achievements`, rate limiting,
the database health check.

Everything else (`accounts`, `trades`, `credentials`, `provisioning`, `ai`, `support`, `telegram`, …) is
**absent**, and the kernel answers its documented `503 SERVICE_UNAVAILABLE` for those routes. That is
fail-closed on purpose: a route that returned `200` with empty data would make the panel render a
checked-and-clean lie. `src/runtime.test.ts` pins the absent list so a future editor notices.

## Verified (2026-10-20)

| Check | Result |
| --- | --- |
| `tsc -b apps/api-cf` | 0 errors (also in the root `npm run typecheck`) |
| `tsx --test src/*.test.ts` | 19/19 — 13 bridge, 6 composition root |
| `wrangler deploy --dry-run` | **bundles: 800 KiB / 180 KiB gzip**, Hyperdrive binding resolved |
| `wrangler dev --local` (workerd) | `/health` → `200 {"status":"success"}`; `/api/v1/nope` → API's own `404 NOT_FOUND` envelope; boot refusal → `503 BOOT_BLOCKED` naming the finding codes |
| Deployed to staging | **not yet** — no credentials in this session |

### A real bug this caught

Running the Worker locally in workerd (not just bundling it) found that
`NotificationService`'s constructor resolved the email-icon directory eagerly with
`fileURLToPath(import.meta.url)`. A bundled Worker has no `import.meta.url`, so **every** request —
`/health`, login, the session probe — answered `500` with a `TypeError`. The notification service is
built as part of building the app, so a mail-asset detail took down the whole surface.

Fixed in `apps/api/src/notifications/notificationService.ts`: the directory is resolved lazily, where a
failure is already recorded as `icon-missing` and only fails *that* email. The documented contract is
unchanged (a send without its icons still fails — brand identity is part of the capability); the blast
radius is one email instead of the API.

## Known limits of this host

- **Email icons.** A Worker has no filesystem, so a mail sent *from this host* fails as `icon-missing`
  and is logged, exactly as any other missing-asset send. Staging sends nothing (`LogMailProvider`)
  unless `RESEND_API_KEY` is set. Serving the icons over HTTPS from the app origin is the follow-up if
  Worker-side mail is ever wanted.
- **Client IP behind the panel hop.** The panel forwards the browser's `cf-connecting-ip` as
  `x-forwarded-for`; the kernel's bridge prefers the edge's own `cf-connecting-ip`. Whether Cloudflare
  preserves the original client address on a Worker→Worker subrequest has **not been verified here**, so
  per-client rate-limit buckets on this path are `NOT VERIFIED`. A service binding (see below) is the
  clean fix.
- **A service binding to the API** (`services: [{binding: "API", service: "velora-api-staging"}]`)
  would skip the public hop. It is not configured yet on purpose: a service binding refuses to deploy
  while the named Worker does not exist. `resolveApiOrigin()` in `apps/web/src/lib/apiOrigin.ts` is the
  single seam where it would be preferred when present.

## Commands

```bash
# typecheck + tests
npm run typecheck
npx tsx --test apps/api-cf/src/*.test.ts

# bundle (no credentials needed)
cd apps/api-cf && npx wrangler deploy --dry-run --outdir dist -c wrangler.deploy.jsonc

# local workerd (needs a reachable Postgres for anything that queries)
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://…" \
  npx wrangler dev -c wrangler.deploy.jsonc --local --port 8799 --var JWT_SECRET:<≥32 chars>

# deploy (staging)
npx wrangler secret put JWT_SECRET -c wrangler.deploy.jsonc
npx wrangler deploy -c wrangler.deploy.jsonc
```

`wrangler.deploy*.jsonc` is git-ignored: it is the deploy-time config with the real Hyperdrive id.
