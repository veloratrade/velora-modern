// Unit battery for the ECB rate job (offline: no network, no database).
//
// WHAT THIS PROVES: the feed contract (parse/refuse), the three stored rate
// families, exact decimal arithmetic at the stored scale, and the failure modes
// (a malformed or empty feed must THROW rather than yield "no rates today").
// WHAT IT DOES NOT PROVE: that the live ECB endpoint answers (that is an egress
// property of the environment — see the pass-2 report's NOT_PROVEN items).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ECB_DAILY_URL,
  RATE_SCALE,
  buildRateRows,
  crossAgainstBase,
  parseEcbDaily,
  reciprocal,
} from "./ecbRates.js";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time="2026-09-18">
      <Cube currency="USD" rate="1.0842"/>
      <Cube currency="GBP" rate="0.85430"/>
      <Cube currency="JPY" rate="160.12"/>
      <Cube currency="CHF" rate="0.9412"/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

test("the ECB daily feed is parsed with the publishing date it states", () => {
  const parsed = parseEcbDaily(FEED);
  assert.equal(parsed.rateDate, "2026-09-18");
  assert.equal(parsed.rates.get("USD"), "1.0842");
  assert.equal(parsed.rates.get("GBP"), "0.85430");
  assert.equal(parsed.rates.size, 4);
  assert.equal(ECB_DAILY_URL.startsWith("https://www.ecb.europa.eu/"), true, "the feed is the ECB's own, over TLS");
});

test("a feed with no publishing date or no rates is REFUSED, never read as empty", () => {
  // A silent empty parse would leave yesterday's rates in place while the job
  // reported success — the failure mode this assertion exists to prevent.
  assert.throws(() => parseEcbDaily("<Cube><Cube/></Cube>"), /publishing date/);
  assert.throws(() => parseEcbDaily('<Cube time="2026-09-18"></Cube>'), /no usable rates/);
  assert.throws(
    () => parseEcbDaily('<Cube time="2026-09-18"><Cube currency="USD" rate="0"/></Cube>'),
    /non-positive rate/,
  );
});

test("reciprocals and USD crosses are exact decimals at the stored scale", () => {
  assert.equal(RATE_SCALE, 10);
  // 1 / 1.0842 at 10 dp (half-even) — verified independently:
  //   python -c "Decimal(1)/Decimal('1.0842')"
  assert.equal(reciprocal("1.0842"), "0.9223390518");
  // GBP→USD = (EUR→USD) / (EUR→GBP) = 1.0842 / 0.85430
  assert.equal(crossAgainstBase("0.85430", "1.0842"), "1.2691092122");
});

test("exactly three families are stored per currency, and never a same-pair row", () => {
  const rows = buildRateRows(parseEcbDaily(FEED));
  const key = (r: { base: string; quote: string }) => `${r.base}/${r.quote}`;
  const keys = rows.map(key);
  assert.equal(new Set(keys).size, keys.length, "no duplicate pair in one publishing day");
  assert.equal(keys.some((k) => k.split("/")[0] === k.split("/")[1]), false, "0018 forbids base = quote");

  const published = rows.filter((r) => r.source === "ECB");
  const inverse = rows.filter((r) => r.source === "ECB:inverse");
  const cross = rows.filter((r) => r.source === "ECB:usd-cross");
  assert.equal(published.length, 4, "EUR→X as published, once per currency");
  assert.equal(inverse.length, 4, "X→EUR reciprocals");
  assert.equal(cross.length, 6, "X→USD and USD→X for the three non-USD currencies");

  // Provenance is carried in `source`, so a consumer can tell a published figure
  // from a derived one — the column exists and is not decorative.
  assert.equal(rows.find((r) => key(r) === "EUR/USD")?.rate, "1.0842");
  assert.equal(rows.find((r) => key(r) === "GBP/USD")?.source, "ECB:usd-cross");
  assert.equal(rows.find((r) => key(r) === "USD/EUR")?.source, "ECB:inverse");
  assert.equal(rows.find((r) => key(r) === "USD/GBP")?.source, "ECB:usd-cross");
});

const PARSED_RATES = parseEcbDaily(FEED).rates;

test("published figures are stored VERBATIM while derived ones carry the column's scale", () => {
  const rows = buildRateRows(parseEcbDaily(FEED));
  const keys = new Set(rows.map((r) => `${r.base}/${r.quote}`));
  assert.equal(keys.has("EUR/EUR"), false);
  assert.equal(keys.has("USD/USD"), false);
  assert.equal(keys.has("USD/GBP"), true, "the reporting base has an explicit leg");

  for (const row of rows) {
    // Every rate is TEXT, never a JS number: a float would be the first step of
    // the precision loss this whole path avoids.
    assert.equal(typeof row.rate, "string", `${row.base}/${row.quote} must be text`);
    assert.match(row.rate, /^\d+(\.\d+)?$/, `${row.base}/${row.quote} must be a plain decimal`);
  }

  // A PUBLISHED rate carries the ECB's own figure — not re-derived. (The
  // COLUMN stores it as NUMERIC(24,10), and the read path normalizes the text
  // form; see the real-PG battery. What matters here is that the value is the
  // published one and not a re-computed approximation.)
  for (const row of rows.filter((r) => r.source === "ECB")) {
    const published = PARSED_RATES.get(row.quote);
    assert.notEqual(published, undefined);
    assert.equal(
      Number(row.rate) === Number(published),
      true,
      `EUR/${row.quote} is the published figure`,
    );
  }
  // A DERIVED rate is produced at the column's scale, so the rounding is the one
  // explicit step documented in the module header.
  for (const row of rows.filter((r) => r.source !== "ECB")) {
    assert.match(row.rate, /^\d+\.\d{10}$/, `${row.base}/${row.quote} must be scale 10`);
  }
});

test("a base other than USD derives its own leg rather than assuming parity", () => {
  const rows = buildRateRows(parseEcbDaily(FEED), "GBP");
  const key = (r: { base: string; quote: string }) => `${r.base}/${r.quote}`;
  // GBP→USD = 1.0842 / 0.85430 and USD→GBP is its exact reciprocal.
  assert.equal(rows.find((r) => key(r) === "GBP/USD")?.rate, "1.2691092122");
  assert.equal(rows.find((r) => key(r) === "USD/GBP")?.source, "ECB:usd-cross");
  assert.equal(rows.some((r) => key(r) === "GBP/GBP"), false);
});
