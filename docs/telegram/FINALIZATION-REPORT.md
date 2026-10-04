# Telegram Journal Client — Finalization Report (AC-10)

**Date:** 2026-10-04 · **Branch:** `feat/telegram-journal-client` · **Base:** `main` @ `0e9c4d7e6e1f984287490ce02f5681c208e35c7a`
**Head:** `1c21b571c1056efbc99d5fa21012f872b66b849b` · **Pull request:** [#9](https://github.com/veloratrade/velora-modern/pull/9) (open, base `main`, 10 commits, 66 files)
**Status vocabulary used below:** IMPLEMENTED / TESTED / COMMITTED / PUSHED / PR CREATED / DEPLOYED / LIVE VERIFIED — never collapsed, and each one carries its evidence.

---

## A. Git state

| Fact | Evidence |
|---|---|
| Branch `feat/telegram-journal-client`, base `main` @ `0e9c4d7` (unchanged during this work) | `git rev-parse`, `git merge-base --is-ancestor 0e9c4d7 origin/main` → YES |
| **10 commits** (7 from AC-9 + 3 from this round) | `git log --oneline 0e9c4d7..HEAD` |
| Working tree clean at every commit; no rebase, no squash, no history rewrite | `git status --porcelain` → empty; the only rewrite was an **amend of an unpushed local commit** (`798532b` → `1c21b57`) |
| Remote branch exists and equals local HEAD | `git ls-remote --heads origin feat/telegram-journal-client` → `1c21b571c105…` = `git rev-parse HEAD` |
| PR created and verified | GitHub API `GET /pulls/9` → `state=open`, `head.sha=1c21b571c105…`, `base.ref=main`, `mergeable=true` |
| The "SHA inconsistency" between `e6d861a` and `e979811` that was reported to the owner | **resolved as linear history, not a conflict**: `git merge-base --is-ancestor e6d861a e979811` exits 0 |

This round's commits (in the directive's prescribed order):

| SHA | Subject |
|---|---|
| `3dbd72d` | `web(telegram): one canonical Telegram surface inside the account page` |
| `6b08c62` | `fix(telegram): enforce the declared limits and bound every input` |
| `1c21b57` | `test/docs: real-PostgreSQL concurrency battery, catalog render guard and state records` |

> Note on provenance: before pushing, the remote was fetched. `feat/mg-obs-6-pg-smoke-expectation` (`9d59bca`, **pushed by the owner, not merged**) already fixed the same MG-OBS-6 defect this round needed fixed. Rather than push a competing implementation, this branch carries that file's **exact content** (verified byte-identical with `diff`). One fix, two branches, no conflict.

## B. UX decision — the single canonical Telegram surface

**Audit first (what actually exists):** `apps/web/src/` contains exactly **two** consumers of the Telegram catalog — `components/layout/Sidebar.tsx` (a nav label) and `app/(app)/settings/page.tsx` (the 322-line linking screen from `e8d8d04`). `app/(app)/profile/page.tsx` is a declared **GAP shell** (its own copy: "no Modern backend yet"); it holds no functionality and is linked from nowhere.

**Decision:** the canonical surface is **`/settings`**, presented as the **account page** with Telegram as one **connected account** inside it. Building a second Telegram surface inside the Profile stub would have created exactly the duplication the directive forbids.

**What changed (three things):**

1. **Nav label** — the sidebar item that opens the screen was labelled from the *feature* catalog, so a list holding Dashboard, Journal and Analytics also held "اتصال تلگرام / Telegram connection": a feature-shaped top-level destination, and the account screen hidden behind it. It now reads **Settings / تنظیمات** (`telegram.settings.title`). Route, icon and screen untouched.
2. **Page framing** — the page was titled after the feature. It is now titled as the account page with a **"Connected accounts / حسابهای متصل"** heading above the Telegram card (`<section aria-labelledby>` — a real landmark, not a styled `div`). A future non-Telegram setting now has somewhere to live.
3. **Entry point** — the signed-in user card in the sidebar was plain `<div>`s: the account chrome had **no path at all** to the account screen. It is now a `<Link>` to that surface, with the inner markup byte-identical (same classes, avatar, online dot, two lines), so the visual language does not move. Signed-out visitors keep the plain `div` — they have no account screen.

**Anti-duplication check:** `grep -rn "telegram" apps/web/src --include=*.tsx -l` → 2 files (the two consumers). One surface, one location.

## C. Design preservation

- **"No existing user capability was removed."** Every state card, button, channel section, error path and the six-state vocabulary (`NOT_LINKED / LINK_PENDING / LINKED / LINK_REVOKED / LINK_EXPIRED / LINK_ERROR`) are exactly as they were. The diff on `settings/page.tsx` is +14/−3 and touches only the page head and the section wrapper.
- No file was redesigned, flattened or simplified; no navigation item was dropped (one was **relabelled**); no spacing, hierarchy or density value was changed; no new CSS class was introduced (existing vocabulary only: `page-head`, `page-title`, `page-sub`, `card`, `label`, `badge-*`).
- Catalogs stayed **catalog-based and additive**: exactly three new keys per locale, the byte-copy key format preserved, version bumped. No hard-coded user-facing string was added to a component.
- RTL and localization: the Persian strings resolve through the same translator the components use, with ZWNJ preserved (now guarded by a test, see §E).

## D. Security findings and fixes

| # | Finding (evidence) | Fix | Guard that fails without the fix |
|---|---|---|---|
| 1 | `telegram:journal` (20/h) and `telegram:analyze` (8/h) were **declared in the frozen contract and described in `SECURITY.md` but enforced nowhere** (only `telegram:update`, `telegram:link-start`, `telegram:channel` had call sites) | checked before the work they bound: media download / provider call | a test exhausts each key and asserts **no download, no provider call, no draft row** |
| 2 | `getFile`'s declared `file_size` was ignored, so an oversized file was downloaded in full before the API layer's cap could refuse it | declared size checked first (5 MiB, same constant as the download); the post-check stays | an oversized **declared** size must not start a download; a **lying** size is still refused after it (the test fake now mirrors production and throws) |
| 3 | The webhook ingress was bounded at the kernel's 1 MiB JSON default | 256 KiB (`TELEGRAM_WEBHOOK_MAX_BODY_BYTES`) | an oversized body → 400 `VALIDATION_FAILED`, and the update is **never claimed** |
| 4 | `telegramApi.ts` documented a pre-check it cannot perform (the declaration does not travel with `filePath`) | the comment now states which layer owns which half | review-visible; no behavioural change |

**Not weakened to make anything pass:** the contract rate-limit values are unchanged, no atomic statement was rewritten, no test was relaxed. `SECURITY.md` §7 now carries a **key → call-site** table so the claim can be checked against the code, and §5a a bounds table.

**What remains true and unchanged:** one update-stream consumer (enforced three ways); webhook mode in production with polling refused; the deep-link payload carries only an opaque crypto-random token; the bot never asks for a password or code; log calls contain no user text, token, transcript or payload (grep-verified, 22 event names).

## E. Tests

**Local battery at the final SHA (`1c21b57`):**

| Command | Result |
|---|---|
| `npm run typecheck` | **exit 0** (5 projects) |
| `node tools/run-tests.mjs` | **957 / 957 passed, 0 failed, 0 cancelled, 0 skipped** (~190 s) — baseline was 945/945 at AC-9; +6 bot-wiring tests, +6 catalog render tests |
| `bash tools/secret-scan.sh` | **PASS (0 findings)** |
| `npx next build` (apps/web) | **exit 0**, `/settings` + `/en/settings` present in the route table |

**Real-PostgreSQL evidence — PostgreSQL 16.15** (PGDG build, disposable cluster created with `initdb`, trust auth, `DATABASE_URL` only, destroyed after the run; the same version the project's evidence history uses — *not* the 17.11 of the older AC-6 run):

| Battery | Result |
|---|---|
| `db/tests/telegramConcurrency.pg.test.ts` **(new)** | **9 / 9** |
| `tools/pg-smoke.ts` S1–S9 (fresh database) | **all PASS**, 23/23 migrations, re-run no-op |
| `db/tests/pgTradeConcurrency.pg.test.ts` | **14 / 14** |
| 7 store/capability batteries | **47 / 47** |
| **Total real-PG tests** | **70 + the S1–S9 smoke** |

The new battery proves the four atomicity claims on a real multi-connection server: a one-time linking token is spent **exactly once** (two Telegram identities race one token → one SUCCESS, one REJECTED, one identity row, the token records the winner, one success audit row and no phantom failure); the same identity double-sending yields one link; an expired token cannot be spent late; `claimUpdate`, `claimDraftForConfirmation` and `claimChannelPost` each admit exactly one winner. **One test forces the interleaving** — a third session holds the row lock while both spenders arrive blocked — so the proof does not depend on scheduling luck. It is wired into `.github/workflows/postgres-evidence.yml` (dispatch-only, anti-SKIP: executed count ≥ declared, `# skipped 0`, `# fail 0`).

**PGlite is never claimed as concurrency evidence** — a single session cannot falsify a single-statement guard. That was the reason for this battery, not a formality.

**Rendered Persian strings (the defect class this project has already hit):** `apps/web/src/i18n/catalogRender.test.ts` (**6 tests**) asserts what the components are actually handed by `createTranslator` — no replacement characters, no literal escapes, ZWNJ preserved, fa/en key-for-key identical, the settings title distinct from the feature name. Writing it surfaced one real, documented transformation: the platform renders **Latin digits always**, so a catalog value of `۱.` is handed over as `1.` — by design, now pinned rather than inferred.

**Honest limits of the local checks:** a live boot smoke (web app → API → PostgreSQL 16.15) registered a user and returned 200 for `/settings` and `/en/settings` with clean UTF-8 transport, but the authenticated surface renders **client-side**, so that proves boot and transport — **not layout**. No browser was available in this environment, so **no visual or responsive screenshot verification was performed**; the responsive behaviour is unchanged by construction (no CSS or layout change; the only structural edit is the section wrapper and the user-card link wrapper).

## F. Live verification

| Item | State | Blocking reason |
|---|---|---|
| Local batteries, typecheck, secret scan, next build | **VERIFIED** (exact numbers in §E) | — |
| Real-PostgreSQL concurrency (16.15) | **VERIFIED** (§E) | — |
| Telegram Bot API round trip (send/getFile) | **LIVE UNVERIFIED** | no `TELEGRAM_BOT_TOKEN` in scope |
| Gemini transcription / vision | **LIVE UNVERIFIED** | provider credential unavailable |
| Webhook delivery from Telegram's servers | **LIVE UNVERIFIED** | requires a deployed public origin + `setWebhook` |
| Worker / queue path | **NOT IMPLEMENTED BY DECISION** (MG-TG-3) | worker not deployed; documented, not faked |
| Staging verification | **NOT PERFORMED** | no staging deployment reachable from this environment |
| Push | **VERIFIED** — remote branch equals local HEAD (`ls-remote`) | — |
| PR | **VERIFIED** — #9 open, base `main`, mergeable | — |
| Deployment | **NOT DONE** — nothing was deployed, and nothing claims otherwise | — |

The capability-absent behaviour is itself verified rather than assumed: with no bot token the API boots, answers every Telegram route with its documented fail-closed 503, and reports `telegram.disabled` — measured, not asserted.

## G. Delivery

**Delivered:** the Telegram journal client as a first-class client of the existing platform — migration `0023` (6 tables, audit vocabulary 7→13, `provider ∈ {METAAPI, TELEGRAM}`), the bot with its confirmation flow (`[تأیید][ویرایش][لغو]`, never inventing fields), the website-first linking flow with its six states, one web surface placed inside the account page, the operator documentation (`README`, `DEPLOYMENT`, `SECURITY`), ADR-018 with its amendment, the state records, and — this round — enforced limits, bounded inputs, a real-PostgreSQL concurrency battery and two regression guards.

**Not delivered, deliberately:** no `journal_entries` table (the journal remains the ADR-002 ledger through `TradeService`), no second journal aggregate, no second auth system, no separate database, no queue/worker, no n8n relay, no polling in production, no duplicate Telegram surface.

**Open items, honestly:** MG-TG-1 (no live round trip — credentials), MG-TG-2 (n8n relay deliberately not implemented — owner decision: add a relay contract or record the drop), MG-TG-3 (synchronous processing until a worker is deployed), and MG-OBS-6 which this round **closed** — carried byte-identically from the owner's own branch.

**Next action for the owner:** review PR #9. The one thing that would move "LIVE UNVERIFIED" to verified is a deployed origin plus a bot token (and a provider key for the media paths); nothing in the code path prevents it, and nothing here pretends it has already happened.
