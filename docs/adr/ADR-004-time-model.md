# ADR-004 — Time Model

## Status

Proposed — **contains an unresolved blocking question for migration.**

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
