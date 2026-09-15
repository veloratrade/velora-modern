# ADR-004 — Time Model

## Status

Accepted — owner decision D-11 (2026-08-29): timestamptz/UTC-only standard, dual-column trading timestamps (`occurred_at` + `source_time_naive` + `source_tz_offset`), and the sampling procedure approved. **Legacy datetime interpretation remains evidence-gated** (sampling + owner confirmation) and is NOT part of this approval; migration transform code stays blocked until then.

## Context

All MySQL datetimes in the PHP system are **naive** (no offset). PostgreSQL with
`timestamptz` requires knowing what the naive values mean. A wrong guess
corrupts trade chronology, analytics, and reporting.

## Verified Evidence

- DDL (VERIFIED): `open_time datetime NOT NULL`, `close_time datetime`,
  `window_start datetime` (rate_limits), and naive datetimes throughout the 20-table schema.
- Workers (VERIFIED headers): cron-invoked PHP workers (`metaapi_sync_worker`,
  `ai_retention_cleanup`) — PHP `date()`/`now()` semantics depend on host PHP TZ
  (configured where? UNVERIFIED).
- Host context (VERIFIED docs): cPanel shared host; no evidence found of a documented
  application timezone standard — this is the root of the open question.

## Decision

1. **Modern standard:** PostgreSQL `timestamptz`, stored UTC-only; session TZ `UTC`;
   API serialization ISO-8601 with explicit offset (`Z`); frontend renders in the
   user's locale timezone (browser `Intl`), day-boundaries for journals computed in
   the user's TZ, not the server's.
2. **Trading timestamps:** broker/MetaApi-reported times are stored as reported,
   plus captured source/offset metadata where the provider supplies it
   (proposal: `occurred_at timestamptz` + `source_time_naive` + `source_tz_offset`
   for sync-sourced trades). Manual trades: user-local input converted via the
   user's profile TZ (profile TZ field required — new capability, note in registry).
3. **Migration interpretation is BLOCKED until the sampling procedure below is
   executed and the owner confirms the result. No transformation code may be
   written before that.**
4. **Sampling procedure (read-only, on staging first):**
   1. Compare `email_notifications.created_at` rows for messages whose exact send
      time is known from GitHub Actions run logs (UTC) — offset = delta.
   2. Inspect `trades.open_time` distribution against known market session opens
      (e.g., forex week open Monday 00:00 UTC; XAUUSD session gaps) — consistency check.
   3. Read host PHP `date_default_timezone_set` / `php.ini` TZ (host evidence).
   4. Read `MetaApiService`/sync worker for explicit TZ handling.
   5. Documented conclusion + owner sign-off → single interpretation constant for the transform.
5. **Clock discipline:** all servers NTP-synced (hosting checklist); DB `now()` UTC.

## Alternatives Considered

- Keeping naive timestamps in PG (`timestamp`): rejected — every consumer must
  guess; DST and multi-TZ users make this a permanent defect generator.
- Storing user-local times: rejected — no single truth; breaks ordering.

## Consequences

### Positive
- Unambiguous chronology; correct multi-timezone users; clean reporting windows.
- Trading timestamps keep broker fidelity via dual columns.

### Negative
- Migration transform requires the verified interpretation (blocked item).
- Existing rows without reliable offset metadata adopt the single interpreted TZ
  (documented approximation — cannot be better than the evidence).

## Security Impact

Audit-log timestamps must be monotonic and unambiguous (forensics). JWT `exp`
checks (VERIFIED in PHP) already use server clock — modern keeps UTC everywhere.

### Amendment A-2 — naive `brokerTime` storage (2026-09-16, implemented)

**Status: IMPLEMENTED** in migration `0013_metaapi_import_path.sql` together
with the MetaAPI import path (AGENTS.md rule 11 — decision and code land in the
same change).

**Decision.** A provider deal carries two distinct timestamp fields, and they
are stored in two distinct columns on `sync_fills`:

| Provider field | Column | Meaning |
| --- | --- | --- |
| `time` (offset-explicit, e.g. `…Z` / `±HH:MM`) | `raw_time_text` | verbatim copy of the ABSOLUTE instant text; may resolve `occurred_at_utc` |
| `brokerTime` (naive wall clock) | `broker_time_text` | verbatim EVIDENCE only; never an instant |

**`broker_time_text` is never parsed.** It is stored exactly as received and is
never converted, never used to derive `occurred_at_utc`, and never allowed to
set `time_status = 'resolved_utc'`. No timezone is assigned to it and no IANA
zone is inferred — not from the broker country, the broker/server location, the
account location, the host machine's timezone, a default application timezone,
or any other heuristic. That list is exhaustive and binding.

**Why a second column rather than overloading `raw_time_text`.** The provider
returns both fields on the same deal, so one column cannot hold both without
losing one of them; and `raw_time_text` already has a defined D-6 meaning (the
offset-explicit text). Overloading it would silently change the meaning of
existing rows. `raw_time_text` is therefore unchanged and un-renamed.

**Unresolved instants are excluded from time-ordered analytics.** When `time`
carries no offset, `occurred_at_utc` stays NULL, `time_status` is
`'unresolved'`, and the fill is persisted with `processing_state='skipped'` and
`skip_reason='UNRESOLVED_TIME'`. It never becomes a trade, so it cannot enter
P/L or time-series analytics — but the raw evidence is preserved, so the
provider's actual response remains auditable and can be reprocessed if the
provider later supplies an offset.

**Deliberately no CHECK constraint references `broker_time_text`.** The
existing `sync_fills_time_consistency` CHECK ties `time_status` to
`occurred_at_utc` only. Extending it to `broker_time_text` would couple
EVIDENCE to RESOLUTION and imply the naive value carries instant information —
exactly the inference this amendment forbids.

**Scope.** This amendment adds storage and semantics for a previously discarded
provider field. It does not alter the UTC-everywhere rule, the
`timestamptz` standard, or any other part of ADR-004. The Open Question below
about legacy naive columns is **unaffected and still open** — it concerns
historical PHP data, not MetaAPI ingestion.

**Evidence.** `db/tests/metaapiSync.pg.test.ts` (offset-explicit resolves;
naive yields NULL UTC + `unresolved` + preserved `broker_time_text`; no trade
created) and `db/tests/syncSubstrate.pg.test.ts` (both columns exist and hold
different values on one row), executed against real PostgreSQL 17.10.

## Migration Impact

Direct: every naive column interprets via the sampling result; documented in
`db/MIGRATION_MAP.md`; validation includes ordering invariants (trades close_time ≥ open_time).

## Testing / Verification Requirements

- Sampling report (artifact in `db/` during Phase 3 rehearsal).
- Post-load invariant checks: chronological sanity per user/account; DST-boundary spot checks.

## Open Questions

1. **What TZ do existing naive datetimes represent? — OWNER-verified sampling required (blocks migration transform code).**
2. Host PHP TZ configuration (evidence step 3).
3. MetaApi timestamp semantics in current sync code (evidence step 4).

## Phase

Phase 0 decision; sampling executes in migration rehearsal (Phase 3+);
schema standard applies from Phase 1.
