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
