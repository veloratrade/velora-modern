// Unit tests for the legacy-export A-gates (tools/lib/legacyLoadGates.ts).
//
// The harness RUNS against a real database (its run produces the evidence); these
// tests pin the rules that decide whether that run is allowed to happen at all,
// which is where a silent data-loss defect would live:
//   * an out-of-vocabulary value with no explicit mapping stops the load;
//   * a column with no declared mapping stops the load;
//   * an unresolved timeline is QUARANTINED, never invented;
//   * money arithmetic is exact on strings (and a negative subtrahend adds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decimalSubtract, decimalSum, moneyTotals, parseCsv, runAgates, type Decisions } from "./lib/legacyLoadGates.ts";

const decisions = (over: Partial<Decisions> = {}): Decisions => ({
  schema: "velora-migration-decisions/1",
  synthetic: true,
  source_vocabulary: { auto_sync: { to: "metaapi", basis: "OD-15 fixture" } },
  symbol_canonicalisation: { "XAU/USD": { to: "XAUUSD", basis: "GAP-15 fixture" } },
  locale_vocabulary: { fa: { to: "fa", basis: "GAP-04" }, en: { to: "en", basis: "GAP-04" } },
  leverage_rule: { empty: "100", basis: "GAP-05 fixture" },
  time: { mode: "given_utc_only", resolves_unresolved_rows: false, basis: "ADR-004 outstanding" },
  field_mapping: {
    users: { id: { target: "id" }, email: { target: "email" }, locale: { target: "locale" }, plan: { target: "plan" }, legacy_flag: { target: null, reason: "no target — recorded" } },
    trading_accounts: { id: { target: "id" }, user_id: { target: "user_id" }, leverage: { target: "leverage" } },
    trades: {
      id: { target: "id" }, user_id: { target: "user_id" }, account_id: { target: "account_id" }, symbol: { target: "symbol" },
      direction: { target: "direction" }, entry_price: { target: "entry_price" }, exit_price: { target: "exit_price" },
      volume: { target: "volume" }, contract_size: { target: "contract_size" }, commission: { target: "commission" },
      swap: { target: "swap" }, profit_loss: { target: "net_pnl" }, r_multiple: { target: "r_multiple" },
      stop_loss: { target: "stop_loss" }, source: { target: "source" }, status: { target: "status" },
      open_time: { target: "raw_open_text" }, occurred_open_at_utc: { target: "occurred_at" },
      occurred_close_at_utc: { target: "occurred_close_at_utc" }, source_timezone: { target: "source_timezone" },
      time_status: { target: "time_status" }, source_time_naive: { target: "source_time_naive" },
    },
    trade_exits: { id: { target: "id" }, trade_id: { target: "trade_id" }, exit_price: { target: "price" }, volume: { target: "volume" } },
  },
  ...over,
});

const csv = (header: string, ...rows: string[]) => parseCsv([header, ...rows].join("\n"));

const trade = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
    id: "1", user_id: "1", account_id: "1", symbol: "EURUSD", direction: "buy", entry_price: "1.10000000",
    exit_price: "1.10500000", volume: "1.00000000", contract_size: "100000.00000000", commission: "5.00",
    swap: "1.50", profit_loss: "493.50", r_multiple: "1.6450", stop_loss: "1.09700000", source: "manual",
    status: "CLOSED", open_time: "1403/06/11 09:00", occurred_open_at_utc: "2026-09-02T05:30:00Z",
    occurred_close_at_utc: "2026-09-02T08:30:00Z", source_timezone: "Asia/Tehran", time_status: "resolved",
    source_time_naive: "1403/06/11 09:00",
  };
  const merged = { ...base, ...over };
  return { columns: Object.keys(merged), rows: [merged] };
};

const users = csv("id,email,locale,plan,legacy_flag", "1,fixture.one@velora.test,fa,pro,x");
const accounts = csv("id,user_id,leverage", "1,1,1:100");
const exits = csv("id,trade_id,exit_price,volume", "1,1,1.10300000,0.5");

const gates = (over: { trades?: ReturnType<typeof trade>; decisions?: Decisions; users?: typeof users; accounts?: typeof accounts; exits?: typeof exits } = {}) =>
  runAgates({
    users: over.users ?? users,
    tradingAccounts: over.accounts ?? accounts,
    trades: over.trades ?? trade(),
    tradeExits: over.exits ?? exits,
    decisions: over.decisions ?? decisions(),
  });

test("parseCsv: \\N is NULL, empty is NULL, a ragged row is refused (not silently truncated)", () => {
  const t = parseCsv("a,b,c\n1,\\N,3\n");
  assert.deepEqual(t.rows, [{ a: "1", b: null, c: "3" }]);
  assert.throws(() => parseCsv("a,b\n1\n"), /1 fields but the header declares 2/);
});

test("a clean export passes every A-gate and reports no mapping", () => {
  const out = gates();
  assert.equal(out.fatal, false);
  assert.deepEqual(out.mappings, []);
  assert.deepEqual(out.quarantine, []);
  assert.equal(out.gates.every((g) => g.verdict !== "FAIL"), true);
});

test("an out-of-vocabulary source STOPS the load when no mapping is declared", () => {
  const out = gates({
    trades: trade({ source: "auto_sync" }),
    decisions: decisions({ source_vocabulary: {} }),
  });
  assert.equal(out.fatal, true, "an unmapped vocabulary value must refuse the load");
  assert.match(out.gates.find((g) => g.id === "A1")!.detail, /no mapping for: auto_sync/);
});

test("an out-of-vocabulary source with a declared mapping is MAPPED and recorded", () => {
  const out = gates({ trades: trade({ source: "auto_sync" }) });
  assert.equal(out.fatal, false);
  assert.deepEqual(out.sources.get("auto_sync"), "metaapi");
  assert.equal(out.mappings[0].concern, "source_vocabulary");
  assert.equal(out.mappings[0].basis, "OD-15 fixture");
});

test("slash symbols are canonicalised, and the target keeps the row's own contract size", () => {
  const out = gates({ trades: trade({ symbol: "XAU/USD" }) });
  assert.equal(out.symbols.get("XAU/USD"), "XAUUSD");
  assert.match(out.gates.find((g) => g.id === "A6")!.detail, /contract sizes are NOT inferred/);
});

test("an unresolved timeline is QUARANTINED, never promoted to an instant", () => {
  const out = gates({
    trades: trade({ time_status: "unresolved", occurred_open_at_utc: null, occurred_close_at_utc: null }),
  });
  assert.equal(out.fatal, false, "quarantine is not a refusal — the rest of the export still loads");
  assert.deepEqual(out.quarantine, [{ table: "trades", id: "1", reason: "UNRESOLVED_TIME — no recorded interpretation (ADR-004 sampling decision outstanding)" }]);
  assert.equal(out.gates.find((g) => g.id === "A7")!.verdict, "QUARANTINE");
});

test("an unresolved timeline becomes loadable ONLY when the owner's decision says so", () => {
  const out = gates({
    trades: trade({ time_status: "unresolved", occurred_open_at_utc: null, occurred_close_at_utc: null }),
    decisions: decisions({ time: { mode: "given_utc_only", resolves_unresolved_rows: true, basis: "owner decision OD-AC-ADR004" } }),
  });
  assert.deepEqual(out.quarantine, []);
  assert.equal(out.gates.find((g) => g.id === "A7")!.verdict, "MAPPED");
});

test("a column with NO declared mapping stops the load; a declared-but-targetless column is recorded", () => {
  const declared = decisions();
  delete (declared.field_mapping as Record<string, Record<string, unknown>>)["trades"]["swap"];
  const bad = gates({ decisions: declared });
  assert.equal(bad.fatal, true);
  assert.match(bad.gates.find((g) => g.id === "A12")!.detail, /no mapping declared for: trades\.swap/);

  const good = gates();
  assert.equal(good.fatal, false);
  assert.deepEqual(good.unmappedFields, [{ table: "users", column: "legacy_flag", rows: 1, reason: "no target — recorded" }]);
});

test("duplicate canonical emails, source orphans and non-positive magnitudes are all FAILURES", () => {
  const dupes = gates({ users: csv("id,email,locale,plan,legacy_flag", "1,A@x.test,fa,pro,x", "2,a@x.test,fa,pro,x") });
  assert.match(dupes.gates.find((g) => g.id === "A8")!.detail, /collisions: a@x\.test×2/);

  const orphan = gates({ trades: trade({ user_id: "999" }) });
  assert.match(orphan.gates.find((g) => g.id === "A9")!.detail, /trade 1 → user 999/);

  const zeroPrice = gates({ trades: trade({ exit_price: "0" }) });
  assert.equal(zeroPrice.fatal, true);
  assert.match(zeroPrice.gates.find((g) => g.id === "A10")!.detail, /exit_price=0/);
});

test("a close instant before its open instant is refused before any load happens", () => {
  const out = gates({ trades: trade({ occurred_close_at_utc: "2026-09-02T04:00:00Z" }) });
  assert.match(out.gates.find((g) => g.id === "A10")!.detail, /close before open/);
});

test("money with more than 2 fraction digits is refused — a rounding rule is required, not assumed", () => {
  const out = gates({ trades: trade({ commission: "5.005" }) });
  assert.equal(out.fatal, true);
  assert.match(out.gates.find((g) => g.id === "A5")!.detail, /carries 3 digits/);
});

test("decimal arithmetic is exact on strings and a negative subtrahend ADDS", () => {
  assert.equal(decimalSum(["0.10", "0.20"]), "0.30", "0.1 + 0.2 is 0.30 on strings (never 0.30000000000000004)");
  assert.equal(decimalSum(["-2.50", "1.50"]), "-1.00");
  assert.equal(decimalSubtract("1532.00", "47.50"), "1484.50");
  assert.equal(decimalSubtract("1532.00", "-47.50"), "1579.50", "subtracting a negative adds — the `--2.50` bug");
  assert.equal(decimalSum([]), "0.00");
  assert.equal(moneyTotals([{ a: "1.11" }, { a: null }, { a: "2.22" }], ["a"]).a, "3.33");
});
