// Real-PostgreSQL battery for the v1.5 ECB rate ingestion (pass 2).
//
// EVIDENCE LABEL: executes ONLY against a REAL, disposable PostgreSQL
// (DATABASE_URL). Without it every test is SKIPPED. A local SKIP is not evidence.
//
// WHY THIS BATTERY EXISTS: the ingestion writes to a table with real constraints
// — NUMERIC(24,10) rate with `rate > 0`, three-character currency CHECKs, a
// DISTINCT-pair CHECK and a (base,quote,rate_date) primary key. A mock would
// accept anything, so the properties that matter (exact decimal round-trip at
// the column's scale, idempotent re-run, constraint refusal) are proven here and
// only here.
//
// The feed body is the ECB's own document SHAPE; the network call is injected, so
// no test depends on egress.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { buildRateRows, parseEcbDaily, storeRates, RATE_SCALE } from "../../apps/worker/src/fx/ecbRates.js";
import { poolRateQuery } from "../../apps/worker/src/handlers/fxRatesHandler.js";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<Envelope><Cube><Cube time="2026-09-18">
  <Cube currency="USD" rate="1.0842"/>
  <Cube currency="GBP" rate="0.85430"/>
  <Cube currency="JPY" rate="160.12"/>
</Cube></Cube></Envelope>`;

async function harness(): Promise<{ pool: Pool; close: () => Promise<void> }> {
  const db = await prepareDatabase(PG_URL as string);
  return { pool: db.pool, close: db.close };
}

test("PG FX: the ingested rate set round-trips exactly and the job is idempotent", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const q = poolRateQuery(h.pool);
    const parsed = parseEcbDaily(FEED);
    const rows = buildRateRows(parsed);

    const written = await storeRates(q, parsed.rateDate, rows);
    assert.equal(written, rows.length);

    const count = async (): Promise<number> =>
      Number((await h.pool.query("SELECT count(*)::int AS n FROM currency_rates")).rows[0].n);
    assert.equal(await count(), rows.length, "one row per generated pair");

    // EXACTNESS: NUMERIC(24,10) must reproduce the decimal string we sent, with no
    // binary-float detour in between.
    const usd = (await h.pool.query(
      "SELECT rate::text AS rate, source FROM currency_rates WHERE base='EUR' AND quote='USD' AND rate_date=$1",
      [parsed.rateDate],
    )).rows[0] as { rate: string; source: string };
    // THE STORED REPRESENTATION IS THE COLUMN'S SCALE, NOT THE FEED'S TEXT:
    // '1.0842'::numeric(24,10)::text = '1.0842000000'. That is exact (same
    // number) and it is why the module formats rates at scale 10 on the way out
    // instead of pretending the feed's string survives.
    assert.equal(usd.rate, "1.0842000000", "the rate round-trips exactly at the column's scale");
    assert.equal(usd.source, "ECB");

    const inverse = (await h.pool.query(
      "SELECT rate::text AS rate FROM currency_rates WHERE base='USD' AND quote='EUR' AND rate_date=$1",
      [parsed.rateDate],
    )).rows[0] as { rate: string };
    assert.equal(inverse.rate, "0.9223390518", "the reciprocal keeps scale 10");

    const cross = (await h.pool.query(
      "SELECT rate::text AS rate, source FROM currency_rates WHERE base='GBP' AND quote='USD' AND rate_date=$1",
      [parsed.rateDate],
    )).rows[0] as { rate: string; source: string };
    assert.equal(cross.rate, "1.2691092122", "the derived cross keeps the scale-10 figure");
    assert.equal(cross.source, "ECB:usd-cross", "derived provenance is stored, not implied");

    // IDEMPOTENT: a second run of the same publishing day (worker retry, doubled
    // cron, manual backfill) updates the same rows instead of appending.
    await storeRates(q, parsed.rateDate, rows);
    assert.equal(await count(), rows.length, "re-running the day does not duplicate rows");

    // A NEXT day is a new row, and the lookup takes the latest date — the property
    // the portfolio conversion depends on.
    const nextDay = "2026-09-21";
    await storeRates(q, nextDay, buildRateRows({ rateDate: nextDay, rates: new Map([["USD", "1.0900"]]) }));
    const latest = (await h.pool.query(
      "SELECT rate::text AS rate FROM currency_rates WHERE base='EUR' AND quote='USD' ORDER BY rate_date DESC LIMIT 1",
    )).rows[0] as { rate: string };
    assert.equal(latest.rate, "1.0900000000");
  } finally {
    await h.close();
  }
});

test("PG FX: the schema's constraints are the ingestion's real guard rails", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const q = poolRateQuery(h.pool);
    const rateDate = "2026-09-18";
    await storeRates(q, rateDate, buildRateRows(parseEcbDaily(FEED)));

    // A non-positive rate violates 0018's CHECK — proven, not assumed.
    await assert.rejects(
      () => storeRates(q, rateDate, [{ base: "EUR", quote: "XXX", rate: "0.0000000000", source: "ECB" }]),
      (err: { code?: string }) => err.code === "23514",
      "rate > 0 is enforced by the database",
    );
    // A malformed currency violates the ^[A-Z]{3}$ CHECK.
    await assert.rejects(
      () => storeRates(q, rateDate, [{ base: "eurs", quote: "USD", rate: "1.0000000000", source: "ECB" }]),
      (err: { code?: string }) => err.code === "23514",
    );
    // base = quote is refused by the distinct-pair CHECK.
    await assert.rejects(
      () => storeRates(q, rateDate, [{ base: "USD", quote: "USD", rate: "1.0000000000", source: "ECB" }]),
      (err: { code?: string }) => err.code === "23514",
    );
    assert.equal(RATE_SCALE, 10, "the scale the job derives at is the column's scale");
  } finally {
    await h.close();
  }
});
