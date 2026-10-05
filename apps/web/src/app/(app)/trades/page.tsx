"use client";
// Trading journal — record completed trades, see what they cost, review the list.
//
// TRD-02 PARITY (Legacy `/trades/new`): the form now carries the numbers a trader
// actually reconciles against their broker statement — CONTRACT SIZE, COMMISSION
// and SWAP — with Legacy's defaults (1 / 0 / 0) and its canonical labels from the
// catalog. Net P&L is `gross − commission − swap`, so without those two inputs a
// fee-paying trade was recorded with a P&L that was simply wrong; and without
// contract size, a lot-based instrument was off by orders of magnitude. A LIVE
// PREVIEW (Legacy's "سود/زیان تخمینی" + R) shows the numbers while typing, using
// the domain package's own engine in the server's mode (see features/trades/pnlPreview).
//
// The emotion picker is Legacy's five levels (very bad → excellent), and every
// user-facing string comes from the `trades` catalog chunk in both locales — this
// page previously held hand-written fa/en pairs, which is how one locale silently
// drifts from the other.
//
// NOT PORTED (recorded, not forgotten): Legacy drew per-symbol ICONS from a
// 2.1 MB `symbols/` registry and used SVG-gradient emotion badges. Modern has no
// icon pipeline yet and the capability — choose a symbol, record an emotion — is
// intact; the visual asset work is tracked in the capability matrix (TRD-02).
import React, { useEffect, useState } from "react";
import { listTrades, createTrade, getTradeSymbols, deleteTrade, getAnalyticsSummary } from "../../../lib/api/resources";
import type { TradeRecord, AnalyticsSummary } from "../../../lib/api/resources";
import { previewPnl } from "../../../features/trades/pnlPreview";
import type { Locale } from "../../../contracts/locale";
import { fmtDateLong, fmtDecimal, fmtMoney, fmtPercent } from "../../../i18n/format";
import { createTranslator } from "../../../i18n/catalog";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

/** "YYYY-MM-DDTHH:mm" (datetime-local) → "YYYY-MM-DD HH:mm:ss" (API naive wall time). */
function toApiDt(v: string): string {
  if (!v) return "";
  return v.length === 16 ? `${v.replace("T", " ")}:00` : v.replace("T", " ");
}
function localInputDefault(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Legacy's five emotion levels, in order, mapped to their catalog keys. */
const EMOTION_KEYS: readonly string[] = [
  "pages.trades.new.very.bad.49845cb0",
  "pages.trades.new.bad.49ec77c4",
  "pages.trades.new.neutral.373d476e",
  "pages.trades.new.good.107c8e66",
  "common.excellent.9c67b8eb",
];

const EMPTY_FORM = {
  symbol: "EURUSD",
  direction: "buy" as "buy" | "sell",
  entryPrice: "",
  exitPrice: "",
  volume: "0.10",
  contractSize: "1",
  commission: "0",
  swap: "0",
  openTime: "",
  closeTime: "",
  stopLoss: "",
  takeProfit: "",
  accountId: "",
  strategyTag: "",
  emotionalScore: "4", // Legacy's default-selected level
  notes: "",
};

export default function TradesPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "trades"]);
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(() => ({
    ...EMPTY_FORM,
    openTime: localInputDefault(new Date(Date.now() - 3600_000)),
    closeTime: localInputDefault(new Date()),
  }));

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await listTrades({ limit: "20" });
      setTrades(res.items || []);
      const sym = await getTradeSymbols().catch(() => ({ symbols: [] as string[] }));
      setSymbols(sym.symbols || []);
      // The KPI row is Legacy's list-page summary. It is ADDITIVE and degrades:
      // a deployment without analytics still has a working journal.
      await getAnalyticsSummary()
        .then((s) => setSummary(s))
        .catch(() => setSummary(null));
    } catch (e: unknown) {
      const err = e as { code?: string; messageKey?: string; message?: string; params?: Record<string, unknown> };
      setError(err?.messageKey ? t(err.messageKey, err.params ?? null, err.message) : err?.message || t("trades.loadFailed", null, "Trades could not be loaded."));
    } finally {
      setLoading(false);
    }
  };
  // Refresh once on mount; `t` changes with the locale and must not re-trigger a fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void refresh();
  }, []);

  const preview = previewPnl({
    direction: form.direction,
    entryPrice: form.entryPrice,
    exitPrice: form.exitPrice,
    volume: form.volume,
    contractSize: form.contractSize,
    commission: form.commission,
    swap: form.swap,
    stopLoss: form.stopLoss.trim() === "" ? null : form.stopLoss,
  });
  // "ok" and "undefined-risk" both carry netPnl (a no-SL trade still has a
  // previewable net); only "out-of-range" (MG-RANGE-GUARD, legacy assertFits)
  // has none — the server would 422 that trade, so the preview shows "—".
  const previewNet =
    preview.status === "ok" && preview.result.kind !== "out-of-range" ? preview.result.netPnl : null;
  const previewR = preview.status === "ok" && preview.result.kind === "ok" ? preview.result.rMultiple : null;
  const previewReason =
    preview.status === "ok" && preview.result.kind === "undefined-risk" ? preview.result.reason : null;

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    setCreating(true);
    try {
      const payload: Record<string, unknown> = {
        symbol: form.symbol.toUpperCase().trim(),
        direction: form.direction,
        entryPrice: form.entryPrice.trim(),
        exitPrice: form.exitPrice.trim(),
        volume: form.volume.trim(),
        contractSize: form.contractSize.trim() === "" ? "1" : form.contractSize.trim(),
        commission: form.commission.trim() === "" ? "0" : form.commission.trim(),
        swap: form.swap.trim() === "" ? "0" : form.swap.trim(),
        openTime: toApiDt(form.openTime),
        closeTime: toApiDt(form.closeTime),
      };
      if (form.stopLoss.trim()) payload.stopLoss = form.stopLoss.trim();
      if (form.takeProfit.trim()) payload.takeProfit = form.takeProfit.trim();
      if (form.accountId.trim()) payload.accountId = form.accountId.trim();
      if (form.strategyTag.trim()) payload.strategyTag = form.strategyTag.trim();
      if (form.emotionalScore) payload.emotionalScore = Number(form.emotionalScore);
      if (form.notes.trim()) payload.notes = form.notes.trim();
      await createTrade(payload);
      setMsg(t("trades.created", null, "Trade saved!"));
      await refresh();
    } catch (e: unknown) {
      const err = e as { code?: string; messageKey?: string; message?: string; params?: Record<string, unknown> };
      setMsg(err?.messageKey ? t(err.messageKey, err.params ?? null, err.message) : err?.message || t("trades.createFailed", null, "The trade could not be saved."));
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (id: string) => {
    if (!window.confirm(t("trades.deleteConfirm", null, "Are you sure you want to delete this trade?"))) return;
    try {
      await deleteTrade(id);
      setMsg(t("trades.deleted", null, "Trade deleted."));
      await refresh();
    } catch (e: unknown) {
      const err = e as { messageKey?: string; message?: string; params?: Record<string, unknown> };
      setMsg(err?.messageKey ? t(err.messageKey, err.params ?? null, err.message) : err?.message || t("trades.createFailed", null, "The trade could not be saved."));
    }
  };

  if (loading && trades.length === 0) {
    return (
      <div className="empty">
        <h3>{t("common.loading", null, "Loading…")}</h3>
      </div>
    );
  }

  // `name` is set on every field on purpose: a form control without one has no
  // identity to the browser (autofill, form history, password managers) or to a
  // test, which then has to locate it by its visible Persian label text. The
  // names mirror the API payload keys the form posts.
  const input = (labelKey: string, value: string, onChange: (v: string) => void, opts: { name: string; required?: boolean; placeholder?: string; list?: string }) => (
    <label>
      <span className="label">
        {t(labelKey, null, labelKey)}
        {opts.required ? " *" : ` (${t("trades.optionalMark", null, "optional")})`}
      </span>
      <input
        className="input v-latn-num"
        name={opts.name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={opts.required}
        placeholder={opts.placeholder}
        list={opts.list}
      />
    </label>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("common.trades.c19408e7", null, "Trade Journal")}</h1>
          <p className="page-sub">{t("trades.apiContract", null, "POST /api/v1/trades")}</p>
        </div>
        <button className="btn-ghost" onClick={() => void refresh()} type="button">
          {t("pages.dashboard.refresh.d6bd8224", null, "Refresh")}
        </button>
      </div>

      {error ? <div className="card error-card mb-12">{error}</div> : null}
      {msg ? <div className="card mb-12">{msg}</div> : null}

      {summary ? (
        <div className="kpi-grid mb-12">
          <div className="kpi">
            <div className="kpi-label">{t("pages.trades.total.trades.b3aaafd2", null, "Total Trades")}</div>
            <div className="kpi-value v-latn-num">{summary.tradeCount}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t("common.win.rate.f57b9504", null, "Win Rate")}</div>
            <div className="kpi-value v-latn-num">{fmtPercent(locale, summary.winRate)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t("common.net.p.l.21997b05", null, "Net P&L")}</div>
            <div className={"kpi-value v-latn-num " + ((Number(summary.totalPnl) || 0) >= 0 ? "pnl-positive" : "pnl-negative")}>
              {fmtMoney(locale, summary.totalPnl)}
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-label">{t("common.profit.factor.4f05d40f", null, "Profit Factor")}</div>
            <div className="kpi-value v-latn-num">
              {summary.profitFactor === null || summary.profitFactor === undefined ? "∞" : fmtDecimal(locale, summary.profitFactor, 2)}
            </div>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h3 className="text-gold">{t("pages.trades.new.record.trade.in.journal.d60654ec", null, "Record Trade in Journal")}</h3>
        <form onSubmit={onCreate} className="grid-gap-12 mt-12">
          <div className="label label-nocap text-gold">{t("pages.trades.new.p05.symbol_setup", null, "Symbol and setup")}</div>
          <div className="grid-3">
            <label>
              <span className="label">
                {t("common.symbol.159cbe33", null, "Symbol")} *
              </span>
              <input
                className="input v-latn-num"
                name="symbol"
                value={form.symbol}
                onChange={(e) => setForm({ ...form, symbol: e.target.value })}
                placeholder="EURUSD"
                required
                pattern="[A-Z0-9#][A-Z0-9._:/#+-]{0,31}"
                list="sym-list"
                aria-describedby="sym-help"
              />
              <datalist id="sym-list">
                {symbols.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <small id="sym-help" className="muted-xs">
                {t("pages.trades.new.trading.symbol.search.or.type.06beee9a", null, "Trading symbol — search or type")}
              </small>
            </label>
            <div>
              <span className="label">{t("pages.trades.new.trade.direction.2f8ac7b6", null, "Trade Direction")} *</span>
              <div className="flex-gap-8" role="group" aria-label={t("pages.trades.new.trade.direction.2f8ac7b6", null, "Trade Direction")}>
                {(["buy", "sell"] as const).map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    className={"btn-" + (form.direction === dir ? "primary" : "ghost") + " btn-sm"}
                    aria-pressed={form.direction === dir}
                    onClick={() => setForm({ ...form, direction: dir })}
                  >
                    {dir === "buy"
                      ? t("pages.trades.new.buy.buy.7dab154d", null, "Buy")
                      : t("pages.trades.new.sell.sell.7e23a93b", null, "Sell")}
                  </button>
                ))}
              </div>
              <small className="muted-xs">
                {form.direction === "buy"
                  ? t("pages.trades.new.long.expecting.growth.5bf30f85", null, "Long")
                  : t("pages.trades.new.short.expecting.decline.c09a8f55", null, "Short")}
              </small>
            </div>
            {input("trades.accountId", form.accountId, (v) => setForm({ ...form, accountId: v }), { name: "accountId",
              placeholder: t("trades.accountIdPlaceholder", null, "your numeric account id"),
            })}
          </div>

          <div className="label label-nocap text-gold mt-8">{t("trades.entryAndCosts", null, "Entry and costs")}</div>
          <div className="grid-3">
            {input("pages.trades.new.entry.price.8d5e74ab", form.entryPrice, (v) => setForm({ ...form, entryPrice: v }), { name: "entryPrice", required: true, placeholder: "1.10000" })}
            {input("pages.trades.new.exit.price.7ded7c82", form.exitPrice, (v) => setForm({ ...form, exitPrice: v }), { name: "exitPrice", required: true, placeholder: "1.10500" })}
            {input("pages.trades.new.volume.lot.6b042d07", form.volume, (v) => setForm({ ...form, volume: v }), { name: "volume", required: true, placeholder: "0.10" })}
          </div>
          <div className="grid-3">
            {input("pages.trades.new.contract.size.fbd9b24e", form.contractSize, (v) => setForm({ ...form, contractSize: v }), { name: "contractSize", placeholder: "1" })}
            {input("pages.trades.new.commission.075f0257", form.commission, (v) => setForm({ ...form, commission: v }), { name: "commission", placeholder: "0" })}
            {input("pages.trades.new.swap.10e4a1fd", form.swap, (v) => setForm({ ...form, swap: v }), { name: "swap", placeholder: "0" })}
          </div>
          <div className="grid-3">
            {input("pages.trades.new.stop.loss.sl.a16f5daa", form.stopLoss, (v) => setForm({ ...form, stopLoss: v }), { name: "stopLoss", placeholder: "1.09500" })}
            {input("pages.trades.new.take.profit.tp.f3e73cce", form.takeProfit, (v) => setForm({ ...form, takeProfit: v }), { name: "takeProfit", placeholder: "1.11500" })}
            {input("common.strategy.1b590fba", form.strategyTag, (v) => setForm({ ...form, strategyTag: v }), { name: "strategyTag", placeholder: t("pages.trades.new.pullback.breakout.296f1e6b", null, "Pullback, breakout…") })}
          </div>

          <div className="label label-nocap text-gold mt-8">{t("pages.trades.new.p05.timing_psychology", null, "Timing and psychology")}</div>
          <div className="grid-3">
            <label>
              <span className="label">
                {t("pages.trades.new.open.time.f5d607ee", null, "Open Time")} *
              </span>
              <input className="input v-latn-num" name="openTime" type="datetime-local" value={form.openTime} onChange={(e) => setForm({ ...form, openTime: e.target.value })} required />
            </label>
            <label>
              <span className="label">
                {t("pages.trades.new.close.time.3fc955ae", null, "Close Time")} *
              </span>
              <input className="input v-latn-num" name="closeTime" type="datetime-local" value={form.closeTime} onChange={(e) => setForm({ ...form, closeTime: e.target.value })} required />
            </label>
            <div>
              <span className="label">{t("pages.trades.new.emotional.score.3adcd56b", null, "Emotional Score")}</span>
              <div className="flex-gap-8" role="radiogroup" aria-label={t("pages.trades.new.emotional.score.3adcd56b", null, "Emotional Score")}>
                {EMOTION_KEYS.map((key, idx) => {
                  const score = String(idx + 1);
                  return (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={form.emotionalScore === score}
                      className={"btn-" + (form.emotionalScore === score ? "primary" : "ghost") + " btn-sm"}
                      onClick={() => setForm({ ...form, emotionalScore: score })}
                      title={t(key, null, score)}
                    >
                      {t(key, null, score)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <label>
            <span className="label">{t("pages.trades.new.notes.936ba8f8", null, "Notes")}</span>
            <input
              className="input"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder={t("pages.trades.new.analysis.entry.rationale.notes.f8de391f", null, "Analysis, entry rationale, notes…")}
              maxLength={5000}
            />
          </label>

          <div className="card card-alt">
            <div className="kpi-grid">
              <div className="kpi">
                <div className="kpi-label">{t("pages.trades.new.estimated.p.l.d17fba70", null, "Estimated P&L")}</div>
                <div className={"kpi-value v-latn-num " + (previewNet === null ? "" : Number(previewNet) >= 0 ? "pnl-positive" : "pnl-negative")}>
                  {previewNet ?? "—"}
                </div>
              </div>
              <div className="kpi">
                <div className="kpi-label">{t("trades.estimatedR", null, "R")}</div>
                <div className="kpi-value v-latn-num">{previewR === null ? "—" : fmtDecimal(locale, previewR, 2)}</div>
                {previewReason ? (
                  <div className="kpi-sub">
                    {previewReason === "no-stop-loss"
                      ? t("trades.riskUndefined", null, "Risk undefined (no stop loss)")
                      : t("trades.riskWrongSide", null, "Risk undefined (stop loss on the wrong side)")}
                  </div>
                ) : null}
              </div>
            </div>
            <p className="muted-xs mt-8 v-latn-num">
              {t("pages.trades.new.details.27928bea", null, "Details")}: {form.entryPrice || "—"} → {form.exitPrice || "—"} ·{" "}
              {form.volume || "—"} × {form.contractSize || "1"} · {t("pages.trades.new.commission.1254ba0b", null, "· Commission")}{" "}
              {form.commission || "0"} · {t("pages.trades.new.swap.10e4a1fd", null, "Swap")} {form.swap || "0"}
            </p>
            <p className="muted-xs">{t("trades.serverComputed", null, "")}</p>
          </div>

          <div className="flex-gap-8">
            <button className="btn-primary" type="submit" disabled={creating}>
              {creating ? t("trades.saving", null, "Saving…") : t("trades.save", null, "Save trade to journal")}
            </button>
          </div>
        </form>
      </div>

      <div className="mt-16">
        <h3 className="text-gold mb-8">
          {t("pages.trades.trades.for.review.eddc7fa1", null, "Trades for Review")} ({trades.length})
        </h3>
        {trades.length === 0 ? (
          <div className="card">
            <div className="empty">
              <h3>{t("trades.empty", null, "No trades recorded yet.")}</h3>
              <p>{t("common.new.trade.b499532d", null, "+ New Trade")}</p>
            </div>
          </div>
        ) : (
          <div className="card overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("common.symbol.159cbe33", null, "Symbol")}</th>
                  <th>{t("trades.direction", null, "Direction")}</th>
                  <th>
                    {t("pages.trades.new.entry.price.8d5e74ab", null, "Entry Price")} → {t("pages.trades.new.exit.price.7ded7c82", null, "Exit Price")}
                  </th>
                  <th>{t("trades.volumeShort", null, "Vol")}</th>
                  <th>{t("common.p.l.56fefd2f", null, "P&L")}</th>
                  <th>R</th>
                  <th>{t("common.strategy.1b590fba", null, "Strategy")}</th>
                  <th>{t("trades.opened", null, "Opened")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {trades.map((tr) => (
                  <tr key={tr.id}>
                    <td className="v-latn-num font-800">{tr.symbol}</td>
                    <td>
                      <span className={"badge " + (tr.direction === "buy" ? "badge-connected" : "badge-disconnected")}>
                        {tr.direction === "buy" ? t("status.buy", null, "Buy") : t("status.sell", null, "Sell")}
                      </span>
                    </td>
                    <td className="v-latn-num">
                      {tr.entryPrice} → {tr.exitPrice}
                    </td>
                    <td className="v-latn-num">{tr.volume}</td>
                    <td className={"v-latn-num font-800 " + (Number(tr.profitLoss) >= 0 ? "pnl-positive" : "pnl-negative")}>{fmtMoney(locale, tr.profitLoss)}</td>
                    <td className="v-latn-num">{fmtDecimal(locale, tr.rMultiple, 2)}</td>
                    <td>{tr.strategyTag || t("trades.setupMissing", null, "No setup recorded")}</td>
                    <td className="v-latn-num text-11">
                      {fmtDateLong(locale, tr.openTime, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td>
                      <button className="btn-ghost btn-sm" onClick={() => void onDelete(tr.id)} type="button">
                        {t("common.delete", null, "Delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
