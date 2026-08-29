# VELORA-MODERN — Migration Strategy (MySQL → PostgreSQL) — Phase 0 Spec

Principle: **rehearsed, validated, reversible.** No production cutover without a
full-dress rehearsal inside the downtime budget (Phase 4).

## 1. Data mapping

| Concern | MySQL (VERIFIED) | PostgreSQL decision |
|---|---|---|
| Type mapping | bigint unsigned, decimal(p,s), enum, datetime, tinyint(1) | bigint + identity, numeric(20,8)/(20,2) per ADR-001, check constraints, timestamptz per ADR-004, boolean |
| Precision | inconsistent scales (15,5 / 15,2 / 18,2 / 10,4) | ADR-001 matrix; transform keeps strings end-to-end (no JS float) |
| Email | utf8mb4_unicode_ci (case-insensitive) | ADR-003: canonical lowercase + plain unique |
| Datetime interpretation | naive | **BLOCKED on ADR-004 sampling** — no transform code until verified + owner-confirmed |
| Sequences | AUTO_INCREMENT | identity; `setval` fixup after ID-preserving import |
| Enums | e.g. `OPEN/CLOSED` | check constraints + documented value domains |
| FKs / indexes | 20 core + 10 AI tables | recreated explicitly; live index set on MySQL re-inspected (trades keys UNVERIFIED in DDL) |
| External IDs | external_deal_id, ticket_id | ADR-002 idempotency constraints |

## 2. Authentication data

- `users.password_hash` imported **unchanged** (`$2y$` bcrypt, cost 12 — VERIFIED).
- Phase 1 gate: Node bcrypt `$2y$` compatibility proof (ADR-005).
- `user_sessions` imported **empty** (cutover = planned logout).
- Verification/reset tokens: only unexpired, recent rows considered; simplest: expire all (users re-request).

## 3. Screenshots — rows AND bytes

**Explicit requirement:** screenshot migration is NOT database-only.
`trade_screenshots` rows + binary objects must both migrate to the object-storage
port, with byte-count/checksum verification per object and referential check
(row ↔ object 1:1). Volume measured during rehearsal (informs hosting disk).

## 4. Historical data scope

Migrate: users, trading_accounts, trades + trade_events/exits/features/tags/screenshots,
user_achievements, user_analytics_daily, email_notifications history (where retention-relevant),
webhook_events archive, AI tables **except retention-expired rows** (honor retention policy).

## 5. Ephemeral state — DO NOT MIGRATE

- caches (any)
- `rate_limits` buckets
- expired verification/reset tokens
- retention-expired AI data
- transient worker/queue state (sync job leases etc.)

## 6. Validation gates (every rehearsal + cutover)

1. Row counts per table (source vs target, with ephemeral exclusions accounted).
2. Per-table checksums where appropriate (stable ordering + hash).
3. FK orphan checks = 0.
4. Unique constraint checks (esp. canonical email, external deal IDs).
5. **Login smoke test** with migrated real hash vectors.
6. **PnL golden recomputation** over migrated trades — modern domain engine must
   reproduce stored values (ADR-001 parity).
7. Screenshot byte/object verification (count + checksum sample + 1:1 referential).
8. Timestamp sanity invariants (close_time ≥ open_time; session-open alignment per ADR-004 sampling).

## 7. Process

- Repeatable pipeline (scripts in `db/`, Phase 1 skeleton, read-only against MySQL source).
- Staged/dry-run: full rehearsal on sanitized copy → timing report → owner review.
- Cutover procedure (Phase 4): freeze PHP writes → final delta export → validate →
  switch (staged: content first, trading last) → PHP read-only rollback window →
  decommission + credential rotation.
- Rollback strategy: within window = repoint to PHP (read-only stance documented);
  after window = restore from backup (restore drill is a standing gate).

## 8. What is rebuilt instead of migrated

Rate limiting state, feature-flag hot state, caches, projections (dashboard
aggregates rebuilt from events/trades), webhook projections (replay from raw archive).
