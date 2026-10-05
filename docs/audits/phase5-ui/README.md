# Phase 5 — support center · visual & responsive QA evidence (2026-10-04)

Screenshots from a real browser (Playwright/Chromium 153) against the **production
build** (`next build` + `next start`, `VELORA_API_ORIGIN` → the live API on
PostgreSQL 17.11), signed in with accounts created through the public
register → verify → login flow. The ticket threads were produced **through the API**,
so every screen shows state the server actually holds.

Harness: `tools/visual-qa/phase5-support.mjs` (re-runnable; the Phase 1 run kept only
its images and the recipe had to be rewritten from memory).

| File | View | Locale / dir | Viewport |
|---|---|---|---|
| `01-support-fa-desktop.png` | `/support` (KPIs + new ticket + split list) | fa · rtl | 1366×900 |
| `02-support-en-desktop.png` | `/en/support` | en · ltr | 1366×900 |
| `03-support-fa-after-create.png` | after a real create, with the success toast | fa · rtl | 1366×900 |
| `04-support-fa-validation.png` | empty message → localized inline error | fa · rtl | 1366×900 |
| `05-support-fa-thread.png` | `?ticket=…` deep link, both sides, user's-turn badge | fa · rtl | 1366×900 |
| `06-support-fa-after-reply.png` | after the user's reply (server re-render) | fa · rtl | 1366×900 |
| `07-support-fa-closed.png` | closed ticket: reply box hidden, reopen offered | fa · rtl | 1366×900 |
| `08-support-fa-after-reopen.png` | after reopen → back to «در انتظار پشتیبانی» | fa · rtl | 1366×900 |
| `09-support-fa-mobile.png` | `/support` | fa · rtl | 390×844 |
| `10-support-fa-narrow-320.png` | `/support` at the narrowest supported width | fa · rtl | 320×844 |
| `11-support-en-mobile.png` | `/en/support` | en · ltr | 390×844 |
| `12-support-fa-focus.png` | keyboard focus ring on a support control | fa · rtl | 1366×900 |
| `13-support-fa-api-down.png` | backend 503 → localized load-failed state | fa · rtl | 1366×900 |
| `14-support-fa-rate-limited.png` | 429 → localized rate-limit message | fa · rtl | 1366×900 |

## What was checked, and the result

1. **Function, not just pixels** — create, reply, close, reopen and the `?ticket=` deep
   link were driven in the UI against the live API; each round-trip was confirmed by
   reading the rendered page after the server answered.
2. **Closed tickets hide the reply box** — asserted on the DOM (`#sup-reply` count 0),
   which is Legacy's own rule and the one a user is most likely to hit.
3. **Overflow** — `scrollWidth - innerWidth` is **0** at 1366 / 390 / 320 px in both
   locales, on the list and in the thread.
4. **RTL/LTR** — `dir=rtl` + `lang=fa-IR` on the fa routes, `dir=ltr` on `/en/*`; the
   English chrome carries no untranslated Persian (the user's own Persian ticket text
   is untouched — translating a user's words would be the defect).
5. **Latin digits** — every number and date goes through `fmtNumber`/`fmtDateLong`; the
   formatted timestamps deliberately do **not** use `.v-latn-num`, whose
   `direction:ltr` reordered the Jalali date around its comma (measured in the browser
   by character position — this was defect #4 of the phase).
6. **Degraded states** — a 503 renders «خطا در بارگذاری؛ دوباره تلاش کنید.» and a 429
   renders the localized rate-limit sentence; neither leaves the page blank or throws.
7. **Keyboard/a11y** — 14/14 tabbable controls on the support screen show a visible
   focus indicator.
8. **Console** — no page errors, no hydration warnings, no CSP violations (the
   inline-style violation that appeared in the first run is fixed and guarded).
9. **Design preservation** — obsidian/glass/gold unchanged, Estedad loaded, canonical
   classes only (`page-head`, `card`, `kpi`, `btn-primary`, `input`, `badge`, …), no
   new component kit, no layout redesign, no nav change.
