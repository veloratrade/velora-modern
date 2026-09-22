// Async analytics recompute — decision logic against a scripted query port.
//
// The SQL TEXT is not executed here (db/tests/analyticsRecompute.pg.test.ts does
// that against real PostgreSQL). What this battery pins down is everything that
// could be wrong while the SQL is right: the day/basis grouping, the exact
// decimal values written, the window and size bounds, and determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ACCOUNT_TRADES,
  MAX_WINDOW_DAYS,
  RecomputeBoundError,
  isUsableTimeZone,
  recomputeUserAnalytics,
  validateWindow,
  type AggregateQuery,
} from "./dailyRecompute.js";

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Scripted query port.
 *
 * It answers by SQL SHAPE (the module always issues the same statements in the
 * same order), and records every write so the test can assert on exact values.
 */
function fakeQuery(script: {
  /**
   * Rows as the basis query returns them: the RAW stored value plus whether the
   * account declared it. Normalization (usable vs degraded) happens in the
   * module, not in the port — that is the property under test.
   */
  bases: Array<{ raw_tz: string; declared: boolean }>;
  /** Keyed by `<raw values joined by +>|<u when undeclared rows are included>`. */
  daily: Record<string, Array<{ day: string; net_pnl: string | null; r_multiple: string | null }>>;
  accounts: string[];
  accountTrades: Record<string, Array<{ net_pnl: string | null; r_multiple: string | null; currency: string | null }>>;
  pruned?: number;
}): { q: AggregateQuery; writes: Recorded[] } {
  const writes: Recorded[] = [];
  const q: AggregateQuery = async (sql, params = []) => {
    if (sql.includes("FROM trading_accounts a") && sql.includes("AS declared")) return script.bases;
    if (sql.includes("to_char(t.occurred_at AT TIME ZONE")) {
      const declaredRaws = Array.isArray(params[4]) ? (params[4] as string[]) : [];
      const includeUndeclared = params[5] === true;
      const key = `${declaredRaws.join("+")}${includeUndeclared ? "|u" : ""}`;
      return script.daily[key] ?? [];
    }
    if (sql.includes("DELETE FROM user_analytics_daily")) {
      return Array.from({ length: script.pruned ?? 0 }, (_, i) => ({ day: `pruned-${i}` }));
    }
    if (sql.includes("SELECT DISTINCT t.account_id::text")) {
      return script.accounts.map((account_id) => ({ account_id }));
    }
    if (sql.includes("DELETE FROM account_performance_summary s")) return [];
    if (sql.includes("FROM trades t") && sql.includes("account_id = $2::bigint")) {
      return script.accountTrades[String(params[1])] ?? [];
    }
    if (sql.includes("INSERT INTO user_analytics_daily") || sql.includes("INSERT INTO account_performance_summary")) {
      writes.push({ sql, params });
      return [];
    }
    throw new Error(`unexpected statement in the scripted port: ${sql.slice(0, 80)}`);
  };
  return { q, writes };
}

const WINDOW = { userId: "1", from: "2026-09-01T00:00:00.000Z", to: "2026-09-22T00:00:00.000Z" };

/**
 * Positional INSERT parameters read by NAME.
 *
 * The columns are read from the statement itself (`INSERT INTO t (a, b, …)`), so
 * a future column reordering cannot silently turn an assertion about "net_pnl"
 * into an assertion about "win_rate".
 */
function paramsNamed(write: Recorded): Record<string, unknown> {
  const columns = /INSERT INTO \w+\s*\(([^)]*)\)/s.exec(write.sql)?.[1];
  assert.ok(columns, "the statement must name its columns");
  // Anchor on ON CONFLICT so parentheses INSIDE the values list (`now()`) cannot
  // truncate the section being parsed.
  const values = /VALUES\s*\(([\s\S]*)\)\s*ON CONFLICT/.exec(write.sql)?.[1];
  assert.ok(values, "the statement must have a VALUES list followed by ON CONFLICT");

  const names = columns.split(",").map((c) => c.trim());
  const slots = values.split(",").map((v) => v.trim());
  assert.equal(slots.length, names.length, "one value per column");

  const out: Record<string, unknown> = {};
  slots.forEach((slot, index) => {
    const placeholder = /^\$(\d+)/.exec(slot);
    if (placeholder !== null) {
      out[names[index] as string] = write.params[Number(placeholder[1]) - 1];
      return;
    }
    // Server-side literals carry no parameter (a timestamp default, per the
    // migrations' `now()` conventions).
    assert.match(slot, /now\(\)/i);
  });
  // Every parameter must have been consumed by exactly one placeholder: a
  // mismatch means the column list and the parameter list have drifted apart.
  const used = new Set(slots.map((s2) => /^\$(\d+)/.exec(s2)?.[1]).filter((v) => v !== undefined));
  assert.equal(used.size, write.params.length);
  return out;
}

function dailyRow(write: Recorded): Record<string, unknown> {
  return paramsNamed(write);
}

test("one day's figures are exact, at contract scales", async () => {
  const { q, writes } = fakeQuery({
    bases: [{ raw_tz: "UTC", declared: false }],
    daily: {
      "|u": [
        { day: "2026-09-21", net_pnl: "10.00", r_multiple: "2.00000000" },
        { day: "2026-09-21", net_pnl: "-5.00", r_multiple: null },
        { day: "2026-09-21", net_pnl: "0.00", r_multiple: null },
      ],
    },
    accounts: [],
    accountTrades: {},
  });

  const result = await recomputeUserAnalytics(q, WINDOW);
  assert.deepEqual(result, { dailyRows: 1, removedDailyRows: 0, accountRows: 0 });

  const daily = writes.find((w) => w.sql.includes("INSERT INTO user_analytics_daily"));
  assert.ok(daily, "a daily row must be written");
  const row = dailyRow(daily);

  assert.equal(row["day"], "2026-09-21");
  assert.equal(row["tz_basis"], "UTC");
  assert.equal(row["tz_basis_source"], "assumed_utc");
  // The partition is EXACT: wins + losses + breakeven = trades_count, and open
  // (unrealized) trades are not counted at all.
  assert.equal(row["trades_count"], 3);
  assert.equal(row["wins"], 1);
  assert.equal(row["losses"], 1);
  assert.equal(row["breakeven"], 1);
  // Money at scale 2, ratios at scale 4 — including the zero cases.
  assert.equal(row["gross_profit"], "10.00");
  assert.equal(row["gross_loss"], "-5.00"); // 0016 CHECK (gross_loss <= 0): the NEGATIVE sum
  assert.equal(row["net_pnl"], "5.00");
  assert.equal(row["win_rate"], "0.5000");
  assert.equal(row["profit_factor"], "2.0000");
  assert.equal(row["expectancy"], "1.67"); // 5.00 / 3 trades, half-even
  assert.equal(row["max_drawdown"], "5.00"); // peak 10.00 -> 5.00 after the losing trade
});

test("each timezone basis gets its own rows, and both days are written", async () => {
  const { q, writes } = fakeQuery({
    bases: [
      { raw_tz: "Europe/Berlin", declared: true },
      { raw_tz: "UTC", declared: false },
    ],
    daily: {
      "Europe/Berlin": [{ day: "2026-09-21", net_pnl: "12.00", r_multiple: null }],
      "|u": [
        { day: "2026-09-21", net_pnl: "3.00", r_multiple: null },
        { day: "2026-09-20", net_pnl: "-4.00", r_multiple: null },
      ],
    },
    accounts: [],
    accountTrades: {},
  });

  const result = await recomputeUserAnalytics(q, WINDOW);
  assert.equal(result.dailyRows, 3, "one row per (day, basis) — the basis is part of the identity");

  const daily = writes.filter((w) => w.sql.includes("INSERT INTO user_analytics_daily"));
  const keys = daily.map((w) => `${w.params[1]}|${w.params[2]}|${w.params[3]}`).sort();
  assert.deepEqual(keys, [
    "2026-09-20|UTC|assumed_utc",
    "2026-09-21|Europe/Berlin|account",
    "2026-09-21|UTC|assumed_utc",
  ].sort());
});

test("re-running produces byte-identical figures (determinism) and converges on ONE row per key", async () => {
  const script = {
    bases: [{ raw_tz: "UTC", declared: false }],
    daily: {
      "|u": [
        { day: "2026-09-21", net_pnl: "10.00", r_multiple: "1.00000000" },
        { day: "2026-09-21", net_pnl: "-2.50", r_multiple: "1.00000000" },
      ],
    },
    accounts: ["55"],
    accountTrades: {
      "55": [
        { net_pnl: "10.00", r_multiple: "1.00000000", currency: "USD" },
        { net_pnl: "-2.50", r_multiple: "1.00000000", currency: "USD" },
      ],
    },
  };
  const first = fakeQuery(script);
  const second = fakeQuery(script);
  await recomputeUserAnalytics(first.q, WINDOW);
  await recomputeUserAnalytics(second.q, WINDOW);

  assert.deepEqual(
    first.writes.map((w) => [w.sql, w.params]),
    second.writes.map((w) => [w.sql, w.params]),
  );
  // Every write is an upsert keyed by the table's primary key: the run can be
  // repeated indefinitely without appending a second aggregate.
  for (const write of first.writes) {
    assert.match(write.sql, /ON CONFLICT \(/);
    assert.match(write.sql, /DO UPDATE/);
  }
});

test("stale derived rows inside the window are pruned (convergence after deletions)", async () => {
  const { q, writes } = fakeQuery({
    bases: [{ raw_tz: "UTC", declared: false }],
    daily: { "|u": [{ day: "2026-09-21", net_pnl: "1.00", r_multiple: null }] },
    accounts: [],
    accountTrades: {},
    pruned: 2,
  });
  const result = await recomputeUserAnalytics(q, WINDOW);
  assert.equal(result.removedDailyRows, 2);
  const prune = writes.find((w) => w.sql.includes("DELETE FROM user_analytics_daily"));
  assert.equal(prune, undefined, "the prune is a DELETE, not a write we record");
});

test("account summaries aggregate the FULL history and carry peak/trough", async () => {
  const { q, writes } = fakeQuery({
    bases: [{ raw_tz: "UTC", declared: false }],
    daily: {},
    accounts: ["55"],
    accountTrades: {
      "55": [
        { net_pnl: "100.00", r_multiple: "2.00000000", currency: "USD" },
        { net_pnl: "-40.00", r_multiple: "-1.00000000", currency: "USD" },
        { net_pnl: "10.00", r_multiple: "1.00000000", currency: "USD" },
      ],
    },
  });
  await recomputeUserAnalytics(q, WINDOW);

  const account = writes.find((w) => w.sql.includes("INSERT INTO account_performance_summary"));
  assert.ok(account);
  const row = dailyRow(account);

  assert.equal(row["account_id"], "55");
  assert.equal(row["user_id"], "1");
  assert.equal(row["currency"], "USD");
  assert.equal(row["trades_count"], 3);
  assert.equal(row["gross_profit"], "110.00");
  assert.equal(row["gross_loss"], "-40.00");
  assert.equal(row["net_pnl"], "70.00");
  assert.equal(row["expectancy"], "23.33"); // 70.00 / 3, half-even
  assert.equal(row["max_drawdown"], "40.00"); // 100.00 -> 60.00 -> 70.00
  assert.equal(row["equity_peak"], "100.00");
  // The curve starts at ZERO (an account begins with no realized PnL), so a
  // profitable series has a trough of 0.00 rather than its lowest positive
  // point — the peak/trough pair is "highest/lowest point of the cumulative
  // series", and the series begins at 0.
  assert.equal(row["equity_trough"], "0.00");
});

test("a series that goes underwater carries a NEGATIVE equity trough", async () => {
  const { q, writes } = fakeQuery({
    bases: [{ raw_tz: "UTC", declared: false }],
    daily: {},
    accounts: ["77"],
    accountTrades: {
      "77": [
        { net_pnl: "-40.00", r_multiple: null, currency: "EUR" },
        { net_pnl: "25.00", r_multiple: null, currency: "EUR" },
      ],
    },
  });
  await recomputeUserAnalytics(q, WINDOW);
  const account = writes.find((w) => w.sql.includes("INSERT INTO account_performance_summary"));
  assert.ok(account);
  const row = dailyRow(account);
  assert.equal(row["equity_trough"], "-40.00");
  assert.equal(row["equity_peak"], "0.00");
  assert.equal(row["max_drawdown"], "40.00");
  assert.equal(row["net_pnl"], "-15.00");
  assert.equal(row["currency"], "EUR");
});

test("an account with no realized result is not summarized at all", async () => {
  const { q, writes } = fakeQuery({
    bases: [{ raw_tz: "UTC", declared: false }],
    daily: {},
    accounts: ["55"],
    accountTrades: { "55": [{ net_pnl: null, r_multiple: null, currency: "USD" }] },
  });
  await recomputeUserAnalytics(q, WINDOW);
  assert.equal(writes.filter((w) => w.sql.includes("INSERT INTO account_performance_summary")).length, 0);
});

test("bounds fail loudly instead of writing a truncated or oversized aggregate", async () => {
  assert.throws(() => validateWindow({ ...WINDOW, from: "2020-01-01T00:00:00.000Z" }), RecomputeBoundError);
  assert.throws(() => validateWindow({ ...WINDOW, from: "2026-09-22T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" }), /positive interval/);
  assert.doesNotThrow(() => validateWindow(WINDOW));
  assert.ok(MAX_WINDOW_DAYS === 400);

  const huge = Array.from({ length: MAX_ACCOUNT_TRADES + 1 }, () => ({ net_pnl: "1.00", r_multiple: null, currency: "USD" }));
  const { q } = fakeQuery({
    bases: [{ raw_tz: "UTC", declared: false }],
    daily: {},
    accounts: ["55"],
    accountTrades: { "55": huge },
  });
  await assert.rejects(() => recomputeUserAnalytics(q, WINDOW), RecomputeBoundError);
});

test("an unusable stored timezone degrades to UTC instead of failing the recompute", () => {
  assert.equal(isUsableTimeZone("Europe/Berlin"), true);
  assert.equal(isUsableTimeZone("UTC"), true);
  assert.equal(isUsableTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isUsableTimeZone(""), false);
});
