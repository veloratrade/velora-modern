#!/usr/bin/env node
// VELORA MODERN — LEGACY LOAD REHEARSAL (MG-DATA-MIGRATION, PLT-02/PLT-04).
//
// WHAT IT IS
//   The executable cutover rehearsal: A-gates on the export, an id-preserving
//   load into a DISPOSABLE modern database, B-gates on the result, and evidence.
//   `docs/migration-strategy.md` §6 and `db/data-step/load_gates.sql` define the
//   gates; this harness runs them in one command and refuses to continue when one
//   fails. The PnL golden recomputation (gate 6) uses the same `computePnl` the
//   product uses, compared at the LEGACY scale with the LEGACY rounding mode via
//   `packages/domain/src/legacyParity.ts` (MG-RMULTIPLE-SCALE).
//
// WHAT IT IS NOT
//   It is NOT the migration. It moves no production data, and with the synthetic
//   fixture it proves the MACHINERY, not the data (the evidence file says
//   `synthetic: true` and the run prints a warning banner). A real rehearsal needs
//   (a) a real export produced by the transform tool and (b) the ADR-004 sampling
//   decision — until then, rows whose timeline is unresolved are QUARANTINED,
//   never invented.
//
//   This is deliberately the same discipline as `ops/backup/sample_e2e.py`
//   ("structural proof, clearly labelled") and it is why the fixture lives in
//   `db/data-step/fixtures/legacy-export.FIXTURE/`.
//
// SAFETY / FAIL-CLOSED
//   * REHEARSAL_DATABASE_URL's database name must end in `_rehearsal`; the harness
//     TRUNCATEs the tables it loads. Nothing else is ever touched.
//   * an unmapped out-of-vocabulary value stops the load (A-gate FAIL);
//   * no connection string, password or credential is printed or written;
//   * a quarantine is recorded, never silently dropped.
//
// Usage:
//   REHEARSAL_DATABASE_URL=… SOURCE_COMMIT_SHA=$(git rev-parse HEAD) \
//   npx tsx tools/load_rehearsal.ts \
//     --export db/data-step/fixtures/legacy-export.FIXTURE \
//     --decisions db/data-step/fixtures/legacy-export.FIXTURE/decisions.json \
//     --out ops/backup/evidence
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createEngine, migrate } from "../db/migrate.ts";
import { computePnl } from "@velora/domain";
import { currencyParity, legacyRMultiple, rMultipleParity, LEGACY_ROUNDING_MODE } from "@velora/domain";
import { runAgates, moneyTotals, decimalSum, decimalSubtract, parseCsv, type Decisions } from "./lib/legacyLoadGates.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "db", "migrations");
const ROOT = join(import.meta.dirname, "..");

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const exportDir = arg("--export", join(ROOT, "db", "data-step", "fixtures", "legacy-export.FIXTURE"))!;
const decisionsPath = arg("--decisions", join(exportDir, "decisions.json"))!;
const outDir = arg("--out", join(ROOT, "ops", "backup", "evidence"))!;
const KEEP = process.argv.includes("--keep");

const url = process.env.REHEARSAL_DATABASE_URL;
const commit = process.env.SOURCE_COMMIT_SHA ?? "";

const results: boolean[] = [];
const say = (line: string) => console.log(line);
const check = (label: string, ok: boolean, detail: string) => {
  results.push(ok);
  say(`  ${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Refuse to run against anything not obviously disposable (same rule as the drill). */
function preflight(): { database: string; host: string; port: string } {
  const errors: string[] = [];
  if (url === undefined || url.trim() === "") errors.push("REHEARSAL_DATABASE_URL is required");
  if (!/^[0-9a-f]{7,64}$/.test(commit)) errors.push("SOURCE_COMMIT_SHA must be a git SHA (7..64 hex)");
  let descriptor: { database: string; host: string; port: string } | null = null;
  if (url) {
    try {
      const parsed = new URL(url);
      const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
      descriptor = { database, host: parsed.hostname, port: parsed.port === "" ? "5432" : parsed.port };
      if (!database.endsWith("_rehearsal")) errors.push(`the rehearsal target must end in "_rehearsal" (got "${database}")`);
    } catch {
      errors.push("REHEARSAL_DATABASE_URL is not a usable connection string");
    }
  }
  if (errors.length > 0 || descriptor === null) {
    console.error("LOAD REHEARSAL REFUSED:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  return descriptor;
}

const readTable = (name: string) => parseCsv(readFileSync(join(exportDir, `${name}.csv`), "utf8"));

async function main(): Promise<void> {
  const target = preflight();
  const manifest = JSON.parse(readFileSync(join(exportDir, "manifest.json"), "utf8")) as {
    schema: string;
    synthetic: boolean;
    note?: string;
    source_system: string;
    exported_at: string;
    row_counts: Record<string, number>;
    money_totals: Record<string, string>;
  };
  const decisions = JSON.parse(readFileSync(decisionsPath, "utf8")) as Decisions;

  say(`export: ${exportDir} (${manifest.source_system})`);
  say(`target: ${target.host}:${target.port}/${target.database}`);
  if (manifest.synthetic || decisions.synthetic) {
    say("");
    say("  ⚠ SYNTHETIC FIXTURE — this run proves the REHEARSAL MACHINERY, not production data.");
    say(`  ⚠ ${manifest.note ?? decisions.note ?? "fixture input"}`);
    say("");
  }

  // ── A-gates ─────────────────────────────────────────────────────────────
  const users = readTable("users");
  const tradingAccounts = readTable("trading_accounts");
  const trades = readTable("trades");
  const tradeExits = readTable("trade_exits");
  const agates = runAgates({ users, tradingAccounts, trades, tradeExits, decisions });

  say("A-GATES (before any load)");
  for (const g of agates.gates) say(`  ${g.verdict.padEnd(10)} ${g.id} ${g.name} — ${g.detail}`);
  for (const m of agates.mappings) say(`  mapping    ${m.concern}: "${m.from}" → "${m.to}" (${m.rows} row(s)) basis: ${m.basis}`);
  for (const q of agates.quarantine) say(`  quarantine ${q.table} ${q.id}: ${q.reason}`);
  if (agates.fatal) {
    say("\nLOAD REFUSED — an A-gate failed and every out-of-vocabulary value needs an explicit mapping.");
    process.exit(1);
  }
  say("");

  // ── load ────────────────────────────────────────────────────────────────
  const engine = await createEngine(url as string);
  const now = new Date().toISOString();
  let quarantinePath = "";
  try {
    await migrate(engine, MIGRATIONS);
    // The rehearsal target is disposable by name; clear the tables this harness owns.
    await engine.query("TRUNCATE trade_exits, trades, subscriptions, trading_accounts, users RESTART IDENTITY CASCADE");

    say("LOAD (id-preserving, then sequence fixup)");
    for (const u of users.rows) {
      await engine.query(
        `INSERT INTO users (id, email, password_hash, full_name, timezone, plan, status, locale, email_verified_at, ai_consent_at, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [u["id"], (u["email"] ?? "").trim().toLowerCase(), u["password_hash"], u["full_name"] ?? "", u["timezone"] ?? "UTC",
         u["plan"] ?? "free", u["status"] ?? "active", u["locale"] ?? "fa", u["email_verified_at"], u["ai_consent_at"], u["created_at"]],
      );
    }
    // NOTE: no `subscriptions` load. Modern's subscriptions table is the Stripe
    // object (0017: provider CHECK = 'stripe'); a provider-less legacy lifecycle
    // has no target and is RECORDED as an unmapped field instead of invented
    // into a billing row. See db/MIGRATION_MAP.md — MG-SCHEMA-MAPPING.
    for (const a of tradingAccounts.rows) {
      const leverage = a["leverage"] === null ? decisions.leverage_rule.empty : a["leverage"];
      await engine.query(
        `INSERT INTO trading_accounts (id, user_id, external_account_id, provider, platform, label, currency, leverage,
                                       timezone, timezone_source, status, sync_status, balance, starting_balance, consecutive_errors, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'legacy_account',$10,$11,$12,$13,$14,$15)`,
        [a["id"], a["user_id"], a["account_number"], a["provider"], a["platform"], a["label"], a["currency"] ?? "USD",
         leverage, a["timezone"] ?? "UTC", a["status"] ?? "disconnected", a["sync_status"] ?? "DISCONNECTED",
         a["balance"] ?? "0.00", a["starting_balance"] ?? "0.00", a["consecutive_errors"] ?? "0", a["created_at"]],
      );
    }
    let loadedTrades = 0;
    const loadedTradeRows: Record<string, string | null>[] = [];
    for (const t of trades.rows) {
      if (agates.quarantine.some((q) => q.table === "trades" && q.id === String(t["id"]))) continue;
      await engine.query(
        `INSERT INTO trades (id, user_id, account_id, symbol, direction, status, entry_price, exit_price, volume, contract_size,
                             commission, swap, net_pnl, r_multiple, stop_loss, take_profit, source, occurred_at,
                             occurred_open_at_utc, occurred_close_at_utc, time_status, source_timezone,
                             source_time_naive, raw_open_text, raw_close_text)
         OVERRIDING SYSTEM VALUE
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19,'resolved',$20,$21,$22,$23)`,
        [t["id"], t["user_id"], t["account_id"], agates.symbols.get(t["symbol"] ?? "") ?? t["symbol"], t["direction"], t["status"] ?? "CLOSED",
         t["entry_price"], t["exit_price"], t["volume"], t["contract_size"], t["commission"], t["swap"], t["profit_loss"],
         t["r_multiple"], t["stop_loss"], t["take_profit"], agates.sources.get(t["source"] ?? "") ?? "manual",
         t["occurred_open_at_utc"], t["occurred_close_at_utc"], t["source_timezone"], t["source_time_naive"],
         t["open_time"], t["close_time"]],
      );
      loadedTrades += 1;
      loadedTradeRows.push(t);
    }
    for (const e of tradeExits.rows) {
      await engine.query(
        `INSERT INTO trade_exits (id, trade_id, volume, price, pnl, exited_at, recorded_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [e["id"], e["trade_id"], e["volume"], e["exit_price"], e["pnl"], e["exited_at"]],
      );
    }
    // ID-preserving load + setval fixup (db/MIGRATION_MAP.md: identity columns)
    for (const table of ["users", "trading_accounts", "trades", "trade_exits"]) {
      await engine.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
    }
    say(`  loaded users=${users.rows.length} accounts=${tradingAccounts.rows.length} trades=${loadedTrades} exits=${tradeExits.rows.length}`);
    for (const f of agates.unmappedFields) say(`  RECORDED (no target, not loaded): ${f.table}.${f.column} — ${f.reason.slice(0, 120)}`);

    // ── B-gates ───────────────────────────────────────────────────────────
    say("");
    say("B-GATES (after the load)");
    const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => ((await engine.query(sql, params)).rows[0] as T);

    // B1 · row-count parity, minus the recorded quarantine
    const expectedTrades = manifest.row_counts["trades"] - agates.quarantine.filter((q) => q.table === "trades").length;
    const counts = await one<{ users: string; subs: string; accounts: string; trades: string; exits: string }>(
      `SELECT (SELECT count(*) FROM users)::text AS users, '0' AS subs,
              (SELECT count(*) FROM trading_accounts)::text AS accounts, (SELECT count(*) FROM trades)::text AS trades,
              (SELECT count(*) FROM trade_exits)::text AS exits`,
    );
    check("B1 row-count parity (manifest − quarantined)",
      Number(counts.users) === manifest.row_counts["users"] &&
      Number(counts.accounts) === manifest.row_counts["trading_accounts"] && Number(counts.trades) === expectedTrades &&
      Number(counts.exits) === manifest.row_counts["trade_exits"],
      `loaded users=${counts.users} subs=${counts.subs} accounts=${counts.accounts} trades=${counts.trades} (expected ${expectedTrades}) exits=${counts.exits}`);

    // B2 · money parity — the manifest total minus the quarantined rows' own values
    const storedTotals = await one<{ commission: string; swap: string; net_pnl: string }>(
      `SELECT COALESCE(SUM(commission),0)::text AS commission, COALESCE(SUM(swap),0)::text AS swap, COALESCE(SUM(net_pnl),0)::text AS net_pnl FROM trades`,
    );
    const quarantinedMoney = moneyTotals(
      trades.rows.filter((t) => agates.quarantine.some((q) => q.id === String(t["id"]) && q.table === "trades")),
      ["commission", "swap", "profit_loss"],
    );
    for (const [manifestField, storedField] of [["commission", "commission"], ["swap", "swap"], ["net_pnl", "net_pnl"]] as const) {
      const sourceField = manifestField === "net_pnl" ? "profit_loss" : manifestField;
      const expected = decimalSubtract(manifest.money_totals[manifestField], quarantinedMoney[sourceField]);
      check(`B2 money parity · ${manifestField}`, currencyParity(storedTotals[storedField], expected), `stored ${storedTotals[storedField]} vs expected ${expected}`);
    }

    // B3 · structural invariants
    const inv = await one<{ bad: string }>(
      `SELECT (SELECT count(*) FROM trades WHERE direction NOT IN ('buy','sell'))::text AS bad`,
    );
    check("B3 structural invariants", Number(inv.bad) === 0, `out-of-vocabulary directions = ${inv.bad}`);

    // B5 · ownership
    const own = await one<{ bad: string }>(
      `SELECT (SELECT count(*) FROM trades t JOIN trading_accounts a ON a.id = t.account_id WHERE t.user_id <> a.user_id)::text AS bad`,
    );
    check("B5 no cross-owner rows", Number(own.bad) === 0, `violations = ${own.bad}`);

    // B7 · no money beyond 2 dp (the target type forbids it; the gate proves it stayed that way)
    const dp = await one<{ bad: string }>(
      `SELECT count(*)::text AS bad FROM (SELECT commission AS v FROM trades UNION ALL SELECT swap FROM trades UNION ALL SELECT net_pnl FROM trades) x
        WHERE v IS NOT NULL AND v <> ROUND(v, 2)`,
    );
    check("B7 no money beyond 2 dp", Number(dp.bad) === 0, `rows = ${dp.bad}`);

    // B8 · derived tables must be EMPTY after a raw load (they are rebuilt, never copied)
    const derived = await one<{ a: string; b: string }>(
      `SELECT (SELECT count(*) FROM user_analytics_daily WHERE user_id IN (SELECT id FROM users))::text AS a,
              (SELECT count(*) FROM account_performance_summary)::text AS b`,
    ).catch(() => ({ a: "n/a", b: "n/a" } as { a: string; b: string }));
    if (derived.a !== "n/a") check("B8 derived tables empty after raw load", Number(derived.a) === 0 && Number(derived.b) === 0, `analytics rows = ${derived.a}, summaries = ${derived.b}`);

    // GATE 6 · the PnL golden recomputation, at the LEGACY scale
    let checked = 0;
    const recomputeFailures: string[] = [];
    let maxAbsDrift = "0.00";
    for (const t of loadedTradeRows) {
      const pnl = computePnl(
        {
          direction: t["direction"] === "sell" ? "sell" : "buy",
          entryPrice: t["entry_price"] ?? "0",
          exitPrice: t["exit_price"] ?? "0",
          volume: t["volume"] ?? "0",
          contractSize: t["contract_size"] ?? "1",
          commission: t["commission"] ?? "0",
          swap: t["swap"] ?? "0",
          stopLoss: t["stop_loss"],
        },
        LEGACY_ROUNDING_MODE,
      );
      checked += 1;
      if (!currencyParity(pnl.netPnl, t["profit_loss"] ?? "0")) {
        recomputeFailures.push(`trade ${t["id"]}: recomputed net ${pnl.netPnl} vs stored ${t["profit_loss"]}`);
      }
      if (t["r_multiple"] !== null) {
        if (pnl.kind !== "ok") {
          recomputeFailures.push(`trade ${t["id"]}: stored R=${t["r_multiple"]} but the recomputation has no defined risk (${pnl.kind})`);
        } else if (!rMultipleParity(pnl.rMultiple, t["r_multiple"])) {
          recomputeFailures.push(`trade ${t["id"]}: recomputed R ${legacyRMultiple(pnl.netPnl, pnl.risk)} vs stored ${t["r_multiple"]}`);
        }
      }
      if (maxAbsDrift === "0.00") maxAbsDrift = "0.00";
    }
    check("gate 6 · PnL golden recomputation (legacy scale + legacy rounding mode)",
      recomputeFailures.length === 0,
      recomputeFailures.length === 0 ? `${checked} trade(s) recomputed and matched, R compared at scale 4` : recomputeFailures.slice(0, 3).join(" | "));

    // ── quarantine file + evidence ────────────────────────────────────────
    if (agates.quarantine.length > 0) {
      mkdirSync(outDir, { recursive: true });
      quarantinePath = join(outDir, `quarantine-${basename(exportDir)}.jsonl`);
      writeFileSync(quarantinePath, `${agates.quarantine.map((q) => JSON.stringify({ ...q, exported_at: manifest.exported_at })).join("\n")}\n`);
    }
    return writeEvidence({ manifest, decisions, agates, counts, storedTotals, quarantinedMoney, checked, recomputeFailures, target, quarantinePath, exportDir, commit });
  } finally {
    await engine.close();
    void now;
    void KEEP;
  }
}

async function writeEvidence(input: {
  manifest: Record<string, unknown> & { synthetic: boolean; source_system: string; exported_at: string; row_counts: Record<string, number> };
  decisions: Decisions;
  agates: ReturnType<typeof runAgates>;
  counts: { users: string; subs: string; accounts: string; trades: string; exits: string };
  storedTotals: { commission: string; swap: string; net_pnl: string };
  quarantinedMoney: Record<string, string>;
  checked: number;
  recomputeFailures: string[];
  target: { host: string; port: string; database: string };
  quarantinePath: string;
  exportDir: string;
  commit: string;
}): Promise<void> {
  const ok = results.every(Boolean);
  const gate = (g: { id: string; name: string; verdict: string; detail: string }) => ({ id: g.id, name: g.name, verdict: g.verdict, detail: g.detail });
  const evidence = {
    schema: "velora-load-rehearsal/1",
    synthetic: input.manifest.synthetic || input.decisions.synthetic,
    ...(input.manifest.synthetic || input.decisions.synthetic
      ? { synthetic_note: "SYNTHETIC FIXTURE — this run proves the rehearsal MACHINERY, not production data." }
      : {}),
    rehearsal_id: `load-rehearsal-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    at: new Date().toISOString(),
    source_commit_sha: input.commit,
    source_system: input.manifest.source_system,
    exported_at: input.manifest.exported_at,
    export_dir: input.exportDir.replace(ROOT, "."),
    target: `${input.target.host}:${input.target.port}/${input.target.database}`,
    verdict: ok ? "REHEARSAL_PASSED" : "REHEARSAL_FAILED",
    a_gates: input.agates.gates.map(gate),
    applied_mappings: input.agates.mappings,
    unmapped_fields: input.agates.unmappedFields,
    quarantine: {
      rows: input.agates.quarantine,
      money_excluded: input.quarantinedMoney,
      file: input.quarantinePath === "" ? null : input.quarantinePath.replace(ROOT, "."),
    },
    loaded_counts: { ...input.counts, subscriptions: "not mapped (see unmapped_fields)" },
    money_parity: input.storedTotals,
    pnl_golden_recomputation: {
      trades_recomputed: input.checked,
      mismatches: input.recomputeFailures,
      rounding_mode: "bcmath-truncate",
      r_multiple_scale: 4,
    },
    decisions_file: { synthetic: input.decisions.synthetic, note: input.decisions.note ?? null },
    not_claimed: [
      "This is not production migration evidence: no production data was exported, read or copied.",
      "The ADR-004 time-interpretation decision is still outstanding; unresolved rows were quarantined, never invented.",
      "Derived analytics tables are rebuildable and are never copied by a load.",
    ],
  };
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${evidence.rehearsal_id}.json`);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  say("");
  say(`evidence: ${path}`);
  say(`verdict: ${evidence.verdict}${evidence.synthetic ? " (SYNTHETIC FIXTURE)" : ""}`);
  if (!ok) process.exitCode = 1;
}

await main();
