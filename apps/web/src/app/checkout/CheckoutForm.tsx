"use client";
/**
 * Checkout — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * Legacy's checkout page was a STATIC demo: the region/method picker (Iran:
 * rial+crypto / Global: crypto) only toggled a "gateway opens next" message —
 * no payment call existed. Modern owns a REAL billing capability:
 * `POST /api/v1/subscriptions/checkout {interval}` (provider-gated Stripe;
 * an unconfigured deployment answers 503 BILLING_NOT_CONFIGURED honestly).
 * This page keeps Legacy's words for the plan summary and flow chrome, renders
 * the Legacy region/method vocabulary as NON-ACTIVE (no provider is wired to
 * rial or crypto — showing them as selectable would lie), and drives the one
 * real payment path Modern has.
 */
import React, { useState } from "react";
import { createTranslator } from "../../i18n/catalog";
import { postSubscriptionCheckout } from "../../lib/api/resources";
import type { Locale } from "../../contracts/locale";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

export function CheckoutForm() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "checkout"]);
  const [interval, setIntervalChoice] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [isError, setIsError] = useState(false);

  async function continueCheckout() {
    setBusy(true);
    setNotice("");
    setIsError(false);
    try {
      const res = await postSubscriptionCheckout(interval);
      if (typeof res.url === "string" && res.url !== "") {
        window.location.assign(res.url);
        return;
      }
      setNotice(t("surface.billingOff"));
      setIsError(true);
    } catch (e) {
      const err = e as { code?: string; message?: string; status?: number };
      if (err.code === "BILLING_NOT_CONFIGURED") {
        setNotice(t("surface.billingOff"));
      } else if (err.status === 401) {
        setNotice(t("surface.loginRequired"));
      } else {
        setNotice(err.message ?? String(e));
      }
      setIsError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="checkout-shell">
      <header className="legal-top">
        <a href="/" className="legal-brand">VELORA</a>
        <a href="/" className="legal-back">{t("pages.checkout.p05.back_home")}</a>
      </header>
      <div className="checkout-main">
        <section>
          <p className="legal-eyebrow">{t("pages.checkout.p05.eyebrow")}</p>
          <h1>{t("pages.checkout.p05.heading")}</h1>
          <p className="legal-lead">{t("pages.checkout.p05.intro")}</p>

          <div className="card mt-16">
            <h3 className="label text-gold">{t("pages.checkout.p05.region_title")}</h3>
            <div className="grid-2 mt-12">
              <div className="card-alt">
                <b>{t("pages.checkout.p05.iran_title")}</b>
                <p className="muted-xs mt-6">{t("pages.checkout.p05.iran_body")}</p>
              </div>
              <div className="card-alt">
                <b>{t("pages.checkout.p05.global_title")}</b>
                <p className="muted-xs mt-6">{t("pages.checkout.p05.global_body")}</p>
              </div>
            </div>
            <h3 className="label text-gold mt-16">{t("pages.checkout.p05.method_title")}</h3>
            <div className="mt-12">
              <div className="card-alt">
                <b>{t("pages.checkout.p05.rial_title")}</b>
                <p className="muted-xs mt-6">{t("pages.checkout.p05.rial_body")}</p>
              </div>
              <div className="card-alt mt-8">
                <b>{t("pages.checkout.p05.crypto_title")}</b>
                <p className="muted-xs mt-6">{t("pages.checkout.p05.crypto_body")}</p>
              </div>
            </div>
            <p className="muted-xs mt-12">{t("surface.providerNote")}</p>
          </div>
        </section>

        <aside className="card checkout-summary">
          <div className="plan-row">
            <div>
              <b>{t("pages.checkout.p05.plan_title")}</b>
              <p className="muted-xs">{t("pages.checkout.p05.plan_subtitle")}</p>
            </div>
            <span className="price v-latn-num">$29</span>
          </div>
          <div className="row-line">
            <span>{t("pages.checkout.p05.billing_cycle")}</span>
            <span className="flex-gap-8">
              <button
                type="button"
                className={`badge ${interval === "month" ? "badge-connected" : ""}`}
                onClick={() => setIntervalChoice("month")}
              >
                {t("pages.checkout.p05.monthly")}
              </button>
              <button
                type="button"
                className={`badge ${interval === "year" ? "badge-connected" : ""}`}
                onClick={() => setIntervalChoice("year")}
              >
                year
              </button>
            </span>
          </div>
          <div className="row-line total">
            <span>{t("pages.checkout.p05.amount_due")}</span>
            <span className="v-latn-num">$29</span>
          </div>
          <button type="button" className="btn-gold mt-12" disabled={busy} onClick={continueCheckout}>
            {busy ? "…" : t("pages.checkout.p05.continue")}
          </button>
          {notice ? (
            <p className={`mt-8 ${isError ? "muted-sm" : ""}`} aria-live="polite">{notice}</p>
          ) : null}
          <p className="muted-xs mt-12">{t("pages.checkout.p05.notice")}</p>
        </aside>
      </div>
    </main>
  );
}
