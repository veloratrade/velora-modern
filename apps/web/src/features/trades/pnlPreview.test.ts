/*
 * Preview ↔ server fidelity.
 *
 * The preview is only worth having if it shows the number the server will store.
 * These vectors are the SAME golden vectors the domain's P&L engine is pinned
 * against (`packages/domain/src/pnlGoldenVectors.test.ts`, Legacy/Remote
 * evidence), replayed through the preview path with the API's mode (`half-even`)
 * and the API's storage scaling. Vector A is the canonical EURUSD buy winner:
 * gross 500.00, net 493.50, risk 300.00, R 1.645.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { previewPnl } from "./pnlPreview.js";

const A = {
  direction: "buy" as const,
  entryPrice: "1.1000",
  exitPrice: "1.1050",
  volume: "1.0",
  contractSize: "100000",
  commission: "5.00",
  swap: "1.50",
  stopLoss: "1.0970",
};

test("VECTOR A through the preview: net 493.50 and R 1.645 — the numbers the API stores", () => {
  const preview = previewPnl(A);
  assert.equal(preview.status, "ok");
  if (preview.status !== "ok") return;
  assert.equal(preview.result.kind, "ok");
  if (preview.result.kind !== "ok") return;
  assert.equal(preview.result.grossPnl, "500.00");
  assert.equal(preview.result.netPnl, "493.50");
  assert.equal(preview.result.risk, "300.00");
  assert.equal(preview.result.rMultiple, "1.64500000");
});

test("commission and swap are COSTS: they reduce the previewed net, never inflate it", () => {
  const withCosts = previewPnl({ ...A, commission: "10.00", swap: "2.00" });
  const withoutCosts = previewPnl({ ...A, commission: "0", swap: "0" });
  assert.equal(withCosts.status, "ok");
  assert.equal(withoutCosts.status, "ok");
  if (withCosts.status !== "ok" || withoutCosts.status !== "ok") return;
  // Vector A carries a stop loss, so both previews are fully-resolved "ok"
  // results (PnlResult is a union since MG-RANGE-GUARD — narrow before reading).
  assert.equal(withCosts.result.kind, "ok");
  assert.equal(withoutCosts.result.kind, "ok");
  if (withCosts.result.kind !== "ok" || withoutCosts.result.kind !== "ok") return;
  assert.equal(withoutCosts.result.netPnl, "500.00");
  assert.equal(withCosts.result.netPnl, "488.00"); // 500 − 10 − 2
});

test("contract size scales the money: 0.10 lot of a 100000 contract is 1/10th of the same move", () => {
  const oneLot = previewPnl(A);
  const miniLot = previewPnl({ ...A, volume: "0.10" });
  assert.equal(oneLot.status, "ok");
  assert.equal(miniLot.status, "ok");
  if (oneLot.status !== "ok" || miniLot.status !== "ok") return;
  assert.equal(oneLot.result.kind, "ok");
  assert.equal(miniLot.result.kind, "ok");
  if (oneLot.result.kind !== "ok" || miniLot.result.kind !== "ok") return;
  assert.equal(miniLot.result.netPnl, "43.50"); // 50 − 5 − 1.5 (a tenth of the one-lot move)
  assert.equal(miniLot.result.rMultiple, "1.45000000"); // 43.50 / 30 — the mini lot HAS a stop loss
  assert.equal(oneLot.result.netPnl, "493.50"); // unchanged control
  assert.equal(oneLot.result.rMultiple, "1.64500000");
});

test("undefined risk is reported, never divided: no SL, SL on the wrong side, and zero risk", () => {
  const noSl = previewPnl({ ...A, stopLoss: null });
  assert.equal(noSl.status, "ok");
  if (noSl.status === "ok") {
    assert.equal(noSl.result.kind, "undefined-risk");
    if (noSl.result.kind === "undefined-risk") {
      assert.equal(noSl.result.reason, "no-stop-loss");
      assert.equal(noSl.result.netPnl, "493.50"); // money still previewed
    }
  }
  const wrongSide = previewPnl({ ...A, stopLoss: "1.2000" }); // buy with SL above entry
  assert.equal(wrongSide.status, "ok");
  if (wrongSide.status === "ok" && wrongSide.result.kind === "undefined-risk") {
    assert.equal(wrongSide.result.reason, "stop-loss-wrong-side");
  }
  const zeroSl = previewPnl({ ...A, stopLoss: "0" }); // Legacy treats SL = 0 as absent
  assert.equal(zeroSl.status, "ok");
  if (zeroSl.status === "ok") assert.equal(zeroSl.result.kind, "undefined-risk");
});

test("an unfinished or malformed form previews nothing — no zeros, no NaN, no exception", () => {
  assert.equal(previewPnl({ ...A, entryPrice: "" }).status, "empty");
  assert.equal(previewPnl({ ...A, exitPrice: "" }).status, "empty");
  assert.equal(previewPnl({ ...A, volume: "" }).status, "empty");
  assert.equal(previewPnl({ ...A, contractSize: "" }).status, "empty");
  assert.equal(previewPnl({ ...A, entryPrice: "1.10.0" }).status, "empty");
  assert.equal(previewPnl({ ...A, volume: "abc" }).status, "empty");
  assert.equal(previewPnl({ ...A, stopLoss: "1.0x" }).status, "empty");
  // Empty commission/swap are Legacy's own defaults (0), not "not enough input".
  const dflt = previewPnl({ ...A, commission: "", swap: "" });
  assert.equal(dflt.status, "ok");
  if (dflt.status === "ok") assert.equal(dflt.result.kind, "ok");
});
