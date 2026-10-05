# Phase 6 — admin console · visual & responsive QA evidence (2026-10-05)

Screenshots from a real browser (Playwright/Chromium 153, headless shell) against the
**production build** (`next build` + `next start`, `VELORA_API_ORIGIN` → the live API on
PostgreSQL 17.11, migration head `0027_admin_console.sql`), signed in with accounts created
through the public register → verify → login flow and promoted with `psql` the way an
operator would in this environment. Every row, badge and counter on these screens is state
the server actually holds — the tickets, suspensions, session revocations and audit entries
were produced **through the API during this run**.

Harness: `tools/visual-qa/phase6-admin.mjs` (re-runnable; recipe in its header comment).
Result: **62/62 checks passed**, 20 screenshots, 0 unexpected console/page errors.

| File | View | Locale / dir | Viewport |
|---|---|---|---|
| `01-admin-fa-overview.png` | `/admin` overview tab: 6 KPIs + users/trading/telegram/support breakdowns | fa · rtl | 1440×960 |
| `02-admin-fa-users-filtered.png` | users 360 tab, search narrowed to one account | fa · rtl | 1440×960 |
| `03-admin-fa-user360.png` | the 360 record: identity, live sessions, honest empty states | fa · rtl | 1440×960 |
| `04-admin-fa-user-suspended.png` | after a real suspension, with the toast and the «مسدود» badge | fa · rtl | 1440×960 |
| `05-admin-fa-user-actions.png` | after activate / verify-e-mail / revoke-sessions | fa · rtl | 1440×960 |
| `06-admin-fa-self-denied.png` | the guard an operator hits: self-suspension refused in localized copy | fa · rtl | 1440×960 |
| `07-admin-fa-support-thread.png` | support queue → thread → operator reply | fa · rtl | 1440×960 |
| `08-admin-fa-support-closed.png` | closed ticket: archive + reopen offered, close withdrawn | fa · rtl | 1440×960 |
| `09-admin-fa-audit.png` | audit trail filtered to `USER_STATUS_CHANGED`, before/after state visible | fa · rtl | 1440×960 |
| `10-admin-fa-security.png` | security feeds as `super_admin` (holds `audit.view_sensitive`) | fa · rtl | 1440×960 |
| `11-admin-fa-security-limited.png` | the SAME tab as `admin`: network fields absent, and labelled as hidden | fa · rtl | 1440×960 |
| `12-admin-fa-system.png` | health: nine attested components, unbuilt ones «کاربرد ندارد» | fa · rtl | 1440×960 |
| `13-admin-fa-analytics.png` | analytics with the 30-day preset selected | fa · rtl | 1440×960 |
| `14-admin-en-overview.png` | `/en/admin` — LTR, chrome fully translated | en · ltr | 1440×960 |
| `15-admin-fa-forbidden.png` | a signed-in non-admin: redirected away from the console | fa · rtl | 1440×960 |
| `16-admin-fa-mobile-390.png` | users tab | fa · rtl | 390×844 |
| `17-admin-fa-narrow-320.png` | users tab at the narrowest supported width | fa · rtl | 320×844 |
| `18-admin-en-mobile-390.png` | users tab | en · ltr | 390×844 |
| `19-admin-fa-focus.png` | keyboard focus ring on the tab strip | fa · rtl | 1440×960 |
| `20-admin-fa-api-down.png` | backend 503 → localized load-failed state, no fabricated numbers | fa · rtl | 1440×960 |

## What was checked, and the result

1. **Function, not just pixels.** Suspend → activate, verify e-mail, revoke sessions, an
   operator reply, close and archive were all driven in the UI against the live API, and each
   round trip was confirmed by reading the re-rendered page (toast text + badge + list state).
2. **Permission-driven tabs, twice.** A `super_admin` and an `admin` both see the seven panels
   they are entitled to; the `admin` — who holds `audit.view` but **not** `audit.view_sensitive` —
   is told the network fields are hidden, and **no IP address is rendered to it** (asserted by
   scanning the table text for an IPv4 shape). The console says «hidden from you», never blank.
3. **A non-admin never receives the shell.** `/admin` as a signed-in `user` is refused at the
   proxy (302 → `/dashboard`, `no-store`), so no console chrome and no user data is rendered.
   The in-page refusal copy is exercised separately by narrowing the reported permission set.
4. **Honesty about what does not exist.** The health panel attests nine components; the ones
   Modern has not built (worker, e-mail, AI provider, MetaAPI, n8n relay) read
   «کاربرد ندارد» with their phase reason instead of a green check, and the migration head
   shown is `0027` — the one this phase shipped. Devices/trades panels render an empty state,
   never a fabricated zero.
5. **Localization.** fa routes are `dir=rtl` with Persian chrome; `/en/admin` is `dir=ltr` and
   its chrome (title, subtitle, KPI labels, card headings, tab labels, buttons) contains **no
   Persian**. Numerals render Latin in both locales, per the product-wide Legacy rule.
6. **Overflow.** `scrollWidth - innerWidth` is **0** at 1440 / 390 / 320 px in both locales on
   every tab (see the defects below — this was not true on the first run).
7. **Keyboard.** Every tab shows a focus indicator and `Enter` activates it.
8. **Failure states.** A 503 on `/api/v1/admin/**` renders the localized load-failed copy and
   no `NaN`/`undefined`; the self-action guard renders «مجوز این اقدام را ندارید.» rather than a
   stack trace.

## Defects this run found, and what was done (fixed before the phase was called done)

| # | Defect (observed in the browser) | Fix |
|---|---|---|
| 1 | **Horizontal overflow on mobile**: 123 px at 390, 193 px at 320, 515 px on the audit tab — wide tables pushed the document wider than the viewport | every table is now wrapped in the canonical `.overflow-auto` box (the pattern `/trades` already uses), so a table scrolls inside its card instead of widening the page. Overflow is 0 at 1440/390/320 in both locales |
| 2 | **Raw enums leaked into the Persian console**: the support queue printed `open`/`closed` and the thread printed `admin`/`user`, while the filter right above them spoke Persian | `TICKET_STATUS_LABEL` + `SENDER_LABEL` maps reuse the support chunk's own words (`pages.support.status.*`, `pages.support.role.support_agent`) and `admin.role.user`; an unmapped value still renders raw rather than blank |
| 3 | **The thread offered transitions the service refuses** (close on a closed ticket = 409, archive on an open ticket = 422, reply to an archived ticket = 422), and closing **dismissed the thread**, so `archive` — legal only from `closed` — was unreachable without hunting the ticket down again | actions are now status-driven (`close` only from open/pending, `reopen` from closed/archived, `archive` from closed, reply box hidden when archived), and close/archive re-open the record so the operator sees the new state and the next legal action |

Three further failures on the first run were **harness expectations that were wrong, not product
defects**, and were corrected in the harness (the product behaviour was the stronger one):

* tab labels were compared against the raw catalog string «کاربر ۳۶۰ درجه», but the product rule
  (`i18n/latinDigits.ts`, Legacy `velora-latin-digits.js`) renders every numeral as Latin — the
  expectation now normalizes the same way;
* the audit check counted rows instead of naming actions (a no-op verify-e-mail correctly writes
  **no** row), so it now asserts `USER_STATUS_CHANGED` + `USER_SESSIONS_REVOKED` are present and
  that the no-op wrote nothing;
* a signed-in non-admin is **redirected** away from `/admin` by the proxy rather than shown the
  in-page refusal, so the check asserts the redirect, and a second check exercises the in-page
  copy by narrowing the reported permission set.

## Reproduce

```bash
# 1. PostgreSQL 17 cluster + migrations to head
export PATH=/usr/lib/postgresql/17/bin:$PATH
initdb -D /tmp/pgdata -U postgres --auth=trust -E UTF8
pg_ctl -D /tmp/pgdata -o "-p 54329 -k /tmp -c listen_addresses=127.0.0.1" -l /tmp/pg.log start
createdb -h 127.0.0.1 -p 54329 -U postgres velora_phase1
DATABASE_URL=postgres://postgres@127.0.0.1:54329/velora_phase1 npx tsx db/migrate.ts

# 2. API + production web build
APP_ENV=development APP_ORIGIN=http://127.0.0.1:8080 PERSISTENCE=postgres \
  DATABASE_URL=postgres://postgres@127.0.0.1:54329/velora_phase1 \
  JWT_SECRET=<32+ chars> npx tsx apps/api/src/server-main.ts
cd apps/web && VELORA_API_ORIGIN=http://127.0.0.1:8080 npm run build && npm run start

# 3. the run itself
PSQL_BIN=/usr/lib/postgresql/17/bin/psql node tools/visual-qa/phase6-admin.mjs
```

Machine-readable result: `visual-qa-results.json` (62 findings, 21 shots, the accounts and the
seeded ticket id used). The three console errors it records are the deliberate 503/403
interceptions; the "no unexpected console/page errors" check filters exactly those and passed.
