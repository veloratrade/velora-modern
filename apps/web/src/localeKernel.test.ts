import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./localeKernel.js";

test("public routes: locale + cache class decided per ADR-009/D-14", () => {
  const fa = decide("/fa/checkout");
  assert.equal(fa.kind === "route" && fa.locale, "fa");
  const en = decide("/en/checkout");
  assert.equal(en.kind === "route" && en.locale, "en");
  assert.equal(decide("/")!.kind === "route" && (decide("/") as { locale: string }).locale, "fa");
});

test("bare /en redirects (308) to the contract URL /en/ — no alternative structures", () => {
  const d = decide("/en");
  assert.deepEqual(d, { kind: "redirect", location: "/en/", status: 308 });
});

test("market data ≠ editorial: distinct cache policies flow through the kernel", () => {
  const market = decide("/markets") as Extract<ReturnType<typeof decide>, { kind: "route" }>;
  const blog = decide("/blog/forex-trading-journal/") as Extract<ReturnType<typeof decide>, { kind: "route" }>;
  assert.match(market.cacheControl, /s-maxage=120/);
  assert.match(blog.cacheControl, /s-maxage=3600/);
  assert.equal(market.localeHeader.name, "X-VELORA-Locale");
});

test("authenticated/app routes pass through untouched (no-store is enforced at the app shell)", () => {
  assert.equal(decide("/dashboard").kind, "passthrough");
  assert.equal(decide("/api/v1/anything").kind, "passthrough");
});
