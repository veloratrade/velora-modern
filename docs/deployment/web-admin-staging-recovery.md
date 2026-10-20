# Web staging / admin panel — why the panel is unreachable, proven request by request

**Date:** 2026-10-20 · **Scope:** staging only (`yadgar-s-ict` account) · **Verdict:** `BLOCKED` at the API
origin. The web shell renders, the authorization model is intact, and **nothing in the login or RBAC path
is broken** — there is simply no running API for it to talk to.

This document exists because "the admin panel is down" has five very different causes (deployment, session,
role, database, authorization) and guessing between them wastes days. Every claim below is a curl against
the live staging host taken on 2026-10-20; the command is shown so it can be re-run.

---

## 1. What the live staging host actually answers

```bash
B=https://velora-modern-staging.yadgar-s-ict.workers.dev
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$B<path>"
```

| Path | Status | Interpretation |
|---|---|---|
| `/` | 200 HTML | Rendered **per request** (see §2) |
| `/login`, `/en/login`, `/register`, `/blog`, `/news`, `/markets` | 200 HTML | Public pages render |
| `/dashboard`, `/settings`, `/accounts`, `/trades` | 302 → `/login` | The app's own auth gate, working |
| `/admin`, `/admin/x`, `/en/admin` | 302 → `/login` | Same gate — admin is not public, correctly |
| `/journal`, `/portfolio` | 404 HTML (app's own 404) | These routes do not exist in the app; correct |
| `/_next/static/chunks/…` | 200, `cf-cache-status: MISS` | Build output served |
| **`POST /api/v1/auth/login`** | **404 `{"status":"error","code":404,"message":"Application not found","request_id":…}`** | **The blocker** |
| `GET /api/v1/health` | same 404 envelope | Same blocker |

The `/api/*` body is decisive: `Application not found` is the **fronting platform's** envelope for a
service that is not running. The Velora API never emits that sentence (its own 404s are
`{"status":"error","code":"NOT_FOUND",…}` and carry `request_id` from its own kernel). So the request
leaves the staging host and lands on a host with no service behind it.

## 2. The pages are genuinely rendered, not stale files

Two observations rule out "the Worker is serving an old static export":

* `x-nonce: <hex>` is emitted on every response **and appears 19 times inside the HTML**;
* a second request gets a **different nonce**.

A nonce that changes per request and is baked into the markup means a server rendered that document with
that request's CSP. A static file cannot do that. The same is visible in `vary: Cookie, Accept-Language`
and the `content-security-policy` header carrying the same nonce.

## 3. The failure taxonomy, applied

| Candidate cause | Verdict | Evidence |
|---|---|---|
| Route or deployment failure (web) | **NO** | Public pages 200, hashed chunks served, per-request CSP |
| Authentication / session failure | **NOT REACHED** | Login cannot be attempted: `POST /api/v1/auth/login` never reaches an app |
| Missing or incorrect user role | **NOT REACHED** | The 403-vs-200 decision happens in the API, which is not answering |
| Database / environment configuration | **NOT REACHED** | Same |
| Authorization denial | **NO** (and correct) | `/admin` 302s to `/login` for an anonymous caller, exactly as designed |
| **API origin not running** | **YES** | `Application not found` platform envelope on every `/api/*` |

So the panel is unreachable for one reason: **there is no API origin**. `302 → /login` is the system
behaving correctly; the user simply has no way to obtain the session that would open the gate.

## 4. Why the fix is not "deploy the web app again"

The web app in this repository **cannot** be shipped as static files. `npm run build -w apps/web` (exit 0,
2026-10-20) reports:

```
ƒ Proxy (Middleware)
ƒ  (Dynamic)  server-rendered on demand     ← every route
```

and `apps/web/next.config.ts` declares `rewrites()` for `/api/*` plus a webpack `resolve.extensionAlias`
for the domain package. `output: "export"` is incompatible with `rewrites()`; middleware needs a server
runtime. The app therefore requires a Node-compatible or Workers-compatible **server**, and the API it
rewrites to must exist as well.

The repository ships **no** Next.js Cloudflare adapter: `grep -rn "opennext\|OpenNext"` over the tree
(excluding `node_modules`) returns nothing. The existing `apps/web-edge-cf` package is an assets+proxy
shell — and, importantly, its reconstructed handler does **not** reproduce the live 302 gate (§6).

## 5. The smallest compatible paths, ranked

Neither is executable from this sandbox: the brief forbids Railway, forbids inventing an origin, and this
session holds no deployment credential. They are recorded so the decision is a decision, not a guess.

**Option A — API on Cloudflare Workers (keeps "everything on Cloudflare").**
Add `@opennextjs/cloudflare` for the web app and host `apps/api` in a Worker (Hyperdrive is already
proven for the bot: `velora-pg-nonprod`). Costs: a new adapter dependency, an `apps/api` runtime port
(the API is a Node HTTP server today), and the Node-only pieces audited in `deployment-portability.md`
(`@resvg/resvg-js`, Tesseract, `node:child_process`). This is a project, not a config change.

**Option B — one Node host for API + web (fastest, matches the code as written).**
Both processes are already built for Node (`apps/api` server + `next start`). A single small VPS/container
(the documented `docs/deployment/vps-migration.md` path) puts the API behind `/api` on the same origin the
web app expects; `VELORA_API_ORIGIN` then points at it and no code changes at all. The staging edge keeps
serving the shell and proxying.

**What is forbidden either way:** pointing at Railway, inventing a new origin, or weakening the admin gate
to "get in". The panel is 302ing for the right reason.

## 6. A fidelity gap this audit found (and did not paper over)

The **live** staging Worker 302s `/admin`, `/dashboard`, `/settings` and `/accounts` to `/login`. The
reconstruction in `apps/web-edge-cf/src/handler.ts` proxies everything except asset paths and has no such
gate. So the deployed artifact (version #3, uploaded by hand on 2026-10-06) contains behaviour the
repository cannot reproduce — which means **deploying the reconstruction today would silently remove the
auth redirect** if it also stopped fronting a Next server.

That is why `apps/web-edge-cf/deploy.sh` remains gated behind `CONFIRM_EDGE_DEPLOY=yes` and why this
document does not ask for it. One addition was made to the reconstruction (tested, not deployed): when the
origin answers with the platform's `Application not found` envelope, the edge now returns
`503 {error: "edge_app_origin_unavailable"}` instead of passing a 404 through. That does not fix the
blocker; it stops the blocker from *looking* like a routing bug.

## 7. Verification status for Objective B

| Item | Status | Note |
|---|---|---|
| Next routes / admin page / login / session / role checks audited | **PASS** | Code read: `(app)/admin/page.tsx` (permission-driven tabs from `/admin/rbac/self`), `apps/web/src/proxy.ts`, `next.config.ts` |
| Cloudflare web Worker deployment + assets + bindings inspected | **PASS** | Live curls above; repo shell in `apps/web-edge-cf` |
| Intended staging URL verified | **PASS** | `velora-modern-staging.yadgar-s-ict.workers.dev` |
| Exact failure on login/admin traced | **PASS** | `POST /api/v1/auth/login` → platform 404 envelope → no session → 302 loop |
| Failure classified (route vs auth vs role vs DB vs authorization) | **PASS** | §3 |
| Smallest compatible deployment path | **BLOCKED** | No credential this session; both options require an owner decision (new dependency vs new host) |
| Admin panel accessible | **NOT VERIFIED — and not claimed** | Cannot obtain a session |
| Login / session / admin authorization / ordinary-user denial proven by tests | **PASS** (API layer) | `apps/api/src/admin/adminConsoleRoutes.test.ts` — anonymous 401, plain user 403 on **every** console route incl. mutations, super_admin-only fields; `apps/api/src/auth/*` covers session rotation and expiry. The *web* half of the same flow is unreachable until the API exists, and is labelled accordingly rather than claimed |
| Anything deployed for Objective B | **NONE** | Nothing was deployed; no DNS, no routes, no new resource |

---

# Objective D — the implementation that retires the blocker

**Date:** 2026-10-20 · **Scope:** staging only · **Railway:** not used · **Verdict:** code complete and
verified as far as this sandbox allows; **deployment BLOCKED — no Cloudflare credentials in this session.**

## D1. Root cause, restated precisely

`POST /api/v1/auth/login` was reaching **no API at all**. Two independent facts pinned it:

1. The API's own 404 is `{"status":"error","error":{"code":"NOT_FOUND","requestId":"<uuid>"}}`
   (`apps/api/src/kernel/server.ts`). The live answer was
   `{"status":"error","code":404,"message":"Application not found","request_id":"…"}` — a different
   envelope, from the platform.
2. `apps/web-edge-cf/wrangler.jsonc` (the description of the live Worker) forwards `/api/*` to
   `https://velora-modern-staging.up.railway.app`, and `apps/web/next.config.ts` had
   `rewrites([{ source: "/api/:path*", destination: "${VELORA_API_ORIGIN}/api/:path*" }])`. A rewrite is
   resolved at **build** time, so the staging bundle carried that Railway host; the host no longer
   exists, and Railway's edge answers `404 {"message":"Application not found"}`.

So the fix could not be "point the proxy somewhere else": there was no API on Cloudflare to point at.

## D2. The architecture chosen (and why it is not a second API)

```
browser ── same-origin ──▶ panel Worker (velora-modern-staging, OpenNext)
                              ├── src/proxy.ts  ── GET <API>/api/v1/auth/session   (SEC-04 gate, fail-closed)
                              └── /api/* route  ── forward ──▶ API Worker (velora-api-staging)
                                                                  └─ createRequestListener(config)  ← SAME kernel as Node
                                                                      └─ Hyperdrive velora-pg-nonprod → Neon staging
```

* **One dispatch.** `apps/api/src/kernel/server.ts` gained `createRequestListener(config)`; `createApp`
  is now a 4-line wrapper around it. Both the Node server and the Worker host call the same function.
  Routing, auth, RBAC, envelopes and headers are not duplicated anywhere.
* **One new file in the request path:** `apps/api-cf/src/nodeHttpBridge.ts` (header folding, lazy body
  iteration, `cf-connecting-ip` → `remoteAddress`, multi-value `set-cookie`, no body on 204/304). It
  implements the **six** members the kernel reads — measured, not assumed.
* **One composition root per host.** `apps/api-cf/src/runtime.ts` wires the panel's capabilities over
  Hyperdrive and inherits `assertBootable`, so a Worker cannot be configured into a state the Node
  server would reject. Absent capabilities answer `503`, never empty `200`s.
* **No build-time origin anywhere.** `/api/*` is a route handler
  (`apps/web/src/app/api/[...path]/route.ts`) that reads `VELORA_API_ORIGIN` **per request** through
  `apps/web/src/lib/apiOrigin.ts`, the single place the origin is named. The `rewrites()` block is gone.
  The same code runs on a VPS with `VELORA_API_ORIGIN=http://127.0.0.1:8080`.
* **Cookies stay first-party.** The API's `__Host-velora_refresh` (Secure, Path=/, no Domain) is set
  through a same-origin hop, so it is not a third-party cookie the browser would drop. `set-cookie` is
  appended as separate headers, never folded.
* **The admin gate is untouched.** `src/proxy.ts` still probes the API and 302s to `/login` when the
  answer is not a live session (`SESSION_PROBE_TIMEOUT_MS = 1500`, fail-closed), and `/admin` still
  requires a panel role. Its probe origin is now read per request — the module-level `const` it used
  was itself a Worker bug (`process.env` is populated per request, so the gate would have probed
  `127.0.0.1:8080` and denied every page).

## D3. What is verified, and how

| Check | Command | Result |
|---|---|---|
| Typecheck (6 projects, `apps/api-cf` now included) | `npm run typecheck` | **0 errors** |
| Full suite | `npm test` | **exit 0** — general 1790 (1789 pass / 0 fail / 1 named skip `NO_TESSERACT_BINARY`), PGlite 87/87 |
| Secret scan | `npm run secret-scan` | **PASS (0 findings)** |
| API Worker bundles for workerd | `wrangler deploy --dry-run -c wrangler.deploy.jsonc` | **800 KiB / 180 KiB gzip**, Hyperdrive binding resolved |
| API Worker runs in workerd | `wrangler dev --local --var JWT_SECRET:…` | `/health` → `200 {"status":"success"}`; `/api/v1/nope` → API's own `404 NOT_FOUND` + `requestId`; no-secret boot → `503 BOOT_BLOCKED` with codes only |
| Panel builds (Next) | `npm run build -w @velora/web` | **success**; route table contains `ƒ /api/[...path]` and `ƒ Proxy (Middleware)` |
| Panel bundles for workerd (OpenNext) | `opennextjs-cloudflare build` | **BLOCKED — sandbox OOM** at `Building server function: default` (node killed at ~1.0–1.2 GB RSS; machine has 2 GB, no swap). Fails identically with `--noMinify`, `--max-old-space-size=420/600/700`, `MALLOC_ARENA_MAX=2`. Needs a ≥4 GB machine. Not a code defect: everything up to the bundle step succeeds |
| Deploy to staging | — | **BLOCKED — no `CF_TOKEN` this session** |
| Live tests on real staging (Objective D item 5) | — | **NOT RUN** — nothing was deployed, so there is nothing to test |

### A real bug the local workerd run caught

`NotificationService`'s constructor called `fileURLToPath(import.meta.url)`. A bundled Worker has no
`import.meta.url`, so **every route answered 500** (`/health`, login, the session probe) because the
notification service is built while building the app. Fixed in
`apps/api/src/notifications/notificationService.ts`: the icon directory is resolved lazily, where a
missing asset is already recorded as `icon-missing` and fails only that email. Contract unchanged; blast
radius reduced from "the API" to "one message". Pinned by the existing 13 notification tests.

This is exactly why `wrangler deploy --dry-run` and a green `next build` are not the completion bar.

## D4. Remaining blockers, in the order they must be cleared

1. **Credentials.** `CF_TOKEN` + `CF_ACCOUNT_ID` (`9ef5ad5202a5e9db190bf3ecb83e3eff`) must exist for
   the deploy. Nothing in this session had them; nothing was deployed.
2. **Bundle the panel on a machine with ≥4 GB RAM** (or in CI) — `npm run cf:build -w @velora/web`.
3. **`wrangler secret put JWT_SECRET`** on `velora-api-staging` (≥32 chars). Without it the Worker
   answers `503 BOOT_BLOCKED: SC-001` — fail-closed, by design.
4. **Deploy order:** API Worker first (`apps/api-cf`), then the panel (`apps/web`) — the panel's
   `VELORA_API_ORIGIN` points at `https://velora-api-staging.yadgar-s-ict.workers.dev`.
5. **Migration 0042** (`telegram_post_preferences` flow columns) is still **not applied to Neon**. It
   gates the bot's post-edit/result screens, **not** the panel's login or `/admin`.
6. **Admin provisioning.** No admin account is created by this work, and none may be fabricated. The
   existing secure paths (System Owner bootstrap + `AdminUserService`) are the only ones; if staging has
   no admin row, that must be established through them, with the owner's decision, before the
   "authorized admin opens the panel" live test can pass.
