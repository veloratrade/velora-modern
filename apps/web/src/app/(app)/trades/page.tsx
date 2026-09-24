"use client";
import React, { useEffect, useState } from "react";
import { listTrades, createTrade, getTradeSymbols, deleteTrade } from "../../../lib/api/resources";
import type { TradeRecord } from "../../../lib/api/resources";
import type { Locale } from "../../../contracts/locale";
import { htmlLang } from "../../../i18n/registry";
import { createTranslator } from "../../../i18n/catalog";

function useLocale(): Locale { return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa"; }

function tradeMsg(t: any, e: any, locale: "fa" | "en"): string {
  if (e?.code === "SERVICE_UNAVAILABLE") return t("errors.capabilityUnavailable", { capability: "trades" }, "trades not available");
  if (e?.messageKey) return t(e.messageKey, e.params ?? null, e.message);
  if (e?.details) return JSON.stringify(e.details);
  return e?.message || (locale === "fa" ? "خطای ناشناخته" : "Unknown error");
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

const EMPTY_FORM = {
  symbol: "EURUSD", direction: "buy",
  entryPrice: "", exitPrice: "", volume: "0.10",
  openTime: "", closeTime: "",
  stopLoss: "", takeProfit: "", accountId: "",
  strategyTag: "", emotionalScore: "", notes: "",
};

export default function TradesPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors"]);
  const fa = locale === "fa";
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
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
    setLoading(true); setError("");
    try {
      const res: any = await listTrades({ limit: "20" });
      setTrades(res.items || []);
      const sym: any = await getTradeSymbols().catch(() => ({ symbols: [] }));
      setSymbols(sym.symbols || []);
    } catch (e: any) { setError(tradeMsg(t, e, locale)); } finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(""); setCreating(true);
    try {
      const payload: any = {
        symbol: form.symbol.toUpperCase().trim(),
        direction: form.direction,
        entryPrice: form.entryPrice.trim(),
        exitPrice: form.exitPrice.trim(),
        volume: form.volume.trim(),
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
      setMsg(fa ? "معامله ثبت شد" : "Trade recorded");
      await refresh();
    } catch (e: any) { setMsg(tradeMsg(t, e, locale)); } finally { setCreating(false); }
  };
  const onDelete = async (id: string) => {
    if (!window.confirm(fa ? "این معامله حذف شود؟" : "Delete this trade?")) return;
    try { await deleteTrade(id); setMsg(fa ? "حذف شد" : "Deleted"); await refresh(); }
    catch (e: any) { setMsg(tradeMsg(t, e, locale)); }
  };

  if (loading) return <div className="empty"><h3>{fa ? "در حال بارگذاری" : "Loading"}</h3><p>GET /api/v1/trades</p></div>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{fa ? "ژورنال معاملات" : "Trading Journal"}</h1>
          <p className="page-sub">{fa ? "ثبت معاملات انجام‌شده — POST /api/v1/trades (دفتر ADR-002، تراکنش‌های مالی پس از ثبت غیرقابل‌تغییر)" : "Record completed trades — POST /api/v1/trades (ledger ADR-002, financials immutable after create)"}</p>
        </div>
        <button className="btn-ghost" onClick={refresh} type="button">{fa ? "تازه‌سازی" : "Refresh"}</button>
      </div>
      {error ? <div className="card error-card mb-12">{error}</div> : null}
      {msg ? <div className="card mb-12">{msg}</div> : null}

      <div className="card">
        <h3 className="text-gold">{fa ? "ثبت معامله جدید" : "New Trade"}</h3>
        <form onSubmit={onCreate} className="grid-gap-12 mt-12">
          <div className="grid-3">
            <label><span className="label">Symbol *</span><input className="input v-latn-num" value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value })} placeholder="EURUSD" required pattern="[A-Z0-9#][A-Z0-9._:/#+-]{0,31}" list="sym-list" /><datalist id="sym-list">{symbols.map(s => <option key={s} value={s} />)}</datalist></label>
            <label><span className="label">Direction *</span><select className="input" value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value })}><option value="buy">buy</option><option value="sell">sell</option></select></label>
            <label><span className="label">{fa ? "شناسه حساب (اختیاری)" : "Account ID (optional)"}</span><input className="input v-latn-num" value={form.accountId} onChange={e => setForm({ ...form, accountId: e.target.value })} placeholder="numeric id" pattern="[1-9][0-9]*" /></label>
          </div>
          <div className="grid-3">
            <label><span className="label">{fa ? "قیمت ورود *" : "Entry price *"}</span><input className="input v-latn-num" value={form.entryPrice} onChange={e => setForm({ ...form, entryPrice: e.target.value })} required placeholder="1.10000" /></label>
            <label><span className="label">{fa ? "قیمت خروج *" : "Exit price *"}</span><input className="input v-latn-num" value={form.exitPrice} onChange={e => setForm({ ...form, exitPrice: e.target.value })} required placeholder="1.10500" /></label>
            <label><span className="label">{fa ? "حجم *" : "Volume *"}</span><input className="input v-latn-num" value={form.volume} onChange={e => setForm({ ...form, volume: e.target.value })} required placeholder="0.10" /></label>
          </div>
          <div className="grid-3">
            <label><span className="label">{fa ? "زمان باز شدن *" : "Open time *"}</span><input className="input v-latn-num" type="datetime-local" value={form.openTime} onChange={e => setForm({ ...form, openTime: e.target.value })} required /></label>
            <label><span className="label">{fa ? "زمان بسته شدن *" : "Close time *"}</span><input className="input v-latn-num" type="datetime-local" value={form.closeTime} onChange={e => setForm({ ...form, closeTime: e.target.value })} required /></label>
            <label><span className="label">{fa ? "حد ضرر (اختیاری)" : "Stop loss (optional)"}</span><input className="input v-latn-num" value={form.stopLoss} onChange={e => setForm({ ...form, stopLoss: e.target.value })} placeholder="1.09500" /></label>
          </div>
          <div className="grid-3">
            <label><span className="label">{fa ? "حد سود (اختیاری)" : "Take profit (optional)"}</span><input className="input v-latn-num" value={form.takeProfit} onChange={e => setForm({ ...form, takeProfit: e.target.value })} placeholder="1.11500" /></label>
            <label><span className="label">{fa ? "استراتژی (اختیاری)" : "Strategy tag (optional)"}</span><input className="input" value={form.strategyTag} onChange={e => setForm({ ...form, strategyTag: e.target.value })} placeholder="Breakout" maxLength={64} /></label>
            <label><span className="label">{fa ? "امتیاز احساسی ۱-۵ (اختیاری)" : "Emotional score 1-5 (optional)"}</span><input className="input v-latn-num" type="number" min={1} max={5} value={form.emotionalScore} onChange={e => setForm({ ...form, emotionalScore: e.target.value })} placeholder="4" /></label>
          </div>
          <label><span className="label">{fa ? "یادداشت (اختیاری)" : "Notes (optional)"}</span><input className="input" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder={fa ? "یادداشت معامله" : "Trade notes"} maxLength={5000} /></label>
          <div className="flex-gap-8">
            <button className="btn-primary" type="submit" disabled={creating}>{creating ? (fa ? "در حال ثبت…" : "Saving…") : (fa ? "ثبت معامله" : "Record trade")}</button>
          </div>
          <p className="page-sub">POST /api/v1/trades · required: symbol, direction, entryPrice, exitPrice, volume, openTime, closeTime (naive = your profile timezone) · PnL computed server-side (ADR-001) · financials immutable after create (403 errors.trades.financialImmutable) · version CAS on PUT.</p>
        </form>
      </div>

      <div className="mt-16">
        <h3 className="text-gold mb-8">Trades — GET /api/v1/trades ({trades.length})</h3>
        {trades.length === 0 ? (
          <div className="card"><div className="empty"><h3>{fa ? "معامله‌ای ثبت نشده" : "No trades yet"}</h3><p>{fa ? "اولین معامله خود را بالا ثبت کنید" : "Record your first trade above"}</p></div></div>
        ) : (
          <div className="card overflow-auto">
            <table className="table">
              <thead><tr><th>Symbol</th><th>Dir</th><th>{fa ? "ورود→خروج" : "Entry→Exit"}</th><th>Vol</th><th>PnL</th><th>R</th><th>{fa ? "باز شدن" : "Opened"}</th><th></th></tr></thead>
              <tbody>
                {trades.map((tr) => (
                  <tr key={tr.id}>
                    <td className="v-latn-num font-800">{tr.symbol}</td>
                    <td className="v-latn-num">{tr.direction}</td>
                    <td className="v-latn-num">{tr.entryPrice} → {tr.exitPrice}</td>
                    <td className="v-latn-num">{tr.volume}</td>
                    <td className={"v-latn-num " + (Number(tr.profitLoss) >= 0 ? "pnl-positive" : "pnl-negative")}>{tr.profitLoss}{tr.rMultiple ? ` (R ${tr.rMultiple})` : ""}</td>
                    <td className="v-latn-num">{tr.rMultiple ?? "—"}</td>
                    <td className="v-latn-num text-11">{new Date(tr.openTime).toLocaleString(locale === "fa" ? "fa-IR" : "en-US")}</td>
                    <td><button className="btn-ghost btn-sm" onClick={() => onDelete(tr.id)} type="button">{fa ? "حذف" : "Del"}</button></td>
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
