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

# Objective D — DEPLOYED to staging, with live evidence (2026-10-20)

**Scope:** staging only · **Railway:** not used · **Verdict:** the blocker is **retired**. The panel and the
API are both live on Cloudflare and `POST /api/v1/auth/login` now reaches the real API. Two acceptance
items still need a **real account** and are labelled as such rather than claimed.

## D0. What is deployed

| Worker | Version | URL |
|---|---|---|
| `velora-api-staging` (**new**) | `364ac8ee-d87e-4730-81a8-b8e513d47315` | `https://velora-api-staging.yadgar-s-ict.workers.dev` |
| `velora-modern-staging` (**replaced**, same name/origin — no DNS change) | `fe2f82b6-b335-4c83-8995-191a5b71e0c7` | `https://velora-modern-staging.yadgar-s-ict.workers.dev` |
| `velora-telegram-bot` (untouched) | `6f15c6dc-dc6f-4895-9162-85af8936b2f0` | — |

`JWT_SECRET` was generated inside the sandbox and piped straight into `wrangler secret put` (stdin); it was
never printed, never written to a file, and is not in git.

## D1. Root cause (proven, not inferred)

`POST /api/v1/auth/login` reached **no API at all**: `next.config.ts` rewrote `/api/:path*` at BUILD time to
`VELORA_API_ORIGIN`, which in the deployed bundle was the retired Railway host, so Cloudflare answered
`404 Application not found` — a platform envelope the Velora API never emits (the API's own 404 is
`{"code":"NOT_FOUND","requestId":"<uuid>"}`).

## D2. Live results on the real staging host

| Test | Result | Evidence |
|---|---|---|
| Public/login routes serve HTTP | **PASS** | `/` 200, `/login` 200, `/en/login` 200, `/register` 200, `/fa/checkout` 200 |
| **Login reaches the real API — `404 Application not found` is gone** | **PASS** | `POST /api/v1/auth/login` → `401 {"error":{"code":"INVALID_CREDENTIALS","requestId":"d181f685-…"}}` |
| The API's own 404 shape survives the hop | **PASS** | `/api/v1/definitely-not-a-route` → `404 {"code":"NOT_FOUND","requestId":"a79d018e-…"}` |
| Anonymous blocked from protected pages | **PASS** | `/admin` 302→`/login`, `/en/admin` 302→`/en/login`, `/dashboard` 302→`/login`, `/settings` 302→`/login` |
| Gate fails CLOSED on an unverifiable session | **PASS** | `/admin` with a bogus `__Host-velora_refresh` → 302→`/login`, no protected HTML |
| Admin API refuses anonymous callers | **PASS** | `/api/v1/admin/overview` 401 `UNAUTHENTICATED`, `/admin/rbac/self` 401, `/admin/users` 401 — each with a `requestId` |
| Session probe | **PASS** | `/api/v1/auth/session` → `200 {"authenticated":false,"role":null}` |
| **Cookie integrity through the panel hop** | **PASS** | `POST /api/v1/auth/refresh` with a bogus cookie → `401 INVALID_TOKEN` **and two separate `set-cookie` headers** (`__Host-velora_refresh=; …Max-Age=0`, `refresh_token=; …Max-Age=0`) — identical to calling the API origin directly. A folded header would have been a silently dropped cookie |
| Logout without a session | **PASS** | `POST /api/v1/auth/logout` → `200 {"loggedOut":true}` |
| Security headers from the real Next proxy | **PASS** | HSTS `max-age=31536000`, CSP with per-request nonce + `strict-dynamic`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `COOP: same-origin`, `X-Robots-Tag: noindex` (staging) |
| Valid login creates a session | **BLOCKED** | Needs a verified staging account; no password exists in this session and none was invented |
| Authorized admin opens the panel + main operations | **BLOCKED** | Same reason — no account was created or fabricated |
| Non-admin blocked from the admin panel (live) | **NOT VERIFIED live** | The API layer proves it (`adminConsoleRoutes.test.ts`: anonymous 401, plain user 403 on every console route, mutations included); the live half needs a non-admin session |
| Logout / session expiry with a live session | **NOT VERIFIED live** | Needs a live session; the API-layer rotation/expiry tests pass |

## D3. Architecture (unchanged from the code-only round)

```
browser ── same-origin ──▶ panel Worker (velora-modern-staging, OpenNext + Next 16.4.1)
                              ├── src/proxy.ts  ── GET <API>/api/v1/auth/session   (SEC-04 gate, fail-closed)
                              └── /api/* route  ── forward ──▶ API Worker (velora-api-staging)
                                                                  └─ createRequestListener(config)  ← SAME kernel as Node
                                                                      └─ Hyperdrive velora-pg-nonprod → Neon staging
```

The API answered a real credential check in ~1.2 s on a cold connection, which is itself the proof that
Hyperdrive → Neon staging is wired: `INVALID_CREDENTIALS` is only reachable after a successful
`findUserByEmail` against the database. `assertBootable` still gates the Worker; a missing `JWT_SECRET`
answers `503 BOOT_BLOCKED: SC-001` rather than serving anything.

## D4. Build/environment facts worth keeping

* `opennextjs-cloudflare build` needs **≥4 GB of usable memory**. In this 2 GB sandbox it was OOM-killed at
  `Building server function: default` (node ≈1.0–1.2 GB RSS, no swap) with every heap setting tried; adding
  **4 GB of swap** made the identical command succeed. That is the prerequisite, not a code defect.
* `wrangler ≥4.140` requires **Node ≥22**; the panel deploy ran on Node 22.20.0 (the repo's own build and
  test gates still run on Node 20, which is what `engines` allows).
* `apps/api-cf` had to be added to the root `npm run typecheck` (6 projects) — its `tsconfig.json` compiles
  the API sources directly, which is what keeps "one kernel, two hosts" true rather than aspirational.

## D5. What is left — and a gap this deployment exposed

**The panel is deployed, gated and reachable, but nobody can log into it: staging has no admin account, and
there is no path in the product that can create the first one.** That is not a bug in the panel; it is a
missing capability, and it is the last thing between "deployed" and "usable".

Why every route fails closed here, from the source:

| Path | Why it cannot bootstrap the first admin |
|---|---|
| `POST /api/v1/ownership/claim` (`OwnershipService.claim`) | precondition 4 requires the acting row to **already** be `role = 'admin'` (and active + email-verified). It claims ownership *of* an existing admin; it does not create one |
| `AdminUserService` (invite / create user) | requires an authenticated admin to call it |
| `POST /api/v1/auth/register` | creates an unverified `normal` user; login then answers `401 EMAIL_NOT_VERIFIED`, and this Worker's mail port is the log provider, so no verification link is sent |
| ops scripts (`ops/`, `tools/`) | none seeds an admin |

Unblocking options, all owner-side (none of them invented here):

1. **An existing admin whose password the owner holds.** The owner reported on 2026-10-20 that no such
   credentials exist.
2. **DB-level provisioning** with the owner's Neon staging credentials: a `users` row with `role='admin'`,
   `status='active'`, `email_verified_at` set and a `password_hash` produced by the app's own
   `VeloraHasher` — so the password policy is respected rather than bypassed. Then the login/session/RBAC
   rows above can be executed live.
3. **A reviewed ops script** that performs (2) with the app's own hasher. Not written here: it creates an
   account, which is an owner decision, not an agent one.

Still open, unrelated to the above: **migration 0042** is absent from Neon (bot post-edit/result screens,
not the panel), and rebuilding the panel needs `npm run cf:build -w @velora/web` on a ≥4 GB machine followed
by `npx wrangler deploy` from `apps/web`.

