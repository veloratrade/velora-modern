# Phase 5 — Support · status report

**Date:** 2026-10-04 · **Branch:** `feat/telegram-journal-client` · **Phase start SHA:** `1f6c4bb`
**Scope (mission §9):** support — "a real ticket capability, not a shell."

**Headline:** the support capability exists end to end. `/support` is no longer a
PLANNED shell: a ticket opened in the browser reaches PostgreSQL, is answered through
the admin surface, notifies the right side, closes, reopens, and every one of those
rules is enforced by the DATABASE and by the ROUTE, with the counters derived from
the event rather than trusted from the client. Two defects that Legacy lived with are
deliberately not reproduced, and three defects in this delivery were found by the QA
loop and fixed before the commit.

---

## 1. What changed

| Area | Change | Capability |
|---|---|---|
| Migration | `db/migrations/0026_support_tickets.sql` — 2 tables, 3 functions, 4 indexes, 5 CHECKs, idempotent | SUP-01, SUP-02 |
| Service | `apps/api/src/support/supportService.ts` — types, validation, lifecycle, `PgSupportStore`, `MemorySupportStore` | SUP-01, SUP-02 |
| Routes | `apps/api/src/support/supportRoutes.ts` — the user surface + `/admin/communications/tickets` | SUP-01, SUP-02 |
| Wiring | kernel slot + `support:write` throttle (20/300); `support.tickets.view`/`manage` on admin + super_admin; dispatcher + boot | SEC-02, SEC-01 |
| Web | `apps/web/src/app/(app)/support/page.tsx` (was a PLANNED shell) + `fa/en support.json` + `catalog.ts` + resources | SUP-01 |
| Tests | service 15/15 · routes 10/10 · real-PG 14/14 · i18n guard 7/7 · throttle guard extended | — |
| QA | `tools/visual-qa/phase5-support.mjs` + 14 screenshots + `visual-qa-results.json` (29/29) | — |

## 2. Capability map (Legacy → Modern, with the rule that moved)

| Legacy | Modern | Rule that had to survive |
|---|---|---|
| `support_conversations` + `support_messages` | `support_tickets` + `support_messages` | two axes: `status` (open/pending/closed/archived) and `waiting_for` (admin/user/none) |
| create → `open`/`admin` | same | the opening message is unread FOR SUPPORT |
| admin text reply → `pending`/`user` | same | and stamps `first_reply_at` **once** (idempotency sentinel for the "you have an answer" mail) |
| user reply → `open`/`admin` | same | and clears the writer's own unread badge |
| close → `closed`/`none`; user reopen → `open`/`admin`; admin reopen → `pending`/`user` | same | reopen destination depends on WHO reopens |
| archive only from `closed` | same | and an archived ticket takes no replies |
| reply into a closed ticket | 422 `SUPPORT_TICKET_CLOSED` | with **no message row written** (`require_live`) |
| `P_COMM_VIEW` / `P_COMM_REPLY` on admin **and** super_admin | `support.tickets.view` / `support.tickets.manage` | same two roles, checked at the route, fail-closed |
| internal note = super_admin only | same, but an ADMIN asking is **403** | see §3(b) |
| subject ≤ 200, body ≤ 5000 | same (service + DB CHECK + client `maxLength`) | measured in code points, so a Persian subject is 200 characters |

## 3. Two Legacy defects NOT reproduced

**(a) An internal note moved the ticket.** `SupportRepository::addMessage` (v1.8)
runs the admin UPDATE for every admin message; only `message_type` distinguishes a
note. So a note flipped `status` to `pending`, set `waiting_for = 'user'`, cleared the
admin's unread count, **incremented the user's**, stamped `first_reply_at`, and moved
`last_message_at` — telling the customer "we replied", raising a badge for a message
they cannot open, and reordering their ticket list, all from an event they are not
allowed to see. Modern derives state from the message's TYPE: a note is stored
(admin-visible), and moves **nothing**. Pinned in the service battery AND in the
real-PG battery (status, both axes, both counters, the sentinel and the ordering key).

**(b) The internal-note privilege failed OPEN.** The controller computed
`$internal = !empty($body['internal']) && $me['role'] === Role::SUPER_ADMIN`, so an
ADMIN who asked for an internal note got a **user-visible reply** carrying the note's
text. Modern keeps the privilege (super_admin only) and makes the denial loud: 403,
nothing written.

## 4. Defects this delivery introduced, and how they were caught

Every one of these was found by a gate that exists BECAUSE of the mission's loop —
none were visible to `tsc` or to the first green test run.

1. **`DELETE FROM users` FAILED (found by the real-PG battery).** `sender_user_id` is
   `ON DELETE SET NULL` (Legacy's own FK action, kept on purpose so a deleted admin's
   replies survive in other people's tickets), and PostgreSQL does not order RI
   triggers — so `SET NULL` could fire before the ticket cascade and violate a strict
   "non-system messages always have an author" CHECK (reproduced: 23514). The
   constraint now enforces the half that carries meaning and cannot be broken by a
   deletion (a system note is never attributed); the authorless residue of a deleted
   author is allowed, documented, and never written by the application.
2. **Inline styles blocked by the production CSP (found in the browser, not the
   build).** `style-src 'self' 'nonce-…'` refuses a style ATTRIBUTE, so the thread's
   grid, colours and KPI emphasis silently degraded while `next build` stayed green.
   Removed; a source guard now forbids `style={{` on the page, matching the Phase 1
   polish rule for the account surface.
3. **Hydration mismatch on `/en/support` (React #418).** The page read
   `window.location.pathname` during render, so the SERVER painted Persian and the
   CLIENT repainted English — a wrong-language flash, and a real hydration error on
   every English load. The locale now comes from `usePathname()`, which is what the
   shell (`AppShell`/`Sidebar`/`TopBar`) already does.
4. **A formatted Jalali date scrambled by `.v-latn-num`.** The class carries
   `direction: ltr` — correct for a raw ISO stamp (its original purpose) and wrong for
   a FORMATTED date: measured by character position in the browser, the Persian
   date+time read out of order around their comma. Formatted timestamps now use
   `.ts-mixed` (Latin digits, document direction). KPI label/value also became block
   elements like every other KPI row, instead of crowding onto one line.

## 5. Verification (all gates at this HEAD)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (5 projects) |
| `npm test` | **1064 + 63 = 1127 pass · 0 fail · 0 skip · EXIT=0** |
| `tools/run-pg-batteries.sh` | **29 files / 58 runs / 0 failures** |
| support service battery | 15/15 (lifecycle, ownership 404s, validation, ordering, counters, race → 409) |
| support route battery (real HTTP + real kernel) | 10/10 (anonymous 401 on 8 paths, 403 for a plain user, identity from `claims.sub`, forged `status` ignored, internal-note privilege, 405s, throttle 429) |
| support real-PG battery | 14/14 (idempotent migration, derivation, `require_live` writes nothing, CAS, two concurrent replies, constraints, deletion integrity, adapter SQL) |
| throttle guard | 18/18 (extended: the two support write rules + read near-misses) |
| web build | 38 routes (`/support`, `/en/support` real) |
| `tools/secret-scan.sh` | PASS (0 findings) |
| **browser QA** | **29/29**, production build + live API: fa/en, 1366/390/320 px, RTL/LTR, create/reply/close/reopen round-trips, hidden reply box when closed, `?ticket=` deep link, 14/14 focus indicators, 503 + 429 states |

**Migration state:** `0026_support_tickets.sql` applied to a real PostgreSQL 17.11 and
re-applied (idempotent); `schema_migrations` head is `0026`. The battery proves the
safety property that matters for the future cutover: re-running the file leaves the
schema and the data intact.

**Screenshots:** `docs/audits/phase5-ui/` (14 files) with `visual-qa-results.json`
(pass/fail per check) — including the two degraded states a user can meet.

## 6. What is NOT in this phase, and why

* **`/admin/communications/tickets/{id}/translate` and `/copilot`** — Legacy's two AI
  routes over a ticket. They call a provider; phase 7 owns the AI capability (consent
  gate, provider abstraction, fail-closed errors). A stub here would fabricate
  output, which the mission forbids outright.
* **The admin CONSOLE page** — the admin API for tickets is wired and tested (queue,
  filters, counters, reply, status), but the screen that shows it is phase 6, with
  the rest of the admin capability and its capability-mapped dependency order.
* **`support_message_translations`** — deliberately not created: a table only an
  unbuilt feature writes is speculative infrastructure, and phase 7 owns the storage
  decision for translations.

**Nothing was removed.** No route, table, string or behaviour was taken away. The only
cross-cutting changes are additive: one kernel slot, one throttle key, two RBAC
permissions, one catalog chunk, four CSS utilities.

**Push status:** the phase-5 commits are pushed to `feat/telegram-journal-client` in
the same delivery; the verified remote tip is recorded in the push-verification
commit that follows this report (`git fetch` + `git rev-parse`), never assumed.
