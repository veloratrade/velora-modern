# Telegram platform round 5 — the Agent-tools panel, opened in a real browser: consolidated report

Scope: the browser-verification round for the round-4 admin `Agent tools` tab (dev server + real browser,
provider mock/local API only, fix what the pass finds, no commit/push/deploy). This file answers the brief's
11 questions in order. Baseline was re-checked, not assumed.

---

## 1. HEAD — initial and final

Both **`354edaa`** (`state: advance verified to 7d91ff1 — quality gate successor, backup byte-identity, twin,
ceiling`), branch `main`. Nothing was committed.

## 2. Working tree — before and after

Before the round (measured at its start): **44 `M` / 45 `??`** — matching what the round-4 report promised.
After: **45 `M` / 48 `??`** (measured with `git status --porcelain | grep -c`). The new paths, all
accounted for: `tools/admin-ui-verify/{server,browser,constants}.mts` (untracked), the two new catalog keys +
UI edits riding on already-modified web files, `docs/state/evidence/admin-ui-round5/**` (screenshots +
`results.json`), this report, and the round-5 `CHANGE_LOG.md` paragraph appended to the already-modified log.
No untracked file was deleted, overwritten by a rewrite, or replaced; no `git clean`/`reset`/`stash`/`revert`
was run.

## 3. Dev server — executed?

Yes. Two ways, in fact: first `next dev` (webpack, port 3000, binding 0.0.0.0) with the repo's own rewrite
`/api/:path* → VELORA_API_ORIGIN ?? http://127.0.0.1:8080`; after two dev-server OOM deaths (2 GB sandbox;
`dmesg` recorded `Out of memory: Killed process … next-server` twice — a property of the sandbox, not of the
app), the remaining runs drove **`next start` on a production `npm run build`** — which is itself extra
verification: the tab compiles into the shipped bundle (build rc=0, twice).

## 4. The admin page in a real browser — opened?

Yes, rendered DOM only. Never a JSX/CSS/type review as a substitute: every check reads `innerText`/
`screenshot`/`locator` state from a live page after a real login through the real form (`#email`/`#password`,
HttpOnly `__Host-velora_refresh` cookie, in-memory access token, and a genuine reload through the refresh
path).

## 5. Browser and method

Chromium via the sandbox's **Playwright 1.63** (`/usr/local/bin/playwright`, library at
`/opt/playwright/node_modules`, browser `chromium-1243`, headless, `--no-sandbox --disable-dev-shm-usage
--disable-gpu`), driven by `tools/admin-ui-verify/browser.mts` under `tsx`. One browser **context per
persona** — the guard's own cookie semantics make a shared context silently test the wrong identity, which
was caught and fixed in the driver. Nothing new was installed; the repo's existing toolchain (npm workspaces,
tsx) plus the pre-provisioned Playwright were used.

## 6. UI scenarios exercised (all on rendered pages)

Six scenarios, each with the rig restarted to the matching server-side shape — states are decided by the
BACKEND, never painted by the client: `configured` (25 checks), `reject` (424 from a live refused probe),
`hang` (provider never answers → the service's own 8-second timeout), `worker` (`raster: null` and no
`rasterize` at all — the real Worker shape), `none` (tool services unmounted → 503), `nosecret` (no tool
credentials). Across them: table rendering and row count; the five-state vocabulary staying distinct
(`Configured, not checked` ≠ `Not configured` ≠ `Not possible in this runtime` ≠ verdict-only `verified` /
`Failing`); credentials cell naming keys + presence + source, never values; the loading state (`Checking…`,
button disabled mid-flight, second click impossible); the reload showing **no stale green**; empty/error
states (no table + failure copy under `none`); the audit tab showing the real `AI_TOOL_VALIDATED` row through
the product's own `/api/v1/admin/audit-logs`; Persian rendering (fa route, Vazirmatn, RTL) as its own pass.
Screenshots and per-check `results.json`: `docs/state/evidence/admin-ui-round5/<scenario>/` — 46 checks, all
green in the final matrix (configured 25, reject 4, hang 6, worker 4, none 2, nosecret 5).

## 7. Defects found and fixed (root cause → real fix → regression guard)

1. **The UI discarded the verdict it was given.** `POST …/validate` puts the computed evidence in the body
   of the 200 *and* of the 424; the web client's error branch parsed only error envelopes, so a 424 became
   a shrug. Root cause: `api.request()` throws `ApiError` without the payload's `data`. Fix:
   `ApiError.data` (additive, documented as "for the rare non-2xx that carries a real payload"),
   `adminAiToolVerdictFromError()` in `resources.ts`, and the panel rendering
   `tool · state · status · errorCode? · latency · instant` for both outcomes. Guard: `adminSurface.test.ts`
   asserts all three pieces exist and that `probe()` does not re-read the table "to see the state change".
2. **A column that could only ever lie.** "Last checked" read `never` forever, because `capabilities()`
   deliberately never caches a check (revoked keys must not stay green). Fix: the column is gone; the moment
   travels with the verdict line; `adminConsole.ai.noCache` states the rule to the operator. Guard: the test
   forbids the key returning.
3. **Duplicated sentence.** An `unsupported` row printed the runtime suffix on top of the identical badge
   label ("Not possible in this runtime · Not possible in this runtime") — visible only on a screenshot.
   Fix: suffix prints only when it adds to the state word. Guard: the source assertion.
4. **Header decoration misread as UI bug** (mine, from round 4): a badge literally saying "Tool". Now the
   tool count, `{count} tools`, in both locales, with a browser check asserting the number.
Also fixed were two RIG fidelity bugs (the hang mock now obeys the AbortSignal like a real fetch; the Worker
shape omits `rasterize` entirely) — documented because they initially produced false FAILs.

No error was hidden, no capability removed, no response mocked to turn the UI green: every state below comes
from a real HTTP answer the rig's process computed.

## 8. Tests executed in THIS round (round 4's results not reused)

* Full repo suite after the fixes: `npm test` → **exit 0**; general batch **1733 tests / 1732 pass / 0 fail /
  1 named skip** (`NO_TESSERACT_BINARY`), PGlite batch **85/85**.
* `apps/web/src/i18n/adminSurface.test.ts`: **10/10** (includes the new round-5 guards; also the key/class/
  permission guards that had to keep passing over the changed page).
* `tsc -b apps/web` → 0; `npm run build -w apps/web` (production) → 0, twice.
* Browser matrix final run: **46 checks / 0 failures** (see §6).
* HTTP-level spot checks (login → 403/403/200 panel read; probe 200 `verified`; audit row `tool:web_search
  verdict:ok` via `/admin/audit-logs`) — the same flows the browser exercised, kept as raw evidence.
* Secret scan (§9).

## 9. Credential security status

`VERIFIED_IN_BROWSER` for the panel's own surface: the sentinel string was scanned for in **every API
response body and every console line** across all six scenarios (Playwright `response`/`console` taps) — zero
hits, in DOM too (`no sentinel in the DOM`, `no sentinel in the audit tab DOM`, and a 403-body check that
the refusal carries neither the sentinel nor the provider name). The credentials column shows key names +
presence + source (`set (from the environment)`) and never a value; the list endpoint has no secret fields in
its DTO at all (round-4 design, now confirmed on rendered screens). Credential WRITE/DELETE is not in scope
for this tab (tool secrets are env-resolved by design — `PUT /admin/ai/credentials` manages model-provider
keys only), and the audit row records the verdict, not the credential. `admin@verify.local`'s direct POST
being 403'd **before any provider call** remains asserted at API level (no bytes left the rig in the
`none`/permission paths: egress counters 0).

## 10. Permission status

`VERIFIED_IN_BROWSER`: plain user — the console itself never opens (route guard moved them to their
dashboard; the "no tab" case is therefore asserted as "no console"), and `GET /api/v1/admin/ai/tools` with
their own in-browser bearer token returns **403 `FORBIDDEN` "Insufficient role."**. Admin — reads the table,
sees **no probe button**, and the panel says why (`super-admin route permission` copy); their in-browser
`POST …/validate` returns **403 from the route** — the hidden button is never the boundary. Super admin —
button, verdict, audit row. `TESTED_WITHOUT_BROWSER` only for what the rig cannot mount at all (the Worker
deployment's separate authorization path — unchanged from prior rounds).

## 11. Status labels, per item, and what could not be checked here

| Item | Label |
| --- | --- |
| Panel rendering, states, loading/disabled, verdict evidence, reload, fa/RTL, audit tab, tab-visibility | `VERIFIED_IN_BROWSER` |
| 424-as-verdict recovery, no-stale-green, permission asymmetry incl. route 403, sentinel leak scan | `VERIFIED_IN_BROWSER` |
| `verified`/`failing` transitions against a REAL provider | `VERIFIED_WITH_MOCK_API` — no credentials exist here; the probe machinery, timeout and refusal mapping are the product's, only the endpoint is a double |
| Timeout behaviour end-to-end | `VERIFIED_IN_BROWSER` over the mock, `TESTED_WITHOUT_BROWSER` against a real slow provider (cannot be created safely) |
| OCR on a real screenshot | `BLOCKED_BY_ENVIRONMENT` — no `tesseract` binary (named skip in the suite), unchanged |
| Persian raster in a Worker | `BLOCKED_BY_ENVIRONMENT` (native module is Node-only) — and that IS what the `worker` scenario proves the panel reports honestly (`unsupported`, one sentence, once) |
| Real Telegram Bot delivery | not in this round's scope; unchanged `BLOCKED_BY_ENVIRONMENT` (no token) |
| Live Neon / deployed Worker / production origins | untouched by design; the rig is loopback + memory-store by the boot gate's rules |

**Explicit confirmations.** No commit. No push. No deploy. No production, Cloudflare, Hyperdrive, Neon or
operational configuration was read for change or altered; no secret was created, rotated or removed; no real
provider was called (the egress counter proves it: 0 targets for the refusal scenarios, and every "provider"
answer in this round came from the local double and is labelled as such).

**Live for inspection while this session lasts:** `next start` (port 3000) + the rig (loopback 8080,
`configured` scenario) are running — the preview opens at `/en/login` with `root@verify.local` /
`admin@verify.local` / `plain@verify.local`, password `local-verify-rig-password-123` (rig fixtures, not
secrets). They exist only for this look and can be stopped at any time; nothing else was left running.
