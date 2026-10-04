"use client";
/*
 * Settings → Telegram (ADR-018) — the WEBSITE-FIRST half of journal linking.
 *
 * WHY THIS PAGE EXISTS AT ALL. Telegram onboarding is the short path, but a user
 * who already uses the web app must be able to connect from where they already
 * are, without hunting for a bot. Both directions end in the same server-side
 * handshake, so neither is privileged.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   * No credential ever passes through here or through Telegram: pressing
 *     "connect" mints an opaque, single-use, 10-minute token; the account is
 *     resolved from the BEARER session on the server, never from anything the
 *     browser sends.
 *   * No client-supplied user id, account id or Telegram id — the API ignores
 *     them by construction, so this page has none to send.
 *   * It never reports "connected" optimistically: every state shown here is read
 *     back from `GET /api/v1/telegram/status`.
 *
 * THE SIX STATES THE UI MUST TELL APART come straight from the API contract —
 * NOT_LINKED, LINK_PENDING, LINKED, LINK_REVOKED, LINK_EXPIRED, LINK_ERROR —
 * because each one has a different next action (offer a link, wait, show the
 * connection, offer a fresh link, offer a fresh link, retry).
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  getTelegramStatus,
  startTelegramLink,
  unlinkTelegram,
  unbindTelegramChannel,
  type TelegramStatusView,
} from "../../../lib/api/resources";
import { ApiError } from "../../../lib/api/client";
import type { Locale } from "../../../contracts/locale";
import { createTranslator } from "../../../i18n/catalog";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

/** The four things this screen can be doing. */
type Phase = "loading" | "ready" | "absent" | "failed";

export default function SettingsPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "telegram"]);
  const fa = locale === "fa";

  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState<TelegramStatusView | null>(null);
  const [pendingLink, setPendingLink] = useState<{ deepLink: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<"" | "connect" | "unlink" | "channel">("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await getTelegramStatus();
      setStatus(view);
      setPhase("ready");
      // A link the server no longer considers pending is stale locally too.
      setPendingLink((current) => (view.state === "LINK_PENDING" ? current : null));
    } catch (e) {
      if (e instanceof ApiError && (e.code === "SERVICE_UNAVAILABLE" || e.status === 503)) {
        setPhase("absent");
        return;
      }
      setPhase("failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a link is pending, the USER is in Telegram pressing Start; polling the
  // status is the only way to notice. Deliberately slow — this is not a live feed.
  useEffect(() => {
    if (phase !== "ready" || status?.state !== "LINK_PENDING") return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [phase, status?.state, load]);

  const onConnect = async () => {
    setBusy("connect");
    setMessage(null);
    try {
      const link = await startTelegramLink();
      // Show the link immediately: the user must press Start in Telegram, and the
      // server only reports LINK_PENDING after that press has happened.
      setPendingLink(link);
      setMessage({ kind: "ok", text: t("telegram.state.connectingNote", null, "Secure link created. Press Start in Telegram.") });
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e, t) });
      // A refusal is often "already linked": re-read rather than guess.
      void load();
    } finally {
      setBusy("");
    }
  };

  const onUnlink = async () => {
    if (!window.confirm(t("telegram.unlinkConfirm", null, fa ? "اتصال تلگرام قطع شود؟" : "Disconnect Telegram?"))) return;
    setBusy("unlink");
    setMessage(null);
    try {
      await unlinkTelegram();
      setPendingLink(null);
      setMessage({ kind: "ok", text: t("telegram.unlinked", null, "Telegram disconnected.") });
      await load();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e, t) });
    } finally {
      setBusy("");
    }
  };

  const onUnbindChannel = async () => {
    setBusy("channel");
    setMessage(null);
    try {
      await unbindTelegramChannel();
      setMessage({ kind: "ok", text: t("telegram.channel.unbound", null, "Journal channel removed.") });
      await load();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e, t) });
    } finally {
      setBusy("");
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setMessage({ kind: "ok", text: t("telegram.copied", null, "Copied") });
    } catch {
      setMessage({ kind: "error", text: url });
    }
  };

  const state = status?.state ?? null;
  const stateBadge = badgeFor(state);
  const identity = status?.identity ?? null;

  return (
    <div>
      <div className="page-head">
        <div>
          {/* The page is the ACCOUNT surface; Telegram is one connected account
              inside it. Titling the page after the feature would make Telegram
              the subject of the screen rather than a section of it. */}
          <h1 className="page-title">{t("telegram.settings.title", null, fa ? "تنظیمات" : "Settings")}</h1>
          <p className="page-sub">{t("telegram.settings.subtitle", null, "")}</p>
        </div>
        {phase === "ready" && status !== null ? (
          <span className={`badge ${stateBadge.cls}`}>{t(stateBadge.key, null, stateBadge.fallback)}</span>
        ) : (
          <span className="badge badge-disconnected">{phase === "loading" ? t("telegram.loading", null, "…") : "—"}</span>
        )}
      </div>

      {phase === "absent" ? (
        <div className="card">
          <h3 className="label text-gold">{t("telegram.title", null, "Telegram")}</h3>
          <p className="muted-sm mt-8">{t("telegram.notConfigured", null, "")}</p>
        </div>
      ) : null}

      {phase === "failed" ? (
        <div className="card">
          <p className="text-error">{t("telegram.state.errorNote", null, "")}</p>
          <button className="btn-ghost mt-12" onClick={() => void load()}>
            {t("telegram.refresh", null, "Refresh")}
          </button>
        </div>
      ) : null}

      {phase === "ready" && status !== null ? (
        <section aria-labelledby="connected-accounts" className="grid-gap-12">
          <h2 className="label" id="connected-accounts" style={{ marginTop: 4 }}>
            {t("telegram.section.connectedAccounts", null, fa ? "حساب‌های متصل" : "Connected accounts")}
          </h2>
          <div className="card">
            <div className="flex-between flex-wrap">
              <div>
                <h3 className="label text-gold">{t("telegram.title", null, "Telegram")}</h3>
                <p className="muted-sm mt-4">{t(stateBadge.noteKey, null, "")}</p>
              </div>
              <div className="flex-gap-8 flex-wrap">
                <button className="btn-ghost btn-sm" onClick={() => void load()} disabled={busy !== ""}>
                  {t("telegram.refresh", null, "Refresh")}
                </button>
                {(state === "NOT_LINKED" || state === "LINK_REVOKED" || state === "LINK_EXPIRED" || state === "LINK_ERROR") && status.bot.deepLinkAvailable ? (
                  <button className="btn-primary" onClick={() => void onConnect()} disabled={busy !== ""}>
                    {t("telegram.connect", null, "🔐 Secure connection to Velora")}
                  </button>
                ) : null}
                {state === "LINKED" ? (
                  <button className="btn-ghost" onClick={() => void onUnlink()} disabled={busy !== ""}>
                    {t("telegram.unlink", null, "Disconnect")}
                  </button>
                ) : null}
              </div>
            </div>

            {identity !== null ? (
              <div className="grid-2 mt-16">
                <div className="card-alt">
                  <span className="label">{t("telegram.linkedAs", null, "Telegram account")}</span>
                  <p className="muted-sm v-latn-num">
                    {identity.username !== null ? `@${identity.username}` : identity.maskedTelegramUserId}
                    {identity.username !== null ? ` · ${identity.maskedTelegramUserId}` : ""}
                  </p>
                  <p className="muted-xs mt-6 v-latn-num">
                    {t("telegram.linkedAt", { when: formatWhen(identity.linkedAt, locale) }, "")}
                  </p>
                  {identity.lastSeenAt !== null ? (
                    <p className="muted-xs mt-4 v-latn-num">
                      {t("telegram.lastSeenAt", { when: formatWhen(identity.lastSeenAt, locale) }, "")}
                    </p>
                  ) : null}
                </div>
                <div className="card-alt">
                  <span className="label">{t("telegram.howItWorks", null, "How it works")}</span>
                  <p className="muted-xs mt-4">{t("telegram.step1", null, "")}</p>
                  <p className="muted-xs mt-4">{t("telegram.step2", null, "")}</p>
                  <p className="muted-xs mt-4">{t("telegram.step3", null, "")}</p>
                </div>
              </div>
            ) : null}

            {pendingLink !== null ? (
              <div className="mt-16">
                <span className="label">{t("telegram.state.connecting", null, "Awaiting connection")}</span>
                <p className="muted-xs mt-4 v-latn-num">
                  {t("telegram.expiresAt", { when: formatWhen(pendingLink.expiresAt, locale) }, "")}
                </p>
                <div className="flex-gap-8 mt-8 flex-wrap">
                  <a className="btn-primary" href={pendingLink.deepLink} target="_blank" rel="noreferrer noopener">
                    {t("telegram.openInTelegram", null, "Open in Telegram")}
                  </a>
                  <button className="btn-ghost" onClick={() => void copyLink(pendingLink.deepLink)}>
                    {t("telegram.copyLink", null, "Copy link")}
                  </button>
                </div>
              </div>
            ) : null}

            {message !== null ? (
              <p className={message.kind === "ok" ? "muted-sm mt-12" : "text-error mt-12"} role={message.kind === "ok" ? "status" : "alert"}>
                {message.text}
              </p>
            ) : null}

            <p className="muted-xs mt-16">{t("telegram.noPassword", null, "")}</p>
          </div>

          <div className="card">
            <div className="flex-between flex-wrap">
              <div>
                <h3 className="label text-gold">{t("telegram.channel.title", null, "Journal channel")}</h3>
                <p className="muted-sm mt-4">
                  {status.channel === null
                    ? t("telegram.channel.none", null, "")
                    : t("telegram.channel.bound", { title: status.channel.title }, "")}
                </p>
                {status.channel !== null && !status.channel.canPost ? (
                  <p className="text-error mt-4 text-12">{t("telegram.channel.canPostNo", null, "")}</p>
                ) : null}
              </div>
              {status.channel !== null ? (
                <button className="btn-ghost btn-sm" onClick={() => void onUnbindChannel()} disabled={busy !== ""}>
                  {t("telegram.channel.unbind", null, "Remove channel")}
                </button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function badgeFor(state: TelegramStatusView["state"] | null): { cls: string; key: string; noteKey: string; fallback: string } {
  switch (state) {
    case "LINKED":
      return { cls: "badge-connected", key: "telegram.state.connected", noteKey: "telegram.state.connectedNote", fallback: "Connected" };
    case "LINK_PENDING":
      return { cls: "badge-disconnected", key: "telegram.state.connecting", noteKey: "telegram.state.connectingNote", fallback: "Awaiting connection" };
    case "LINK_REVOKED":
      return { cls: "badge-disconnected", key: "telegram.state.revoked", noteKey: "telegram.state.revokedNote", fallback: "Revoked" };
    case "LINK_EXPIRED":
      return { cls: "badge-disconnected", key: "telegram.state.expired", noteKey: "telegram.state.expiredNote", fallback: "Expired" };
    case "LINK_ERROR":
      return { cls: "badge-error", key: "telegram.state.error", noteKey: "telegram.state.errorNote", fallback: "Status unknown" };
    default:
      return { cls: "badge-disconnected", key: "telegram.state.disconnected", noteKey: "telegram.state.disconnectedNote", fallback: "Not connected" };
  }
}

/** Server codes → the sentence a user can act on. Never a raw code. */
function errorText(e: unknown, t: ReturnType<typeof createTranslator>): string {
  if (e instanceof ApiError) {
    if (e.code === "TELEGRAM_LINKING_UNAVAILABLE" || e.code === "SERVICE_UNAVAILABLE") {
      return t("telegram.notConfigured", null, e.message);
    }
    if (e.code === "ACCOUNT_ALREADY_LINKED" || e.code === "IDENTITY_LINKED_TO_OTHER_ACCOUNT" || e.code === "TELEGRAM_ALREADY_LINKED") {
      return t("telegram.error.alreadyLinked", null, e.message);
    }
    if (e.code === "RATE_LIMITED") return t("errors.rateLimited", null, e.message);
    if (e.code === "UNAUTHENTICATED") return t("errors.unauthorized", null, e.message);
    if (e.code === "NOT_LINKED" || e.code === "UNLINK_FAILED") return t("telegram.error.unlinkFailed", null, e.message);
    return e.message;
  }
  return String(e);
}

function formatWhen(iso: string, locale: Locale): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ms));
  } catch {
    return iso;
  }
}
