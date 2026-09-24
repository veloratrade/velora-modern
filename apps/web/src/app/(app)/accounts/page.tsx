
"use client";
import React, { useEffect, useState } from "react";
import { listAccounts, createAccount, detectServer, getSyncStatus, connectMetaApi, disconnectMetaApi, listCredentials, createCredential, deleteCredential } from "../../../lib/api/resources";
import type { AccountRecord } from "../../../lib/api/resources";
import { createTranslator } from "../../../i18n/catalog";
import type { Locale } from "../../../contracts/locale";

function useLocale(): Locale { return typeof window!=="undefined" && window.location.pathname.startsWith("/en") ? "en":"fa"; }

function capMsg(t: any, e: any, capability: string, locale: "fa"|"en"): string {
  if (e?.code === "SERVICE_UNAVAILABLE") return t("errors.capabilityUnavailable", { capability }, `${capability} not available`);
  if (e?.messageKey) return t(e.messageKey, e.params ?? null, e.message);
  return e?.message || (locale === "fa" ? "خطای ناشناخته" : "Unknown error");
}

export default function AccountsPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common","errors"]);
  const [accounts, setAccounts] = useState<AccountRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ provider:"MT4", label:"", accountNumber:"", currency:"USD", leverage:"100", timezone:"" });
  const [msg, setMsg] = useState("");
  const [detect, setDetect] = useState<{suggested:string[]}|null>(null);
  const [creds, setCreds] = useState<any[]>([]);
  const [secret, setSecret] = useState("");
  const [credMsg, setCredMsg] = useState("");

  const refresh = async () => {
    setLoading(true); setError("");
    try {
      const res: any = await listAccounts();
      const list = Array.isArray(res) ? res : (res.accounts || res.data || []);
      setAccounts(list);
      const c: any = await listCredentials().catch(()=>({credentials:[]}));
      setCreds(c.credentials || c || []);
    } catch(e:any){ setError(e.message||"Failed"); } finally { setLoading(false); }
  };
  useEffect(()=>{ refresh(); }, []);

  const onDetect = async () => {
    if(!form.accountNumber) { setMsg(locale==="fa"?"شماره حساب را وارد کنید":"Enter account number"); return; }
    try { const r:any = await detectServer(form.accountNumber); setDetect({suggested: r.suggestedServers || []}); setMsg(r.messageKey ? t(r.messageKey,null,r.messageKey) : ""); } catch(e:any){ setMsg(capMsg(t, e, "metaapi", locale)); }
  };
  const onCreate = async (e:React.FormEvent) => {
    e.preventDefault(); setCreating(true); setMsg("");
    try {
      const payload: any = { provider: form.provider };
      if (form.label) payload.label = form.label;
      if (form.accountNumber) payload.accountNumber = form.accountNumber;
      if (form.currency) payload.currency = form.currency;
      if (form.leverage) payload.leverage = form.leverage;
      if (form.timezone) payload.timezone = form.timezone;
      await createAccount(payload);
      setMsg(locale==="fa"?"حساب ایجاد شد":"Account created");
      setForm({provider:"MT4",label:"",accountNumber:"",currency:"USD",leverage:"100",timezone:""});
      await refresh();
    } catch(e:any){ setMsg(e?.code === "SERVICE_UNAVAILABLE" ? capMsg(t, e, "accounts", locale) : (e?.messageKey ? t(e.messageKey, e.params ?? null, e.message) : (e?.details ? JSON.stringify(e.details) : e.message))); } finally { setCreating(false); }
  };
  const onConnect = async (id:string) => {
    try { const r:any = await connectMetaApi(id); setMsg(locale==="fa"?"اتصال موفق":"Connected: "+ (r.metaapiAccountId||"")); await refresh(); } catch(e:any){ setMsg(capMsg(t, e, "metaapi", locale)); }
  };
  const onDisconnect = async (id:string) => {
    try { await disconnectMetaApi(id); setMsg(locale==="fa"?"قطع شد":"Disconnected"); await refresh(); } catch(e:any){ setMsg(capMsg(t, e, "metaapi", locale)); }
  };
  const onCreateCred = async () => {
    if(!secret) { setCredMsg(locale==="fa"?"رمز را وارد کنید":"Enter secret"); return; }
    try { await createCredential("METAAPI", secret); setCredMsg(locale==="fa"?"ذخیره شد":"Saved"); setSecret(""); await refresh(); } catch(e:any){ setCredMsg(capMsg(t, e, "credentials", locale)); }
  };
  const onDeleteCred = async (id:string)=>{ try{ await deleteCredential(id); setCredMsg(locale==="fa"?"حذف شد":"Deleted"); await refresh(); }catch(e:any){ setCredMsg(capMsg(t, e, "credentials", locale));} };

  if (loading) return <div className="empty"><h3>{locale==="fa"?"در حال بارگذاری":"Loading"}</h3><p>Fetching /api/v1/accounts</p></div>;

  return (
    <div>
      <div className="page-head">
        <div><h1 className="page-title">{locale==="fa"?"حساب‌های معاملاتی":"Trading Accounts"}</h1><p className="page-sub">{locale==="fa"?"مدیریت حساب‌ها — 3 مرحله Modern: POST /accounts → POST /credentials (METAAPI) → POST /accounts/:id/metaapi/connect":"Manage accounts — Modern 3-step: POST /accounts → POST /credentials → POST /accounts/:id/metaapi/connect"}</p></div>
        <div className="flex-gap-8"><button className="btn-ghost" onClick={refresh} type="button">{locale==="fa"?"تازه‌سازی":"Refresh"}</button></div>
      </div>
      {error ? <div className="card error-card mb-12">{error}</div> : null}
      {msg ? <div className="card mb-12">{msg} {detect?.suggested?.length ? <span className="v-latn-num"> Suggested: {detect.suggested.slice(0,3).join(", ")}</span> : null}</div> : null}

      <div className="card">
        <h3 className="label text-gold">{locale==="fa"?"ایجاد حساب جدید":"Create Account"}</h3>
        <form onSubmit={onCreate} className="grid-gap-12 mt-12">
          <div className="grid-3">
            <label><span className="label">Provider *</span><select className="input" value={form.provider} onChange={e=>setForm({...form,provider:e.target.value})}><option value="MT4">MT4</option><option value="MT5">MT5</option><option value="MANUAL">MANUAL</option></select></label>
            <label><span className="label">Label</span><input className="input" value={form.label} onChange={e=>setForm({...form,label:e.target.value})} placeholder={locale==="fa"?"حساب اصلی":"Main account"} maxLength={120} /></label>
            <label><span className="label">Account Number</span><input className="input v-latn-num" value={form.accountNumber} onChange={e=>setForm({...form,accountNumber:e.target.value})} placeholder="123456" pattern="[A-Za-z0-9*._-]{1,32}" /></label>
          </div>
          <div className="grid-3">
            <label><span className="label">Currency</span><input className="input v-latn-num" value={form.currency} onChange={e=>setForm({...form,currency:e.target.value})} placeholder="USD" maxLength={3} /></label>
            <label><span className="label">Leverage</span><input className="input v-latn-num" value={form.leverage} onChange={e=>setForm({...form,leverage:e.target.value})} placeholder="100 or 1:100" /></label>
            <label><span className="label">Timezone (IANA)</span><input className="input" value={form.timezone} onChange={e=>setForm({...form,timezone:e.target.value})} placeholder="Asia/Tehran" /></label>
          </div>
          <div className="flex-gap-8">
            <button className="btn-primary" type="submit" disabled={creating}>{creating ? (locale==="fa"?"در حال ایجاد":"Creating") : (locale==="fa"?"ایجاد حساب":"Create")}</button>
            <button className="btn-ghost" type="button" onClick={onDetect}>{locale==="fa"?"تشخیص سرور":"Detect server"}</button>
          </div>
          <p className="page-sub">POST /api/v1/accounts · free plan quota: 1 account (429 ACCOUNT_QUOTA_EXCEEDED)</p>
        </form>
      </div>

      <div className="card mt-16">
        <h3 className="label text-gold">Credentials — POST /credentials (METAAPI, AES-256-GCM, no reveal)</h3>
        <div className="flex-gap-8 mt-8 flex-wrap">
          <label className="flex-1"><span className="label">MetaApi investor password / secret</span><input className="input" type="password" value={secret} onChange={e=>setSecret(e.target.value)} placeholder="••••••••" /></label>
          <button className="btn-primary" onClick={onCreateCred} type="button">{locale==="fa"?"ذخیره رمز":"Save secret"}</button>
        </div>
        {credMsg ? <div className="mt-8 text-gold text-12">{credMsg}</div> : null}
        <div className="mt-12 grid-gap-8">
          {creds.length ? creds.map((c:any)=>(<div key={c.id} className="card-alt flex-between"><span className="v-latn-num">{c.provider} · #{String(c.id).slice(0,8)} · v{c.keyVersion}</span><button className="btn-ghost" onClick={()=>onDeleteCred(String(c.id))} type="button">{locale==="fa"?"حذف":"Delete"}</button></div>)) : <div className="empty">No credentials yet — add METAAPI secret to enable provisioning</div>}
        </div>
        <p className="page-sub mt-8">Secrets are never returned, never logged, never in localStorage. Provider = METAAPI only (0010 CHECK).</p>
      </div>

      <div className="mt-16">
        <h3 className="label text-gold mb-8">Accounts — GET /api/v1/accounts ({accounts.length})</h3>
        {accounts.length===0 ? <div className="card"><div className="empty"><h3>{locale==="fa"?"حسابی وجود ندارد":"No accounts yet"}</h3><p>{locale==="fa"?"اولین حساب را بسازید":"Create your first account above"}</p></div></div> :
          <div className="grid-gap-12">
            {accounts.map((a)=>(
              <div key={a.id} className="card">
                <div className="flex-between flex-wrap gap-8">
                  <div>
                    <div className="font-900 text-ede">{a.label} <span className="v-latn-num muted">#{a.accountNumber||a.id.slice(0,6)}</span> <span className={`badge badge-${a.status}`}>{a.status}</span> <span className={"v-latn-num " + (a.syncStatus==="CONNECTED" ? "sync-connected" : "sync-disconnected")}>{a.syncStatus}</span></div>
                    <div className="v-latn-num muted-xs mt-4">{a.provider} · {a.currency} · 1:{a.leverage} · {a.timezone||"no tz"} · Balance {a.balance} · Equity {a.equity}</div>
                  </div>
                  <div className="flex-gap-8">
                    <button className="btn-primary" onClick={()=>onConnect(a.id)} type="button">Connect</button>
                    <button className="btn-ghost" onClick={()=>onDisconnect(a.id)} type="button">Disconnect</button>
                  </div>
                </div>
                <div className="page-sub v-latn-num mt-8">ID {a.id} · created {new Date(a.createdAt).toLocaleDateString(locale==="fa"?"fa-IR":"en-US")}</div>
              </div>
            ))}
          </div>
        }
      </div>
    </div>
  );
}
