"use client";
/**
 * Wallet — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Legacy's wallet page was a STATIC demo (two hardcoded "Vittaverse" accounts,
 * fixed balances). Capability-first: Modern owns the REAL connected-accounts
 * list (`GET /api/v1/accounts` — label, balance, equity per account) and the
 * subscription state (`GET /api/v1/subscriptions/me`). This page renders those;
 * Legacy's labels ride on top. The Vittaverse demo names stay in the catalog
 * as vocabulary, never as fake rows.
 */
import React, { useEffect, useState } from "react";
import { createTranslator } from "../../../i18n/catalog";
import { listAccounts, getSubscriptionMe } from "../../../lib/api/resources";
import type { AccountRecord, SubscriptionView } from "../../../lib/api/resources";
import type { Locale } from "../../../contracts/locale";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

export default function WalletPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "wallet"]);
  const [accounts, setAccounts] = useState<AccountRecord[] | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [capAbsent, setCapAbsent] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [acc, sub] = await Promise.all([
          listAccounts(),
          getSubscriptionMe().catch(() => null), // billing capability may be absent; wallet still works
        ]);
        if (cancelled) return;
        setAccounts(Array.isArray(acc) ? acc : acc.accounts);
        setSubscription(sub);
      } catch (e) {
        const err = e as { code?: string; message?: string };
        if (cancelled) return;
        if (err.code === "SERVICE_UNAVAILABLE") setCapAbsent(true);
        else setError(err.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalBalance = (accounts ?? []).reduce((sum, a) => sum + Number(a.balance ?? 0), 0);
  const totalEquity = (accounts ?? []).reduce((sum, a) => sum + Number(a.equity ?? 0), 0);
  const activeCount = (accounts ?? []).filter((a) => a.status === "connected").length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("common.wallet.cd1a64bc", null, "Wallet")}</h1>
          <p className="page-sub">{t("pages.wallet.connected.trading.accounts.and.cloud.wallet.63cd7eff", null, "Connected trading accounts and cloud wallet")}</p>
        </div>
        <span className="badge badge-connected">{t("surface.realAccounts")}</span>
      </div>

      {loading ? <div className="card"><p className="muted-sm">…</p></div> : null}
      {capAbsent ? (
        <div className="card">
          <p className="muted-sm mt-8">{t("errors.api", null, "The accounts capability is not configured on this deployment.")}</p>
        </div>
      ) : null}
      {error ? <div className="card"><p className="muted-sm">{t("surface.loadError", null, error)}</p></div> : null}

      {accounts ? (
        <>
          <div className="grid-3 mt-16">
            <div className="card">
              <small className="muted-xs">{t("pages.wallet.total.account.balance.9cc8b58f", null, "Total account balance")}</small>
              <b className="stat-value text-gold">{totalBalance.toFixed(2)}</b>
            </div>
            <div className="card">
              <small className="muted-xs">{t("pages.wallet.live.equity.d468d9ec", null, "Live equity")}</small>
              <b className="stat-value">{totalEquity.toFixed(2)}</b>
            </div>
            <div className="card">
              <small className="muted-xs">{t("pages.wallet.connected.accounts.b3737245", null, "Connected accounts")}</small>
              <b className="stat-value">{activeCount}</b>
            </div>
          </div>

          <div className="card mt-16">
            <h3 className="label text-gold">{t("pages.wallet.connected.accounts.b3737245", null, "Connected accounts")}</h3>
            {accounts.length === 0 ? (
              <p className="muted-sm mt-8">{t("surface.noAccounts", null, "No trading accounts connected yet.")}</p>
            ) : (
              <div className="table-wrap mt-12">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("surface.account")}</th>
                      <th>{t("surface.provider")}</th>
                      <th>{t("accounts.balance")}</th>
                      <th>{t("pages.wallet.live.equity.d468d9ec", null, "Equity")}</th>
                      <th>{t("surface.status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id}>
                        <td>{a.label || a.accountNumber}</td>
                        <td className="v-latn-num">{a.platform}</td>
                        <td className="v-latn-num">{a.balance}</td>
                        <td className="v-latn-num">{a.equity}</td>
                        <td>{a.syncStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {subscription ? (
            <div className="card mt-16">
              <h3 className="label text-gold">{t("surface.subscription", null, "Subscription")}</h3>
              <div className="flex-gap-8 mt-12">
                <span className="badge">{subscription.purchasedPlan}</span>
                <span className={`badge ${subscription.entitled ? "badge-connected" : "badge-disconnected"}`}>
                  {subscription.entitled ? t("status.active") : t("status.inactive")}
                </span>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
