// Legacy-export gate logic for the LOAD REHEARSAL — pure, so it can be tested
// without a database. The harness (`tools/load_rehearsal.ts`) does the I/O.
//
// WHY THIS EXISTS (MG-DATA-MIGRATION, PLT-02/PLT-04)
// =================================================
// `docs/migration-strategy.md` §6 lists the validation gates a real cutover must
// pass, and `db/data-step/load_gates.sql` writes them down as read-only aggregate
// SQL — A-gates against the LEGACY SOURCE before any load, B-gates against Modern
// after it. Until now those gates existed as statements a human had to run and
// compare by hand: there was no rehearsal, and "no cutover rehearsal" is exactly
// what the audit recorded as a P1 gap.
//
// This module is the executable form of the A-gates, and it encodes the rule the
// gates' own comments state: EVERY distinct out-of-vocabulary value must have an
// EXPLICIT mapping, or the load does not happen.
//
//   * a value that is already in the target vocabulary → PASS, unchanged;
//   * a value with a mapping in the decisions file → MAPPED, and the mapping is
//     recorded in the evidence (nothing is transformed silently);
//   * a value with no mapping → FAIL, and the load is refused;
//   * a row whose validity cannot be established at all (an unresolved timeline
//     with no owner decision) → QUARANTINE: excluded from the load, written to a
//     quarantine file with its reason, and counted — never invented into a value.
//
// The decisions file is deliberately explicit and OWNER-ATTRIBUTABLE: it carries
// free-text `basis` fields naming the decision each mapping rests on. For the
// synthetic fixture it is labelled `synthetic: true`, and the harness refuses to
// present a synthetic run as migration evidence.

export interface CsvTable {
  columns: string[];
  rows: Record<string, string | null>[];
}

/** Machine-generated CSV: `\N` is NULL, no quoting (documented in the fixture README). */
export function parseCsv(text: string): CsvTable {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = lines[0].split(",");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",");
    if (cells.length !== columns.length) {
      throw new Error(`CSV row has ${cells.length} fields but the header declares ${columns.length}: ${line.slice(0, 80)}`);
    }
    const row: Record<string, string | null> = {};
    columns.forEach((c, i) => {
      row[c] = cells[i] === "\\N" || cells[i] === "" ? null : cells[i];
    });
    return row;
  });
  return { columns, rows };
}

/**
 * Field-level mapping. EVERY column of EVERY export table must be declared:
 * either it lands in a target column, or it is declared with `target: null` and a
 * REASON. A column nobody declared is the actual data-loss risk this gate exists
 * for — an unwritten mapping is how a table's contents disappear quietly.
 */
export interface FieldMapping {
  target: string | null;
  reason?: string;
}

export interface Decisions {
  schema: string;
  synthetic: boolean;
  note?: string;
  field_mapping?: Record<string, Record<string, FieldMapping>>;
  source_vocabulary: Record<string, { to: string; basis: string }>;
  symbol_canonicalisation: Record<string, { to: string; basis: string }>;
  locale_vocabulary: Record<string, { to: string; basis: string }>;
  leverage_rule: { empty: string; basis: string };
  time: {
    mode: "given_utc_only";
    resolves_unresolved_rows: boolean;
    basis: string;
  };
}

export type GateVerdict = "PASS" | "MAPPED" | "QUARANTINE" | "FAIL" | "INFO";

export interface GateResult {
  id: string;
  name: string;
  verdict: GateVerdict;
  detail: string;
}

export interface AppliedMapping {
  concern: string;
  from: string;
  to: string;
  rows: number;
  basis: string;
}

export interface QuarantinedRow {
  table: string;
  id: string;
  reason: string;
}

export interface UnmappedField {
  table: string;
  column: string;
  rows: number;
  reason: string;
}

export interface AgateOutput {
  gates: GateResult[];
  unmappedFields: UnmappedField[];
  fatal: boolean;
  mappings: AppliedMapping[];
  quarantine: QuarantinedRow[];
  /** Symbol → canonical symbol, for the load. */
  symbols: Map<string, string>;
  /** Legacy source value → modern source value. */
  sources: Map<string, string>;
}

const TARGET_SOURCES = new Set(["manual", "metaapi", "import"]);
const TARGET_LOCALES = new Set(["fa", "en"]);
const TARGET_DIRECTIONS = new Set(["buy", "sell"]);
const LEVERAGE_RE = /^(1:)?[1-9][0-9]{0,7}$/;
const MONEY_FIELDS = ["commission", "swap", "profit_loss"];
const POSITIVE_FIELDS = ["entry_price", "exit_price", "volume", "contract_size"];

const moneyFractionDigits = (value: string): number => {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
};

/**
 * Run the A-gates (pre-load censuses) over a parsed legacy export.
 *
 * Aggregate statements only in spirit: this reads the export file a transform
 * tool produced, never a live database, and every gate reports a NUMBER or a
 * decision — "a gate that is not a number is not a gate" (load_gates.sql).
 */
export function runAgates(input: {
  users: CsvTable;
  tradingAccounts: CsvTable;
  trades: CsvTable;
  tradeExits: CsvTable;
  decisions: Decisions;
}): AgateOutput {
  const { users, tradingAccounts, trades, tradeExits, decisions } = input;
  const gates: GateResult[] = [];
  const mappings: AppliedMapping[] = [];
  const quarantine: QuarantinedRow[] = [];
  const symbols = new Map<string, string>();
  const sources = new Map<string, string>();

  // ── A1 · source vocabulary (GAP-03 / OD-15) ──────────────────────────────
  {
    const counts = new Map<string, number>();
    for (const t of trades.rows) {
      const value = t["source"] ?? "(null)";
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (TARGET_SOURCES.has(value)) sources.set(value, value);
      else if (decisions.source_vocabulary[value]) {
        sources.set(value, decisions.source_vocabulary[value].to);
        mappings.push({ concern: "source_vocabulary", from: value, to: decisions.source_vocabulary[value].to, rows: counts.get(value) ?? 1, basis: decisions.source_vocabulary[value].basis });
      }
    }
    const unmapped = [...counts.keys()].filter((v) => !sources.has(v));
    gates.push({
      id: "A1",
      name: "source vocabulary",
      verdict: unmapped.length === 0 ? (mappings.length > 0 ? "MAPPED" : "PASS") : "FAIL",
      detail:
        unmapped.length === 0
          ? `distinct sources: ${[...counts.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}`
          : `no mapping for: ${unmapped.join(", ")} — the target CHECK accepts only manual|metaapi|import`,
    });
  }

  // ── A2 · locale vocabulary (GAP-04) ─────────────────────────────────────
  {
    const distinct = [...new Set(users.rows.map((u) => u["locale"] ?? "(null)"))];
    const mapped = distinct.filter((v) => !TARGET_LOCALES.has(v) && decisions.locale_vocabulary[v]);
    const unmapped = distinct.filter((v) => !TARGET_LOCALES.has(v) && !decisions.locale_vocabulary[v]);
    gates.push({
      id: "A2",
      name: "locale vocabulary",
      verdict: unmapped.length === 0 ? (mapped.length > 0 ? "MAPPED" : "PASS") : "FAIL",
      detail: unmapped.length === 0 ? `distinct locales: ${distinct.join(", ")}` : `no mapping for: ${unmapped.join(", ")}`,
    });
  }

  // ── A3 · leverage shape (GAP-05) ────────────────────────────────────────
  {
    let empty = 0;
    let other: string[] = [];
    for (const a of tradingAccounts.rows) {
      const value = a["leverage"];
      if (value === null) empty += 1;
      else if (!LEVERAGE_RE.test(value)) other.push(value);
    }
    const fill = empty > 0 ? decisions.leverage_rule.empty : null;
    if (fill !== null) {
      mappings.push({ concern: "leverage_rule", from: "(empty)", to: fill, rows: empty, basis: decisions.leverage_rule.basis });
    }
    gates.push({
      id: "A3",
      name: "leverage shape",
      verdict: other.length > 0 ? "FAIL" : fill !== null ? "MAPPED" : "PASS",
      detail:
        other.length > 0
          ? `out-of-shape leverage: ${other.join(", ")}`
          : `empty=${empty}${fill !== null ? ` → default "${fill}"` : ""}, all others match ^(1:)?[1-9][0-9]{0,7}$`,
    });
  }

  // ── A4 · direction vocabulary (GAP-06) ──────────────────────────────────
  {
    const distinct = [...new Set(trades.rows.map((t) => t["direction"] ?? "(null)"))];
    const bad = distinct.filter((v) => !TARGET_DIRECTIONS.has(v));
    gates.push({
      id: "A4",
      name: "direction vocabulary",
      verdict: bad.length === 0 ? "PASS" : "FAIL",
      detail: bad.length === 0 ? `distinct directions: ${distinct.join(", ")}` : `out of vocabulary: ${bad.join(", ")}`,
    });
  }

  // ── A5 · money fraction digits (OD-1/OD-5) ──────────────────────────────
  {
    let worst = 0;
    let worstField = "";
    for (const t of trades.rows) {
      for (const field of MONEY_FIELDS) {
        const value = t[field];
        if (value === null) continue;
        const digits = moneyFractionDigits(value);
        if (digits > worst) {
          worst = digits;
          worstField = `${field}=${value}`;
        }
      }
    }
    gates.push({
      id: "A5",
      name: "money fraction digits",
      verdict: worst <= 2 ? "PASS" : "FAIL",
      detail: worst <= 2 ? `max fraction digits = ${worst} (target NUMERIC(20,2) needs no rounding)` : `^ ${worstField} carries ${worst} digits — a rounding rule is required`,
    });
  }

  // ── A6 · symbol canonicalisation (GAP-15) ───────────────────────────────
  {
    const counts = new Map<string, number>();
    for (const t of trades.rows) {
      const value = t["symbol"] ?? "(null)";
      counts.set(value, (counts.get(value) ?? 0) + 1);
      const rule = decisions.symbol_canonicalisation[value];
      if (rule) {
        symbols.set(value, rule.to);
        mappings.push({ concern: "symbol_canonicalisation", from: value, to: rule.to, rows: counts.get(value) ?? 1, basis: rule.basis });
      } else {
        symbols.set(value, value);
      }
    }
    gates.push({
      id: "A6",
      name: "symbol canonicalisation",
      verdict: mappings.some((m) => m.concern === "symbol_canonicalisation") ? "MAPPED" : "PASS",
      detail: `distinct symbols: ${[...counts.entries()].map(([k, n]) => `${k}=${n}`).join(", ")} — contract sizes are NOT inferred (only observed pairs may be mapped)`,
    });
  }

  // ── A7 · time honesty: how much of the history resolves to a UTC instant? ──
  {
    const unresolved = trades.rows.filter((t) => t["time_status"] !== "resolved" || t["occurred_open_at_utc"] === null);
    if (unresolved.length === 0) {
      gates.push({ id: "A7", name: "time resolution census", verdict: "PASS", detail: `all ${trades.rows.length} trades carry a resolved UTC instant` });
    } else if (decisions.time.resolves_unresolved_rows) {
      gates.push({
        id: "A7",
        name: "time resolution census",
        verdict: "MAPPED",
        detail: `${unresolved.length} unresolved row(s) resolved by the recorded decision: ${decisions.time.basis}`,
      });
    } else {
      for (const t of unresolved) {
        quarantine.push({ table: "trades", id: String(t["id"]), reason: "UNRESOLVED_TIME — no recorded interpretation (ADR-004 sampling decision outstanding)" });
      }
      gates.push({
        id: "A7",
        name: "time resolution census",
        verdict: "QUARANTINE",
        detail: `${unresolved.length} row(s) carry no UTC instant and no interpretation is recorded — excluded from the load, never promoted to an invented instant`,
      });
    }
    if (trades.rows.some((t) => t["source_time_naive"] !== null)) {
      gates.push({
        id: "A7b",
        name: "naive text preserved",
        verdict: "PASS",
        detail: "every row with a naive source text carries it in source_time_naive (the raw evidence survives the migration)",
      });
    }
  }

  // ── A8 · canonical email duplicates (ADR-003 / D-02) ────────────────────
  {
    const seen = new Map<string, number>();
    for (const u of users.rows) {
      const canonical = (u["email"] ?? "").trim().toLowerCase();
      seen.set(canonical, (seen.get(canonical) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    gates.push({
      id: "A8",
      name: "canonical email uniqueness",
      verdict: dupes.length === 0 ? "PASS" : "FAIL",
      detail: dupes.length === 0 ? `${seen.size} distinct canonical addresses` : `collisions: ${dupes.map(([e, n]) => `${e}×${n}`).join(", ")}`,
    });
  }

  // ── A9 · source referential integrity ──────────────────────────────────
  {
    const userIds = new Set(users.rows.map((u) => String(u["id"])));
    const accountIds = new Set(tradingAccounts.rows.map((a) => String(a["id"])));
    const tradeIds = new Set(trades.rows.map((t) => String(t["id"])));
    const orphans: string[] = [];
    for (const t of trades.rows) {
      if (!userIds.has(String(t["user_id"]))) orphans.push(`trade ${t["id"]} → user ${t["user_id"]}`);
      if (t["account_id"] !== null && !accountIds.has(String(t["account_id"]))) orphans.push(`trade ${t["id"]} → account ${t["account_id"]}`);
    }
    for (const a of tradingAccounts.rows) {
      if (!userIds.has(String(a["user_id"]))) orphans.push(`account ${a["id"]} → user ${a["user_id"]}`);
    }
    for (const e of tradeExits.rows) {
      if (!tradeIds.has(String(e["trade_id"]))) orphans.push(`exit ${e["id"]} → trade ${e["trade_id"]}`);
    }
    gates.push({
      id: "A9",
      name: "source referential integrity",
      verdict: orphans.length === 0 ? "PASS" : "FAIL",
      detail: orphans.length === 0 ? "no orphans in the export" : `orphans: ${orphans.slice(0, 5).join("; ")}${orphans.length > 5 ? ` (+${orphans.length - 5})` : ""}`,
    });
  }

  // ── A10 · the v0.3 financial guard, applied to the SOURCE ───────────────
  {
    const bad: string[] = [];
    for (const t of trades.rows) {
      if (quarantine.some((q) => q.table === "trades" && q.id === String(t["id"]))) continue;
      for (const field of POSITIVE_FIELDS) {
        const value = t[field];
        if (value === null) bad.push(`trade ${t["id"]}: ${field} missing`);
        else if (!(Number(value) > 0)) bad.push(`trade ${t["id"]}: ${field}=${value}`);
      }
      const open = t["occurred_open_at_utc"];
      const close = t["occurred_close_at_utc"];
      if (open !== null && close !== null && Date.parse(close) < Date.parse(open)) bad.push(`trade ${t["id"]}: close before open`);
    }
    gates.push({
      id: "A10",
      name: "financial guards in the source",
      verdict: bad.length === 0 ? "PASS" : "FAIL",
      detail: bad.length === 0 ? "no zero/negative price, volume or contract size; no close-before-open" : `violations: ${bad.slice(0, 5).join("; ")}`,
    });
  }

  // ── A12 · field-level mapping: nothing may be lost without a written reason ──
  const unmappedFields: UnmappedField[] = [];
  {
    const declarations = decisions.field_mapping ?? {};
    const undeclared: string[] = [];
    for (const [table, csv] of [["users", users], ["trading_accounts", tradingAccounts], ["trades", trades], ["trade_exits", tradeExits]] as const) {
      const declared = declarations[table] ?? {};
      for (const column of csv.columns) {
        const mapping = declared[column];
        if (mapping === undefined) {
          undeclared.push(`${table}.${column}`);
          continue;
        }
        if (mapping.target === null) {
          unmappedFields.push({ table, column, rows: csv.rows.length, reason: mapping.reason ?? "(no reason given)" });
        }
      }
      for (const column of Object.keys(declared)) {
        if (!csv.columns.includes(column)) undeclared.push(`${table}.${column} (declared but absent from the export)`);
      }
    }
    gates.push({
      id: "A12",
      name: "field-level mapping",
      verdict: undeclared.length === 0 ? (unmappedFields.length > 0 ? "MAPPED" : "PASS") : "FAIL",
      detail:
        undeclared.length > 0
          ? `no mapping declared for: ${undeclared.join(", ")} — an unwritten mapping is how a column's contents disappear`
          : unmappedFields.length > 0
            ? `${unmappedFields.length} column(s) have no target and are RECORDED, not loaded: ${unmappedFields.map((f) => `${f.table}.${f.column}`).join(", ")}`
            : "every exported column maps to a target column",
    });
  }

  // ── A11 · the size of the decision (informational) ──────────────────────
  gates.push({
    id: "A11",
    name: "census (informational)",
    verdict: "INFO",
    detail: `users=${users.rows.length} accounts=${tradingAccounts.rows.length} trades=${trades.rows.length} exits=${tradeExits.rows.length} quarantined=${quarantine.length}`,
  });

  return { gates, fatal: gates.some((g) => g.verdict === "FAIL"), mappings, quarantine, symbols, sources, unmappedFields };
}

/** Money totals per field, exact decimal strings (used for B2 parity). */
export function moneyTotals(rows: Record<string, string | null>[], fields: string[]): Record<string, string> {
  const totals: Record<string, string> = {};
  for (const field of fields) totals[field] = decimalSum(rows.map((r) => r[field]));
  return totals;
}

/**
 * Exact decimal subtraction on strings (`a − b`). Subtracting a negative value
 * must ADD it, which is why this exists instead of string negation: building
 * `-${value}` on an already-negative value produces `--2.50`, and a money helper
 * that can emit that is a money helper nobody should call.
 */
export function decimalSubtract(a: string, b: string, scale = 2): string {
  return fromScaled(parseScaled(a, scale) - parseScaled(b, scale), scale);
}

/**
 * Exact decimal addition on strings — no float ever touches a money value
 * (ADR-001 §1). Scale is preserved at 2 for money, 8 for quantities.
 */
export function decimalSum(values: Array<string | null>, scale = 2): string {
  const scaled = values.reduce((acc, v) => acc + toScaled(BigInt(0), v, scale), BigInt(0));
  return fromScaled(scaled, scale);
}

function toScaled(acc: bigint, value: string | null, scale: number): bigint {
  if (value === null) return acc;
  return acc + parseScaled(value, scale);
}

function parseScaled(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const [intPart, fracPart = ""] = digits.split(".");
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) throw new Error(`not a decimal: ${value}`);
  const padded = (fracPart + "0".repeat(scale)).slice(0, scale);
  const scaled = BigInt(`${intPart === "" ? "0" : intPart}${padded}`);
  return negative ? -scaled : scaled;
}

function fromScaled(value: bigint, scale: number): string {
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? "-" : ""}${intPart}${fracPart}`;
}
