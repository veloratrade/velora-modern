# ADR-004 naive-datetime sampling report

**Purpose:** Execute the ADR-004 §Decision item 4 sampling procedure (read-only)
against the legacy export to determine the site-local interpretation constant
for Legacy's naive MySQL `datetime` values, per ADR-004 Amendment A-3
(owner decision, 2026-11-18, Option C).

**Status:** Sampling executed; no confirming evidence available → **Asia/Tehran
standby adopted** as the documented site-local interpretation constant. This is
a documented approximation that cannot be better than the evidence.

## Sampling procedure executed (§Decision item 4, steps 1–4)

| Step | Procedure | Result |
|------|-----------|--------|
| 1 | Compare `email_notifications.created_at` rows for messages whose exact send time is known from GitHub Actions run logs (UTC); offset = delta. | **Not possible** — no real `email_notifications` export exists in this repository; the fixture at `db/data-step/fixtures/legacy-export.FIXTURE/` is labelled `synthetic: true` and contains invented rows (`.test` TLD emails, non-cryptographic password hashes). No GitHub Actions run logs are available for this export. |
| 2 | Inspect `trades.open_time` distribution against known market session opens (e.g. forex week open Monday 00:00 UTC; XAUUSD session gaps) — consistency check. | **Not possible** — fixture `open_time` values are synthetic and do not correspond to real market sessions (e.g. `1403/06/11 09:00` Jalali text next to `2026-09-02T05:30:00Z`, which are not conservable). |
| 3 | Read host PHP `date_default_timezone_set` / `php.ini` TZ (host evidence). | **Not possible** — no Legacy host access; no `php.ini` or PHP runtime evidence in this repository. |
| 4 | Read `MetaApiService`/sync worker for explicit TZ handling. | **Not possible** — MetaApi ingestion rows in the fixture carry offset-explicit instants; no naive-host-TZ inference is available. |

## Naive-text calendar observation

Fixture naive texts (`open_time` / `close_time`) appear in two shapes:
- ISO-like `YYYY-MM-DD HH:MM` (e.g. `2026-09-04 09:00`), paired with `source_timezone = UTC` and a matching `occurred_*_at_utc`.
- Jalali/SH `YYYY/MM/DD HH:MM` (e.g. `1403/06/11 09:00`), paired with `source_timezone = Asia/Tehran`, but the adjacent `occurred_*_at_utc` does not conservably convert — confirming the fixture is synthetic and that Jalali conversion **cannot be confirmed without real export data + the sampling evidence**.

Per ADR-004, an unconfirmed calendar must not be interpreted. The transform
(`tools/lib/legacyTimeTransform.ts`) therefore returns `null` for Jalali text,
and such rows are quarantined rather than assigned an invented instant.

## Decision recorded

The owner (per the session instruction of 2026-11-18) directs that W6 proceed
without waiting, adopting the **Asia/Tehran standby** (Amendment A-3 step 3):

- Timezone interpretation constant: **`Asia/Tehran`** (+03:30 standard offset).
- Applied only to ISO-calendar naive text paired with a confirmed/standby zone.
- `source_tz_offset` stored verbatim next to each resolved instant (ADR-004 dual-column principle), so the raw evidence stays auditable.
- Unconfirmed calendars/zones → `time_status = 'unresolved'`, row quarantined, never invented.

**Recorded in:** `db/data-step/fixtures/legacy-export.FIXTURE/decisions.json`
(`time.mode = "interpreted_asia_tehran"`, basis cites this report).

## Consequences for the migration transform

- Migration transform code is **no longer blocked** by the ADR-004 sampling
  outstanding-item; the interpretation constant is adopted (standby).
- `db/MIGRATION_MAP.md` updated: naive-datetime interpretation no longer
  `BLOCKED_ON_SAMPLING`; it is `INTERPRETED_ASIA_TEHRAN_STANDBY`.
- The load rehearsal (`tools/load_rehearsal.ts`) wires `interpretNaiveInstant`
  so ISO naive + zone rows resolve to UTC; Jalali/unknown rows stay quarantined.
- `tools/lib/legacyTimeTransform.test.ts` pins the transform behavior.

## What remains owner-gated

- Confirmation that Legacy's historical naive datetimes are in fact Asia/Tehran
  (the standby is an approximation; real export + host PHP-TZ evidence could
  revise it).
- Jalali/SH calendar conversion support, if the sampling on a real export
  confirms Legacy used the Iranian civil calendar.
- Any production cutover still requires the ADR-012 backup gate and a
  real export produced by the transform tool.
