-- ═══════════════════════════════════════════════════════════════════════════
-- VELORA — LOAD GATES (data-step tooling, NOT part of the schema push)
-- ═══════════════════════════════════════════════════════════════════════════
-- Two blocks:
--   A. PRE-LOAD CENSUSES  → run against the LEGACY MySQL (read-only, aggregate only)
--   B. POST-LOAD GATES    → run against the Modern PostgreSQL after a load attempt
--
-- Every statement is read-only and aggregate-only: no raw user row, no journal text,
-- no credential ever leaves the source. Each gate must return a NUMBER that is
-- compared against the expectation in its comment. A gate that is not a number is
-- not a gate.
--
-- Why each one exists: the Phase 5 gap analysis (gap_register.csv). Gate ids match it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║ A. PRE-LOAD CENSUSES — LEGACY MYSQL (read-only)                          ║
-- ╚═════════════════════════════════════════════════════════════════════════╝

-- ── A1 · GAP-03 · the import-breaking value: must be explained before ANY load ──
-- EXPECTATION: every distinct value must be mapped explicitly. 'auto_sync' is REJECTED
-- by the target CHECK (source IN ('manual','metaapi','import')) → needs OD-15.
SELECT source, COUNT(*) AS rows_n FROM trades GROUP BY source ORDER BY rows_n DESC;

-- ── A2 · GAP-04 · locale vocabulary (target CHECK accepts only 'fa','en') ──
-- EXPECTATION: if any value other than fa/en appears, decide: map it, or widen the CHECK.
SELECT locale, COUNT(*) AS rows_n FROM users GROUP BY locale ORDER BY rows_n DESC;

-- ── A3 · GAP-05 · leverage: target is NOT NULL DEFAULT '100' + ^(1:)?[1-9][0-9]{0,7}$ ──
-- EXPECTATION: `empty` and `not_regex_ok` are the rows that need an explicit rule.
SELECT COUNT(*) AS total,
       SUM(leverage IS NULL OR leverage = '')                       AS empty,
       SUM(leverage REGEXP '^(1:)?[1-9][0-9]{0,7}$')                AS regex_ok,
       SUM(leverage IS NOT NULL AND leverage <> '' AND leverage NOT REGEXP '^(1:)?[1-9][0-9]{0,7}$') AS other
FROM trading_accounts;

-- ── A4 · GAP-06 · direction: production column is free text (varchar(4)), NOT an enum ──
-- EXPECTATION: only 'buy'/'sell' may appear. Anything else must be mapped or quarantined.
SELECT direction, COUNT(*) AS rows_n FROM trades GROUP BY direction ORDER BY rows_n DESC;

-- ── A5 · GAP-23 · is lot_size a duplicate of volume, or a second fact? ──
-- EXPECTATION: different_rows > 0 ⇒ lot_size carries information (keep both, decide routing).
SELECT COUNT(*) AS total,
       SUM(lot_size IS NOT NULL AND lot_size =  volume) AS equal_rows,
       SUM(lot_size IS NOT NULL AND lot_size <> volume) AS different_rows,
       SUM(lot_size IS NULL)                            AS null_rows
FROM trades;

-- ── A6 · GAP-15 · symbol × contract_size spread (canonicalisation planning) ──
-- EXPECTATION: slash forms (XAU/USD) must be rewritten to the canonical form; do NOT
-- invent a symbol→contract_size mapping — the pairs below are the only observed truth.
SELECT symbol, contract_size, COUNT(*) AS rows_n
FROM trades GROUP BY symbol, contract_size ORDER BY rows_n DESC;

-- ── A7 · GAP-15/OD-1 · money fraction digits (drives the rounding rule) ──
-- EXPECTATION: max_frac_digits > 2 means a rounding rule is REQUIRED (OD-1/OD-5).
SELECT 'commission' AS col, MAX(CHAR_LENGTH(SUBSTRING_INDEX(CAST(commission AS CHAR), '.', -1))) AS max_frac_digits FROM trades
UNION ALL SELECT 'swap',       MAX(CHAR_LENGTH(SUBSTRING_INDEX(CAST(swap       AS CHAR), '.', -1))) FROM trades
UNION ALL SELECT 'profit_loss',MAX(CHAR_LENGTH(SUBSTRING_INDEX(CAST(profit_loss AS CHAR), '.', -1))) FROM trades;

-- ── A8 · OD-3/OD-4 · how much of the history can actually be resolved to a UTC instant? ──
-- EXPECTATION: unresolved_n is the quarantine volume; 0 ⇒ ADR-004 sampling may be moot.
SELECT COUNT(*) AS total,
       SUM(occurred_open_at_utc IS NULL) AS unresolved_n,
       SUM(source_timezone IS NULL)      AS no_source_tz,
       COUNT(DISTINCT time_status)       AS distinct_status
FROM trades;

-- ── A9 · ADR-003/D-02 · the pre-import duplicate scan (must be 0 before loading users) ──
-- EXPECTATION: 0. A non-zero value means two accounts would collide on the canonical email.
SELECT LOWER(TRIM(email)) AS canonical_email, COUNT(*) AS rows_n
FROM users GROUP BY canonical_email HAVING COUNT(*) > 1;

-- ── A10 · referential integrity of the SOURCE (orphans must be explained, not silently dropped) ──
-- EXPECTATION: all zero. Non-zero orphans need a decision (drop, re-parent, or quarantine).
SELECT 'trades_without_user'    AS check_name, COUNT(*) AS n FROM trades t LEFT JOIN users u    ON u.id = t.user_id    WHERE u.id IS NULL
UNION ALL SELECT 'trades_without_account', COUNT(*) FROM trades t LEFT JOIN trading_accounts a ON a.id = t.account_id WHERE t.account_id IS NOT NULL AND a.id IS NULL
UNION ALL SELECT 'exits_without_trade',    COUNT(*) FROM trade_exits e LEFT JOIN trades t      ON t.id = e.trade_id   WHERE t.id IS NULL
-- the FIVE lines below apply to production only (staging lacks these tables):
-- UNION ALL SELECT 'tag_links_without_trade', COUNT(*) FROM trade_tags tt LEFT JOIN trades t ON t.id = tt.trade_id WHERE t.id IS NULL
-- UNION ALL SELECT 'tag_links_without_tag',   COUNT(*) FROM trade_tags tt LEFT JOIN tags g   ON g.id = tt.tag_id   WHERE g.id IS NULL
-- UNION ALL SELECT 'shots_without_trade',     COUNT(*) FROM trade_screenshots s LEFT JOIN trades t ON t.id = s.trade_id WHERE t.id IS NULL
;

-- ── A11 · OD-10 · size of the decision: what would each source choice lose? ──
-- EXPECTATION: informational. Run once per candidate source; the numbers drive OD-10.
SELECT 'trades' AS tbl, COUNT(*) AS rows_n FROM trades
UNION ALL SELECT 'tags',              COUNT(*) FROM tags               -- production only
UNION ALL SELECT 'trade_tags',        COUNT(*) FROM trade_tags         -- production only
UNION ALL SELECT 'trade_screenshots', COUNT(*) FROM trade_screenshots  -- production only
UNION ALL SELECT 'trade_events',      COUNT(*) FROM trade_events       -- production only
UNION ALL SELECT 'notifications',     COUNT(*) FROM notifications      -- production only
UNION ALL SELECT 'users',             COUNT(*) FROM users
UNION ALL SELECT 'trading_accounts',  COUNT(*) FROM trading_accounts;

-- ── A12 · GAP-12 · how many credentials would users have to re-enter? ──
-- EXPECTATION: informational; this is the size of the credential re-collection problem.
-- NEVER select the ciphertext itself — only whether it exists.
SELECT COUNT(*) AS accounts_total,
       SUM(connection_credentials_encrypted IS NOT NULL) AS with_credentials
FROM trading_accounts;


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║ B. POST-LOAD GATES — MODERN POSTGRESQL (run after a load attempt)        ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
-- Run inside the target database. Schema must be at least 0022.

-- ── B1 · row-count parity ── compare each number with the export manifest ──
SELECT 'users'              AS tbl, COUNT(*) AS loaded FROM users
UNION ALL SELECT 'trading_accounts', COUNT(*) FROM trading_accounts
UNION ALL SELECT 'trades',           COUNT(*) FROM trades
UNION ALL SELECT 'trade_exits',      COUNT(*) FROM trade_exits
UNION ALL SELECT 'tags',             COUNT(*) FROM tags
UNION ALL SELECT 'trade_tags',       COUNT(*) FROM trade_tags
UNION ALL SELECT 'trade_attachments',COUNT(*) FROM trade_attachments
UNION ALL SELECT 'trade_events',     COUNT(*) FROM trade_events
UNION ALL SELECT 'audit_log',        COUNT(*) FROM audit_log;

-- ── B2 · money parity — must equal the source total under the DECLARED rounding rule ──
-- EXPECTATION: exact match against the same aggregate computed on the source.
-- A mismatch of 1 cent per N trades is the rounding rule showing up; a large mismatch is a bug.
SELECT u.id AS user_id,
       COUNT(t.id)                     AS trades_n,
       SUM(t.commission)               AS commission_total,
       SUM(t.swap)                     AS swap_total,
       SUM(t.net_pnl)                  AS net_pnl_total
FROM users u LEFT JOIN trades t ON t.user_id = u.id
GROUP BY u.id ORDER BY u.id LIMIT 20;

-- ── B3 · structural invariants (all MUST be 0) ──
SELECT 'over_allocated_exits'   AS check_name, COUNT(*) AS n FROM trades WHERE allocated_volume > volume
UNION ALL SELECT 'direction_out_of_vocabulary', COUNT(*) FROM trades WHERE direction NOT IN ('buy','sell')
UNION ALL SELECT 'negative_volume',             COUNT(*) FROM trades WHERE volume <= 0
UNION ALL SELECT 'negative_starting_balance',   COUNT(*) FROM trading_accounts WHERE starting_balance < 0
UNION ALL SELECT 'negative_consecutive_errors', COUNT(*) FROM trading_accounts WHERE consecutive_errors < 0
UNION ALL SELECT 'verified_webhook_without_time', COUNT(*) FROM webhook_events WHERE signature_verified AND signature_verified_at IS NULL;

-- ── B4 · canonical email uniqueness (must return no rows) ──
SELECT LOWER(email) AS canonical_email, COUNT(*) FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1;

-- ── B5 · ownership: no cross-owner row may exist (must return no rows) ──
SELECT 'trade_tags' AS tbl, COUNT(*) FROM trade_tags tt JOIN trades t ON t.id = tt.trade_id WHERE tt.user_id <> t.user_id
UNION ALL SELECT 'trade_attachments', COUNT(*) FROM trade_attachments a JOIN trades t ON t.id = a.trade_id WHERE a.user_id <> t.user_id
UNION ALL SELECT 'account_group_members', COUNT(*) FROM account_group_members m JOIN trading_accounts a ON a.id = m.account_id WHERE m.user_id <> a.user_id
UNION ALL SELECT 'trades', COUNT(*) FROM trades t JOIN trading_accounts a ON a.id = t.account_id WHERE t.user_id <> a.user_id;

-- ── B6 · time honesty — no row may claim a UTC instant it does not have ──
-- EXPECTATION: quarantined rows = the source's unresolved rows (A8). Nothing silently promoted.
SELECT time_status, COUNT(*) AS rows_n,
       SUM(occurred_open_at_utc IS NULL) AS open_utc_null,
       SUM(occurred_at IS NULL)          AS occurred_at_null,
       SUM(quarantined)                  AS quarantined_n
FROM trades GROUP BY time_status;

-- ── B7 · nothing loaded with an invented money scale ──
-- EXPECTATION: 0 rows whose stored money exceeds 2 decimal places (the target type forbids
-- it, so a non-zero result is impossible — the gate exists to prove it stayed that way).
SELECT COUNT(*) AS money_rows_beyond_2dp FROM (
  SELECT commission AS v FROM trades UNION ALL SELECT swap FROM trades UNION ALL SELECT net_pnl FROM trades
) x WHERE v IS NOT NULL AND v <> ROUND(v, 2);

-- ── B8 · rebuild-ability of the derived tables (ADR: derived data is never copied) ──
-- EXPECTATION: the aggregate tables must be EMPTY after a raw load, then filled by a rebuild job.
SELECT 'user_analytics_daily' AS tbl, COUNT(*) AS rows_n FROM user_analytics_daily
UNION ALL SELECT 'account_performance_summary', COUNT(*) FROM account_performance_summary;
