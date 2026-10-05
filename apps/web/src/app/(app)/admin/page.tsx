"use client";
// Admin console — Phase 6. Legacy's `admin/index.html` + `admin/v2` (15 modules,
// 454 catalog keys, 38 PHP modules) migrated BY CAPABILITY, in dependency order:
// this screen carries the modules whose substrate exists in Modern today, and the
// ones that depend on the AI (phase 7) and integrations/worker (phase 8)
// capabilities are named in the System tab as NOT APPLICABLE with their reason —
// never as empty panels that look like a checked-and-clean result.
//
// WHAT LEGACY'S PANEL DID, AND WHAT THIS ONE DOES:
//   * an OVERVIEW of platform counts (users, admins, plan mix, accounts, trades,
//     open trades, subscription states, the support queue) — the same questions
//     Legacy's AdminOverviewService answered;
//   * USERS: searchable, paginated list → a per-user detail with identity,
//     actions (activate/suspend, verify e-mail), sessions (revoke one/all),
//     devices, accounts, trades and the audit history;
//   * the SUPPORT QUEUE (Phase 5's admin API): list by status, thread, reply,
//     internal note, close/reopen/archive;
//   * the AUDIT LOG with filters, the SECURITY feeds (signups/logins), SYSTEM
//     HEALTH and ANALYTICS (users/trading over a bounded range).
//
// WHAT IS DELIBERATELY DIFFERENT:
//   * TABS ARE PERMISSION-DRIVEN. The tab set is computed from the permission set
//     the SERVER reports (`/admin/rbac/self`); a tab the caller cannot use is not
//     rendered, AND every request is authorized again server-side. A hidden
//     control is a usability decision, never a security boundary.
//   * The sensitive network fields (ip/user-agent) arrive ONLY for a holder of
//     `audit.view_sensitive`; when they are absent the console says so with
//     `admin.user360.notAvailable` rather than rendering an empty cell, because
//     "hidden from you" and "not recorded" are different facts.
//   * Copy comes from the `admin` catalog chunk in BOTH locales; the strings are
//     byte copies of Legacy's own admin keys where Legacy had the words, and
//     `adminConsole.*` keys are authored where it did not (tab labels, pager,
//     capability-absent, the fields Modern adds).
//   * Every number and date goes through `fmtNumber`/`fmtDateLong`; formatted
//     dates use `.ts-mixed` (Latin digits, document direction) rather than
//     `.v-latn-num`, whose `direction:ltr` reorders a Jalali date around its
//     comma — the defect Phase 5's visual QA found and this page inherits the fix
//     for.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import {
  actOnSupportQueueTicket,
  getAdminHealth,
  getAdminOverview,
  getAdminSelf,
  getAdminTradingAnalytics,
  getAdminUsersAnalytics,
  getSupportQueueTicket,
  getUserAccounts,
  getUserDevices,
  getUserSessions,
  getUserTrades,
  listAdminUsers,
  listAuditLog,
  listPlatformAccounts,
  listPlatformTrades,
  listSecurityFeed,
  listSupportQueue,
  replySupportQueueTicket,
  revokeUserSessions,
  setUserRole,
  setUserStatus,
  verifyUserEmail,
  type AdminAccountRow,
  type AdminAuditRow,
  type AdminHealthView,
  type AdminOverviewView,
  type AdminSecurityRow,
  type AdminSessionRow,
  type AdminTradeRow,
  type AdminTradingAnalyticsView,
  type AdminUserRow,
  type AdminUsersAnalyticsView,
  type SupportQueueTicketView,
} from "../../../lib/api/resources";
import { ApiError } from "../../../lib/api/client";
import type { Locale } from "../../../contracts/locale";
import { createTranslator } from "../../../i18n/catalog";
import { fmtDateLong, fmtNumber } from "../../../i18n/format";

/** The route's locale, read from the ROUTER (never `window.location`): the server
 *  and the client must agree or React discards the tree (#418). */
function useLocale(): Locale {
  const pathname = usePathname();
  return pathname !== null && pathname.startsWith("/en") ? "en" : "fa";
}

type TabKey = "overview" | "users" | "support" | "audit" | "security" | "system" | "analytics";

/** Tab → the permission the SERVER checks. The same list the route layer uses;
 *  if the two ever disagreed the console would show a tab that answers 403. */
const TABS: readonly { key: TabKey; permission: string; labelKey: string }[] = [
  { key: "overview", permission: "overview.view", labelKey: "adminConsole.tab.overview" },
  { key: "users", permission: "users.view", labelKey: "admin.user360.title" },
  { key: "support", permission: "support.tickets.view", labelKey: "adminConsole.support.title" },
  { key: "audit", permission: "audit.view", labelKey: "adminConsole.tab.audit" },
  { key: "security", permission: "audit.view", labelKey: "admin.security.title" },
  { key: "system", permission: "system.health.view", labelKey: "admin.system.title" },
  { key: "analytics", permission: "analytics.view", labelKey: "admin.analytics.title" },
];

/** Component key → label. SEVEN of the nine labels are Legacy's own keys; only the
 *  two subsystems Legacy never had a panel for (`adminConsole.component.*`) are
 *  authored. An unknown component key falls back to the raw key, so a subsystem
 *  added server-side is visible (and obviously unlocalized) rather than omitted. */
function componentLabel(componentKey: string): string {
  switch (componentKey) {
    case "database": return "admin.system.database";
    case "migrations": return "adminConsole.component.migrations";
    case "api": return "admin.system.api";
    case "rate_limiter": return "adminConsole.component.rate_limiter";
    case "worker": return "admin.system.workers";
    case "email": return "admin.system.email";
    case "ai_provider": return "admin.system.ai";
    case "metaapi": return "admin.system.metaapi";
    case "n8n_relay": return "admin.system.n8n_relay";
    default: return componentKey;
  }
}

/** Server enums → Legacy's own labels. SEVEN of the values below are Legacy's
 *  keys (`admin.role.*`, `admin.status.*`, `admin.plan.*`); a value Legacy never
 *  labelled (a plan or status the Modern schema adds later) is shown RAW, because
 *  an operator must SEE a new state rather than an empty cell or a guess. */
const ROLE_LABEL: Readonly<Record<string, string>> = {
  user: "admin.role.user",
  admin: "admin.role.admin",
  super_admin: "admin.role.super_admin",
};
const STATUS_LABEL: Readonly<Record<string, string>> = {
  active: "admin.status.active",
  suspended: "admin.status.suspended",
};
const PLAN_LABEL: Readonly<Record<string, string>> = {
  free: "admin.plan.free",
  pro: "admin.plan.pro",
};
/** Ticket states and message senders are ENUMS, not copy. The queue used to print
 *  the raw value ("open", "admin"), which leaks an English token into the Persian
 *  console while the filter right above it speaks Persian. These maps reuse the
 *  support chunk's own words (the user-facing page uses the same keys), except for
 *  the sender labels: «شما» is the USER's word for itself, so the operator side
 *  reads «پشتیبانی» and the customer side «کاربر» — both keys already exist. */
const TICKET_STATUS_LABEL: Readonly<Record<string, string>> = {
  open: "pages.support.status.open",
  pending: "pages.support.status.awaiting_support",
  closed: "pages.support.status.closed",
  archived: "pages.support.status.archived",
};
const SENDER_LABEL: Readonly<Record<string, string>> = {
  user: "admin.role.user",
  admin: "pages.support.role.support_agent",
};

function enumLabel(t: T, map: Readonly<Record<string, string>>, value: string): string {
  const key = map[value];
  return key === undefined ? value : t(key);
}

const RANGES = ["today", "7d", "30d", "90d", "all"] as const;
const RANGE_LABEL: Readonly<Record<(typeof RANGES)[number], string>> = {
  today: "admin.analytics.rangeToday",
  "7d": "admin.analytics.range7d",
  "30d": "admin.analytics.range30d",
  "90d": "admin.analytics.range90d",
  all: "admin.analytics.rangeAll",
};

function ErrorNote({ text }: { text: string }): React.ReactElement {
  return (
    <p className="text-error text-12" role="alert">
      {text}
    </p>
  );
}

/** A card of KPI cells. `label` is a catalog key, so every label is localized. */
function Kpi({ labelKey, value, t, tone }: { labelKey: string; value: string; t: T; tone?: "kpi-gold" | "kpi-green" | "kpi-blue" }): React.ReactElement {
  return (
    <div className="kpi">
      <div className="kpi-label">{t(labelKey)}</div>
      {/* Latin digits are a shell-level guarantee (`v-latn-num`); the tone class is
          the canonical one the support/dashboard pages already use. */}
      <div className={`kpi-value v-latn-num${tone === undefined ? "" : ` ${tone}`}`}>{value}</div>
    </div>
  );
}

function Breakdown({
  rows,
  locale,
  t,
}: {
  rows: { key: string; count: number }[];
  locale: Locale;
  t: (k: string, p?: null | Record<string, string | number>, f?: string) => string;
}): React.ReactElement {
  if (rows.length === 0) return <p className="muted-sm">{t("admin.user360.empty")}</p>;
  return (
    <div className="flex-wrap flex-gap-8">
      {rows.map((row) => (
        <span className="badge" key={row.key}>
          {row.key} · {fmtNumber(locale, row.count)}
        </span>
      ))}
    </div>
  );
}

export default function Page(): React.ReactElement {
  const locale = useLocale();
  const t = useMemo(() => createTranslator(locale, ["common", "errors", "admin", "support"]), [locale]);
  const [self, setSelf] = useState<{ role: string; isSystemOwner: boolean; permissions: string[] } | null>(null);
  const [selfFailed, setSelfFailed] = useState(false);
  const [tab, setTab] = useState<TabKey>("overview");
  const [toast, setToast] = useState("");

  const allowed = useMemo<Set<string>>(() => new Set(self?.permissions ?? []), [self]);
  const canUse = useCallback((permission: string): boolean => allowed.has(permission), [allowed]);
  const availableTabs = useMemo(() => TABS.filter((entry) => canUse(entry.permission)), [canUse]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await getAdminSelf();
        if (!cancelled) setSelf(view);
      } catch {
        if (!cancelled) setSelfFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the visible tab valid as the permission set arrives.
  useEffect(() => {
    if (availableTabs.length === 0) return;
    if (!availableTabs.some((entry) => entry.key === tab)) setTab(availableTabs[0]!.key);
  }, [availableTabs, tab]);

  const errorText = useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        if (err.code === "FORBIDDEN") return t("admin.user360.permissionDenied");
        if (err.code === "SERVICE_UNAVAILABLE") return t("admin.loadFailed");
        if (err.code === "TOO_MANY_REQUESTS") return t("errors.rateLimited");
        if (err.code === "UNAUTHENTICATED") return t("errors.unauthorized");
        if (err.code === "USER_NOT_FOUND") return t("admin.user360.error");
        if (err.code === "SYSTEM_OWNER_PROTECTED" || err.code === "SELF_ACTION_DENIED" || err.code === "PRIVILEGED_TARGET" || err.code === "SUPER_ADMIN_PEER_PROTECTED") {
          return t("admin.user360.permissionDenied");
        }
        return t("admin.loadFailed");
      }
      return t("admin.loadFailed");
    },
    [t],
  );

  if (selfFailed) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">{t("common.admin.41ae8044", null, "Admin")}</h1>
            <p className="page-sub">{t("admin.forbidden")}</p>
          </div>
        </div>
        <div className="card">
          <p className="text-error text-12">{t("admin.loadFailed")}</p>
        </div>
      </div>
    );
  }

  if (self === null) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">{t("common.admin.41ae8044", null, "Admin")}</h1>
          </div>
        </div>
        <div className="card">
          <p className="muted-sm" role="status">
            {t("admin.analytics.loading")}
          </p>
        </div>
      </div>
    );
  }

  if (availableTabs.length === 0) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1 className="page-title">{t("common.admin.41ae8044", null, "Admin")}</h1>
            <p className="page-sub">{t("admin.forbidden")}</p>
          </div>
        </div>
        <div className="card">
          <p className="muted-sm">{t("admin.forbidden")}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("admin.analytics.title")}</h1>
          <p className="page-sub">{t("admin.analytics.subtitle")}</p>
        </div>
        <span className="badge">
          {self.role}
          {self.isSystemOwner ? ` · ${t("admin.security.currentRole")}` : ""}
        </span>
      </div>

      {toast === "" ? null : (
        <div className="card card-alt mt-8" role="status">
          <span className="muted-sm">{toast}</span>
        </div>
      )}

      <div className="flex-wrap flex-gap-8 mt-8" role="tablist" aria-label={t("admin.analytics.title")}>
        {availableTabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={`btn-${tab === entry.key ? "primary" : "ghost"} btn-sm`}
            id={`adm-tab-${entry.key}`}
            onClick={() => {
              setToast("");
              setTab(entry.key);
            }}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      <div className="mt-12">
        {tab === "overview" ? <OverviewTab locale={locale} t={t} errorText={errorText} /> : null}
        {tab === "users" ? (
          <UsersTab locale={locale} t={t} errorText={errorText} canManage={canUse("users.manage_status")} canVerify={canUse("users.verify_email")} canChangeRole={canUse("users.change_role")} canReadAudit={canUse("audit.view")} onToast={setToast} />
        ) : null}
        {tab === "support" ? <SupportTab locale={locale} t={t} errorText={errorText} onToast={setToast} /> : null}
        {tab === "audit" ? <AuditTab locale={locale} t={t} errorText={errorText} /> : null}
        {tab === "security" ? <SecurityTab locale={locale} t={t} errorText={errorText} /> : null}
        {tab === "system" ? <SystemTab locale={locale} t={t} errorText={errorText} /> : null}
        {tab === "analytics" ? <AnalyticsTab locale={locale} t={t} errorText={errorText} /> : null}
      </div>
    </div>
  );
}

type T = (key: string, params?: null | Record<string, string | number>, fallback?: string) => string;

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ locale, t, errorText }: { locale: Locale; t: T; errorText: (e: unknown) => string }): React.ReactElement {
  const [data, setData] = useState<AdminOverviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setData(await getAdminOverview());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [errorText]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div className="card"><p className="muted-sm" role="status">{t("admin.analytics.loading")}</p></div>;
  if (error !== null) return <div className="card"><ErrorNote text={error} /></div>;
  if (data === null) return <div className="card"><p className="muted-sm">{t("admin.analytics.empty")}</p></div>;

  return (
    <div>
      <div className="kpi-grid" id="adm-overview-kpis">
        <Kpi labelKey="admin.totalUsers" value={fmtNumber(locale, data.users.total)} t={t} />
        <Kpi labelKey="admin.regularUsers" value={fmtNumber(locale, data.users.total - data.users.admins - data.users.superAdmins)} t={t} />
        <Kpi labelKey="admin.role.admin" value={fmtNumber(locale, data.users.admins + data.users.superAdmins)} t={t} tone="kpi-gold" />
        <Kpi labelKey="admin.suspended" value={fmtNumber(locale, data.users.suspended)} t={t} tone="kpi-green" />
        <Kpi labelKey="admin.totalTrades" value={fmtNumber(locale, data.trading.trades)} t={t} />
        <Kpi labelKey="admin.analytics.tradingAccounts" value={fmtNumber(locale, data.trading.accounts)} t={t} tone="kpi-blue" />
      </div>

      <div className="grid-3 mt-16">
        <div className="card">
          <h3 className="label text-gold">{t("admin.analytics.sectionUsers")}</h3>
          <div className="mt-8 text-12">
            <div className="flex-between">
              <span className="muted-sm">{t("admin.analytics.totalUsers")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.users.total)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("admin.analytics.activeUsers")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.users.active)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("admin.analytics.newUsers")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.users.newLast7Days)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("admin.system.verified")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.users.verified)}</span>
            </div>
          </div>
          <div className="mt-12">
            <span className="muted-sm">{t("admin.user360.plan")}</span>
            <Breakdown rows={data.users.byPlan} locale={locale} t={t} />
          </div>
        </div>

        <div className="card">
          <h3 className="label text-gold">{t("admin.analytics.sectionTrading")}</h3>
          <div className="mt-8 text-12">
            <div className="flex-between">
              <span className="muted-sm">{t("admin.analytics.totalTrades")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.trading.trades)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("admin.analytics.tradingAccounts")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.trading.connectedAccounts)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("admin.system.status.degraded")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.trading.accountsWithSyncError)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("admin.analytics.netPnl")}</span>
              <span className="v-latn-num ts-mixed">{data.trading.netPnl}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("admin.plan.title")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.subscriptions.active)}</span>
            </div>
          </div>
          <p className="muted-sm mt-12">{t("admin.analytics.tradingNote")}</p>
        </div>

        <div className="card">
          <h3 className="label text-gold">{t("adminConsole.support.title")}</h3>
          <div className="mt-8 text-12">
            <div className="flex-between">
              <span className="muted-sm">{t("pages.support.status.open")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.support.open)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("pages.support.status.awaiting_support")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.support.pending)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("pages.support.status.closed")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.support.closed)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("admin.user360.tradingAccounts")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.support.unreadForAdmins)}</span>
            </div>
            <div className="flex-between mt-8">
              <span className="muted-sm">{t("adminConsole.telegram")}</span>
              <span className="v-latn-num">{fmtNumber(locale, data.telegram.linkedAccounts)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-gap-8 mt-12">
        <button className="btn-ghost btn-sm" type="button" onClick={() => void load()}>
          {t("admin.analytics.refresh")}
        </button>
      </div>
    </div>
  );
}

// ── Users ───────────────────────────────────────────────────────────────────

function UsersTab({
  locale,
  t,
  errorText,
  canManage,
  canVerify,
  canChangeRole,
  canReadAudit,
  onToast,
}: {
  locale: Locale;
  t: T;
  errorText: (e: unknown) => string;
  canManage: boolean;
  canVerify: boolean;
  canChangeRole: boolean;
  canReadAudit: boolean;
  onToast: (s: string) => void;
}): React.ReactElement {
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<AdminUserRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const view = await listAdminUsers({
        ...(search.trim() === "" ? {} : { search: search.trim() }),
        ...(role === "" ? {} : { role }),
        ...(status === "" ? {} : { status }),
        page,
      });
      setRows(view.items);
      setTotal(view.total);
    } catch (err) {
      setError(errorText(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [errorText, page, role, search, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="card">
        <div className="flex-wrap flex-gap-8">
          <input
            className="input"
            id="adm-user-search"
            placeholder={t("adminConsole.searchUsers")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <select
            className="input"
            id="adm-user-role"
            aria-label={t("admin.user360.role")}
            value={role}
            onChange={(e) => {
              setRole(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t("admin.user360.role")}</option>
            <option value="user">{enumLabel(t, ROLE_LABEL, "user")}</option>
            <option value="admin">{enumLabel(t, ROLE_LABEL, "admin")}</option>
            <option value="super_admin">{enumLabel(t, ROLE_LABEL, "super_admin")}</option>
          </select>
          <select
            className="input"
            id="adm-user-status"
            aria-label={t("admin.user360.status")}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t("admin.user360.status")}</option>
            <option value="active">{enumLabel(t, STATUS_LABEL, "active")}</option>
            <option value="suspended">{enumLabel(t, STATUS_LABEL, "suspended")}</option>
          </select>
          <button className="btn-primary btn-sm" type="button" onClick={() => void load()}>
            {t("admin.logs.apply")}
          </button>
        </div>
      </div>

      {error !== null ? (
        <div className="card mt-8">
          <ErrorNote text={error} />
        </div>
      ) : null}

      <div className="card mt-8">
        {loading ? (
          <p className="muted-sm" role="status">
            {t("admin.analytics.loading")}
          </p>
        ) : rows.length === 0 ? (
          <p className="muted-sm" id="adm-users-empty">
            {t("admin.noUsers")}
          </p>
        ) : (
          <div className="overflow-auto">
            <table className="table" id="adm-users-table">
            <thead>
              <tr>
                <th>{t("admin.user360.email")}</th>
                <th>{t("admin.user360.role")}</th>
                <th>{t("admin.user360.status")}</th>
                <th>{t("admin.user360.plan")}</th>
                <th>{t("admin.user360.createdAt")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="clickable" onClick={() => setSelected(row)}>
                  <td>
                    <span className="v-latn-num">{row.email}</span>
                  </td>
                  <td>
                    <span className="badge">{enumLabel(t, ROLE_LABEL, row.role)}</span>
                  </td>
                  <td>
                    <span className={`badge${row.status === "suspended" ? " badge-error" : ""}`}>{enumLabel(t, STATUS_LABEL, row.status)}</span>
                  </td>
                  <td>{enumLabel(t, PLAN_LABEL, row.plan)}</td>
                  <td className="ts-mixed">{fmtDateLong(locale, row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        <div className="flex-between mt-12">
          <span className="muted-sm">{t("admin.usersShown", { count: fmtNumber(locale, total) })}</span>
          <span className="flex-gap-8">
            <button
              className="btn-ghost btn-sm"
              type="button"
              id="adm-users-prev"
              disabled={page === 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {t("admin.previous")}
            </button>
            <span className="muted-sm v-latn-num">{fmtNumber(locale, page)}</span>
            <button
              className="btn-ghost btn-sm"
              type="button"
              id="adm-users-next"
              disabled={page * 25 >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              {t("admin.next")}
            </button>
          </span>
        </div>
      </div>

      {selected === null ? null : (
        <UserDetail
          user={selected}
          locale={locale}
          t={t}
          errorText={errorText}
          canManage={canManage}
          canVerify={canVerify}
          canChangeRole={canChangeRole}
          canReadAudit={canReadAudit}
          onToast={onToast}
          onClose={() => setSelected(null)}
          onChanged={(updated) => {
            setSelected(updated);
            void load();
          }}
        />
      )}
    </div>
  );
}

function UserDetail({
  user,
  locale,
  t,
  errorText,
  canManage,
  canVerify,
  canChangeRole,
  canReadAudit,
  onToast,
  onClose,
  onChanged,
}: {
  user: AdminUserRow;
  locale: Locale;
  t: T;
  errorText: (e: unknown) => string;
  canManage: boolean;
  canVerify: boolean;
  canChangeRole: boolean;
  canReadAudit: boolean;
  onToast: (s: string) => void;
  onClose: () => void;
  onChanged: (u: AdminUserRow) => void;
}): React.ReactElement {
  const [sessions, setSessions] = useState<AdminSessionRow[]>([]);
  const [sensitive, setSensitive] = useState(false);
  const [devices, setDevices] = useState<{ id: string; fingerprint: string; firstSeen: string; lastSeen: string }[]>([]);
  const [accounts, setAccounts] = useState<AdminAccountRow[]>([]);
  const [trades, setTrades] = useState<AdminTradeRow[]>([]);
  const [audit, setAudit] = useState<AdminAuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [s, d, a, tr, au] = await Promise.all([
        getUserSessions(user.id),
        getUserDevices(user.id),
        getUserAccounts(user.id),
        getUserTrades(user.id),
        canReadAudit ? listAuditLog({ targetUserId: user.id, limit: 20 }) : Promise.resolve({ entries: [], total: 0, limit: 0 }),
      ]);
      setSessions(s.items);
      setSensitive(s.sensitive);
      setDevices(d.items);
      setAccounts(a.items);
      setTrades(tr.items);
      setAudit(au.entries);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [canReadAudit, errorText, user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, message: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        onToast(message);
        await load();
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(false);
      }
    },
    [errorText, load, onToast],
  );

  return (
    <div className="card mt-12" id="adm-user-detail">
      <div className="flex-between">
        <h3 className="label text-gold">{t("admin.user360.identity")}</h3>
        <button className="btn-ghost btn-sm" type="button" onClick={onClose}>
          {t("admin.user360.back")}
        </button>
      </div>

      <div className="mt-8 text-12">
        <div className="flex-between">
          <span className="muted-sm">{t("admin.user360.email")}</span>
          <span className="v-latn-num" id="adm-user-email">
            {user.email}
          </span>
        </div>
        <div className="flex-between mt-8">
          <span className="muted-sm">{t("admin.security.currentRole")}</span>
          <span className="badge">{enumLabel(t, ROLE_LABEL, user.role)}</span>
        </div>
        <div className="flex-between mt-8">
          <span className="muted-sm">{t("admin.user360.status")}</span>
          <span className={`badge${user.status === "suspended" ? " badge-error" : ""}`}>{enumLabel(t, STATUS_LABEL, user.status)}</span>
        </div>
        <div className="flex-between mt-8">
          <span className="muted-sm">{t("admin.user360.createdAt")}</span>
          <span className="ts-mixed">{fmtDateLong(locale, user.createdAt)}</span>
        </div>
        <div className="flex-between mt-8">
          <span className="muted-sm">{t("admin.user360.locale")}</span>
          <span>{user.locale}</span>
        </div>
        <div className="flex-between mt-8">
          <span className="muted-sm">{t("admin.user360.plan")}</span>
          <span>{enumLabel(t, PLAN_LABEL, user.plan)}</span>
        </div>
      </div>

      {error !== null ? (
        <div className="mt-8">
          <ErrorNote text={error} />
        </div>
      ) : null}

      <div className="flex-wrap flex-gap-8 mt-12">
        {canManage ? (
          <button
            className="btn-primary btn-sm"
            type="button"
            id="adm-user-toggle-status"
            disabled={busy}
            onClick={() =>
              void act(
                async () => {
                  const next = user.status === "active" ? "suspended" : "active";
                  const res = await setUserStatus(user.id, next);
                  onChanged(res.user);
                },
                user.status === "active" ? t("admin.user360.suspended") : t("admin.user360.activated"),
              )
            }
          >
            {user.status === "active" ? t("admin.user360.suspend") : t("admin.user360.activate")}
          </button>
        ) : null}
        {canManage ? (
          <button
            className="btn-ghost btn-sm"
            type="button"
            id="adm-user-revoke-all"
            disabled={busy}
            onClick={() => void act(() => revokeUserSessions(user.id), t("admin.user360.sessionsRevoked"))}
          >
            {t("admin.user360.revokeSessions")}
          </button>
        ) : null}
        {canVerify ? (
          <button
            className="btn-ghost btn-sm"
            type="button"
            id="adm-user-verify-email"
            disabled={busy}
            onClick={() => void act(() => verifyUserEmail(user.id), t("adminConsole.emailVerified"))}
          >
            {t("adminConsole.verifyEmail")}
          </button>
        ) : null}
        {canChangeRole ? (
          <button
            className="btn-ghost btn-sm"
            type="button"
            id="adm-user-toggle-role"
            disabled={busy}
            onClick={() =>
              void act(
                async () => {
                  const next = user.role === "admin" ? "user" : "admin";
                  const res = await setUserRole(user.id, next);
                  onChanged(res.user);
                },
                t("admin.user360.roleAssigned"),
              )
            }
          >
            {t("admin.user360.changeRole")}
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="muted-sm mt-12" role="status">
          {t("admin.user360.loading")}
        </p>
      ) : (
        <div className="grid-2 mt-12">
          <div>
            <h4 className="label">{t("admin.user360.activeSessions")}</h4>
            <p className="muted-sm text-12">{sensitive ? t("admin.user360.ip") : t("adminConsole.sensitiveHidden")}</p>
            {sessions.length === 0 ? (
              <p className="muted-sm mt-8" id="adm-sessions-empty">
                {t("admin.user360.empty")}
              </p>
            ) : (
              <div className="overflow-auto">
                <table className="table" id="adm-sessions-table">
                <thead>
                  <tr>
                    <th>{t("admin.user360.createdAt")}</th>
                    <th>{t("admin.user360.ip")}</th>
                    <th>{t("admin.user360.status")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id}>
                      <td className="ts-mixed">{fmtDateLong(locale, session.createdAt)}</td>
                      <td className="v-latn-num">{sensitive ? (session.ipAddress ?? "—") : t("admin.user360.notAvailable")}</td>
                      <td>
                        <span className={`badge${session.revokedAt === null ? "" : " badge-error"}`}>
                          {session.revokedAt === null ? t("admin.user360.resultActive") : t("admin.user360.resultRevoked")}
                        </span>
                      </td>
                      <td>
                        {canManage && session.revokedAt === null ? (
                          <button
                            className="btn-ghost btn-sm"
                            type="button"
                            disabled={busy}
                            onClick={() => void act(() => revokeUserSessions(user.id, session.id), t("admin.user360.sessionsRevoked"))}
                          >
                            {t("adminConsole.revokeSession")}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}

            <h4 className="label mt-12">{t("admin.user360.knownDevices")}</h4>
            {devices.length === 0 ? (
              <p className="muted-sm mt-8" id="adm-devices-empty">
                {t("admin.user360.empty")}
              </p>
            ) : (
              <div className="overflow-auto">
                <table className="table" id="adm-devices-table">
                <thead>
                  <tr>
                    <th>{t("admin.user360.knownDevices")}</th>
                    <th>{t("admin.user360.lastLoginAt")}</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((device) => (
                    <tr key={device.id}>
                      <td className="v-latn-num">{device.fingerprint}</td>
                      <td className="ts-mixed">{fmtDateLong(locale, device.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>

          <div>
            <h4 className="label">{t("admin.user360.tradingAccounts")}</h4>
            {accounts.length === 0 ? (
              <p className="muted-sm mt-8" id="adm-accounts-empty">
                {t("admin.user360.accountsEmpty")}
              </p>
            ) : (
              <div className="overflow-auto">
                <table className="table" id="adm-accounts-table">
                <thead>
                  <tr>
                    <th>{t("admin.user360.accAccount")}</th>
                    <th>{t("admin.user360.accStatus")}</th>
                    <th>{t("adminConsole.balance")}</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => (
                    <tr key={account.id}>
                      <td>{account.label}</td>
                      <td>
                        <span className="badge">{account.syncStatus}</span>
                      </td>
                      <td className="v-latn-num ts-mixed">{account.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}

            <h4 className="label mt-12">{t("admin.user360.trades")}</h4>
            {trades.length === 0 ? (
              <p className="muted-sm mt-8" id="adm-trades-empty">
                {t("admin.user360.empty")}
              </p>
            ) : (
              <div className="overflow-auto">
                <table className="table" id="adm-trades-table">
                <thead>
                  <tr>
                    <th>{t("admin.analytics.bySymbol")}</th>
                    <th>{t("admin.analytics.byDirection")}</th>
                    <th>{t("admin.analytics.netPnl")}</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => (
                    <tr key={trade.id}>
                      <td className="v-latn-num">{trade.symbol}</td>
                      <td>{trade.direction}</td>
                      <td className="v-latn-num ts-mixed">{trade.netPnl ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}

            {canReadAudit ? (
              <>
                <h4 className="label mt-12">{t("admin.user360.auditHistory")}</h4>
                {audit.length === 0 ? (
                  <p className="muted-sm mt-8" id="adm-audit-empty">
                    {t("admin.user360.auditEmpty")}
                  </p>
                ) : (
                  <div className="overflow-auto">
                    <table className="table" id="adm-user-audit-table">
                    <thead>
                      <tr>
                        <th>{t("admin.user360.auditAction")}</th>
                        <th>{t("admin.user360.auditActor")}</th>
                        <th>{t("admin.security.time")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.map((entry) => (
                        <tr key={entry.id}>
                          <td className="v-latn-num">{entry.action}</td>
                          <td className="v-latn-num">{entry.actorEmail ?? entry.actorUserId}</td>
                          <td className="ts-mixed">{fmtDateLong(locale, entry.occurredAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Support queue ───────────────────────────────────────────────────────────

function SupportTab({ locale, t, errorText, onToast }: { locale: Locale; t: T; errorText: (e: unknown) => string; onToast: (s: string) => void }): React.ReactElement {
  const [rows, setRows] = useState<SupportQueueTicketView[]>([]);
  const [counters, setCounters] = useState({ open: 0, pending: 0, unread: 0 });
  const [status, setStatus] = useState("");
  const [thread, setThread] = useState<{ id: string; subject: string; status: string; messages: { id: string; senderType: string; body: string; createdAt: string }[] } | null>(null);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const view = await listSupportQueue(status === "" ? undefined : (status as "open" | "pending" | "closed" | "archived"));
      setRows(view.tickets);
      setCounters(view.counters);
    } catch (err) {
      setError(errorText(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [errorText, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(
    async (id: string): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const view = await getSupportQueueTicket(id);
        setThread({
          id: view.conversation.id,
          subject: view.conversation.subject,
          status: view.conversation.status,
          messages: view.messages,
        });
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(false);
      }
    },
    [errorText],
  );

  return (
    <div>
      <div className="kpi-grid" id="adm-support-kpis">
        <Kpi labelKey="pages.support.kpi.open_tickets" value={fmtNumber(locale, counters.open)} t={t} />
        <Kpi labelKey="pages.support.status.awaiting_support" value={fmtNumber(locale, counters.pending)} t={t} tone="kpi-blue" />
        <Kpi labelKey="pages.support.badge.unread" value={fmtNumber(locale, counters.unread)} t={t} tone="kpi-gold" />
      </div>

      <div className="card mt-12">
        <div className="flex-wrap flex-gap-8">
          <select
            className="input"
            id="adm-support-status"
            aria-label={t("admin.user360.status")}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">{t("admin.user360.status")}</option>
            <option value="open">{t("pages.support.status.open")}</option>
            <option value="pending">{t("pages.support.status.awaiting_support")}</option>
            <option value="closed">{t("pages.support.status.closed")}</option>
            <option value="archived">{t("pages.support.status.archived")}</option>
          </select>
          <button className="btn-ghost btn-sm" type="button" onClick={() => void load()}>
            {t("admin.analytics.refresh")}
          </button>
        </div>
      </div>

      {error !== null ? (
        <div className="card mt-8">
          <ErrorNote text={error} />
        </div>
      ) : null}

      <div className="card mt-8">
        {loading ? (
          <p className="muted-sm" role="status">
            {t("admin.analytics.loading")}
          </p>
        ) : rows.length === 0 ? (
          <p className="muted-sm" id="adm-support-empty">
            {t("admin.logs.empty")}
          </p>
        ) : (
          <div className="overflow-auto">
            <table className="table" id="adm-support-table">
            <thead>
              <tr>
                <th>{t("pages.support.label.subject")}</th>
                <th>{t("admin.user360.status")}</th>
                <th>{t("pages.support.badge.unread")}</th>
                <th>{t("admin.security.time")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="clickable" onClick={() => void open(row.id)}>
                  <td>
                    <span className="v-latn-num">#{row.id}</span> — {row.subject}
                  </td>
                  <td>
                    <span className="badge">{enumLabel(t, TICKET_STATUS_LABEL, row.status)}</span>
                  </td>
                  <td className="v-latn-num">{fmtNumber(locale, row.unreadAdminCount)}</td>
                  <td className="ts-mixed">{fmtDateLong(locale, row.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {thread === null ? null : (
        <div className="card mt-12" id="adm-support-thread">
          <div className="flex-between">
            <h3 className="label text-gold">
              <span className="v-latn-num">#{thread.id}</span> — {thread.subject}
            </h3>
            <span className="badge">{enumLabel(t, TICKET_STATUS_LABEL, thread.status)}</span>
          </div>

          <div className="mt-12">
            {thread.messages.map((message) => (
              <div key={message.id} className={`thread-msg ${message.senderType === "admin" ? "bubble bubble-mine" : "bubble bubble-support"}`}>
                <div className="text-12">{message.body}</div>
                <div className="muted-sm text-12 mt-8">
                  <span className={message.senderType === "admin" ? "role-mine" : "role-support"}>{enumLabel(t, SENDER_LABEL, message.senderType)}</span> ·{" "}
                  <span className="ts-mixed">{fmtDateLong(locale, message.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* The service owns the state machine (supportService.supportSetStatus /
              supportReply): a reply to an ARCHIVED ticket is a 422, closing a
              CLOSED ticket is a 409, archiving an OPEN ticket is a 422. Rendering
              every button always meant the console offered actions that could
              only fail, and hiding the reply box for a closed ticket matches the
              user-facing page from phase 5. */}
          {thread.status === "archived" ? null : (
          <div className="mt-12">
            <textarea
              className="input"
              id="adm-support-reply"
              rows={3}
              placeholder={t("adminConsole.replyPlaceholder")}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
            <label className="flex-gap-8 mt-8 text-12">
              <input type="checkbox" id="adm-support-internal" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
              <span className="muted-sm">{t("adminConsole.internalNote")}</span>
            </label>
            <div className="flex-wrap flex-gap-8 mt-8">
              <button
                className="btn-primary btn-sm"
                type="button"
                id="adm-support-send"
                disabled={busy || reply.trim() === ""}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await replySupportQueueTicket(thread.id, reply.trim(), internal);
                      setReply("");
                      setInternal(false);
                      onToast(t("adminConsole.replied"));
                      await open(thread.id);
                      await load();
                    } catch (err) {
                      setError(errorText(err));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                {t("adminConsole.send")}
              </button>
            </div>
          </div>
          )}

          <div className="flex-wrap flex-gap-8 mt-8">
            {thread.status === "open" || thread.status === "pending" ? (
              <button
                className="btn-ghost btn-sm"
                type="button"
                id="adm-support-close"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      await actOnSupportQueueTicket(thread.id, "close");
                      onToast(t("adminConsole.closed"));
                      await load();
                      // stay on the record: a CLOSED ticket is the only state
                      // archive is legal from, and dismissing the thread made the
                      // operator hunt the ticket down again to reach it.
                      await open(thread.id);
                    } catch (err) {
                      setError(errorText(err));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                {t("adminConsole.closeTicket")}
              </button>
            ) : null}
            {thread.status === "closed" || thread.status === "archived" ? (
              <button
                className="btn-ghost btn-sm"
                type="button"
                id="adm-support-reopen"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      await actOnSupportQueueTicket(thread.id, "reopen");
                      onToast(t("adminConsole.reopened"));
                      await load();
                      await open(thread.id);
                    } catch (err) {
                      setError(errorText(err));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                {t("pages.support.action.reopen_ticket")}
              </button>
            ) : null}
            {thread.status === "closed" ? (
              <button
                className="btn-ghost btn-sm"
                type="button"
                id="adm-support-archive"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      await actOnSupportQueueTicket(thread.id, "archive");
                      onToast(t("adminConsole.closed"));
                      await load();
                      await open(thread.id);
                    } catch (err) {
                      setError(errorText(err));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                {t("adminConsole.archiveTicket")}
              </button>
            ) : null}
            <button className="btn-ghost btn-sm" type="button" onClick={() => setThread(null)}>
              {t("admin.user360.back")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Audit ───────────────────────────────────────────────────────────────────

function AuditTab({ locale, t, errorText }: { locale: Locale; t: T; errorText: (e: unknown) => string }): React.ReactElement {
  const [rows, setRows] = useState<AdminAuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [target, setTarget] = useState("");
  const [since, setSince] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const view = await listAuditLog({
        ...(action.trim() === "" ? {} : { action: action.trim() }),
        ...(actor.trim() === "" ? {} : { actorUserId: actor.trim() }),
        ...(target.trim() === "" ? {} : { targetUserId: target.trim() }),
        ...(since.trim() === "" ? {} : { since: since.trim() }),
        limit: 50,
      });
      setRows(view.entries);
      setTotal(view.total);
    } catch (err) {
      setError(errorText(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [action, actor, errorText, since, target]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="card">
        <div className="flex-wrap flex-gap-8">
          <input className="input" id="adm-audit-action" placeholder={t("admin.user360.auditAction")} value={action} onChange={(e) => setAction(e.target.value)} />
          <input className="input" id="adm-audit-actor" placeholder={t("admin.user360.auditActor")} value={actor} onChange={(e) => setActor(e.target.value)} />
          <input className="input" id="adm-audit-target" placeholder={t("admin.logs.userId")} value={target} onChange={(e) => setTarget(e.target.value)} />
          <input className="input" id="adm-audit-since" placeholder={t("admin.logs.since")} value={since} onChange={(e) => setSince(e.target.value)} />
          <button className="btn-primary btn-sm" type="button" id="adm-audit-apply" onClick={() => void load()}>
            {t("admin.logs.apply")}
          </button>
        </div>
      </div>

      {error !== null ? (
        <div className="card mt-8">
          <ErrorNote text={error} />
        </div>
      ) : null}

      <div className="card mt-8">
        {loading ? (
          <p className="muted-sm" role="status">
            {t("admin.analytics.loading")}
          </p>
        ) : rows.length === 0 ? (
          <p className="muted-sm" id="adm-audit-log-empty">
            {t("admin.user360.auditEmpty")}
          </p>
        ) : (
          <>
            <div className="overflow-auto">
              <table className="table" id="adm-audit-table">
              <thead>
                <tr>
                  <th>{t("admin.user360.auditAction")}</th>
                  <th>{t("admin.user360.auditActor")}</th>
                  <th>{t("admin.logs.userId")}</th>
                  <th>{t("admin.user360.result")}</th>
                  <th>{t("admin.security.time")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="v-latn-num">{row.action}</td>
                    <td className="v-latn-num">{row.actorEmail ?? row.actorUserId}</td>
                    <td className="v-latn-num">{row.targetEmail ?? row.targetUserId ?? "—"}</td>
                    <td className="v-latn-num">{[row.beforeState, row.afterState].filter((v) => v !== null && v !== undefined).join(" → ") || "—"}</td>
                    <td className="ts-mixed">{fmtDateLong(locale, row.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <p className="muted-sm mt-8">{t("admin.usersShown", { count: fmtNumber(locale, total) })}</p>
          </>
        )}
      </div>
    </div>
  );
}

// ── Security feeds ──────────────────────────────────────────────────────────

function SecurityTab({ locale, t, errorText }: { locale: Locale; t: T; errorText: (e: unknown) => string }): React.ReactElement {
  const [kind, setKind] = useState<"signups" | "logins">("logins");
  const [result, setResult] = useState("");
  const [rows, setRows] = useState<AdminSecurityRow[]>([]);
  const [sensitive, setSensitive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const view = await listSecurityFeed(kind, result === "" ? {} : { result });
      setRows(view.items);
      setSensitive(view.sensitive);
    } catch (err) {
      setError(errorText(err));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [errorText, kind, result]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="card">
        <div className="flex-wrap flex-gap-8">
          <select className="input" id="adm-security-kind" aria-label={t("admin.security.event")} value={kind} onChange={(e) => setKind(e.target.value as "signups" | "logins")}>
            <option value="logins">{t("adminConsole.logins")}</option>
            <option value="signups">{t("adminConsole.signups")}</option>
          </select>
          <select className="input" id="adm-security-result" aria-label={t("admin.security.result")} value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">{t("admin.security.result")}</option>
            <option value="success">{t("admin.analytics.success")}</option>
            <option value="failure">{t("admin.analytics.failed")}</option>
          </select>
          <button className="btn-ghost btn-sm" type="button" onClick={() => void load()}>
            {t("admin.security.refresh")}
          </button>
        </div>
        <p className="muted-sm mt-8 text-12" id="adm-security-sensitive-note">
          {sensitive ? t("adminConsole.sensitiveVisible") : t("adminConsole.sensitiveHidden")}
        </p>
      </div>

      {error !== null ? (
        <div className="card mt-8">
          <ErrorNote text={error} />
        </div>
      ) : null}

      <div className="card mt-8">
        {loading ? (
          <p className="muted-sm" role="status">
            {t("admin.analytics.loading")}
          </p>
        ) : rows.length === 0 ? (
          <p className="muted-sm" id="adm-security-empty">
            {t("admin.security.noActions")}
          </p>
        ) : (
          <div className="overflow-auto">
            <table className="table" id="adm-security-table">
            <thead>
              <tr>
                <th>{t("admin.security.event")}</th>
                <th>{t("admin.user360.email")}</th>
                <th>{t("admin.security.result")}</th>
                <th>{t("admin.user360.ip")}</th>
                <th>{t("admin.security.time")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.eventType}</td>
                  <td className="v-latn-num">{row.email ?? "—"}</td>
                  <td>
                    <span className={`badge${row.result === "failure" ? " badge-error" : ""}`}>{row.result}</span>
                  </td>
                  {/* The KEY is absent for a caller without audit.view_sensitive, so
                      the cell says "not available to you" rather than drawing a
                      blank that reads like "nothing was recorded". */}
                  <td className="v-latn-num">{sensitive ? (row.ipAddress ?? "—") : t("admin.user360.notAvailable")}</td>
                  <td className="ts-mixed">{fmtDateLong(locale, row.occurredAt)}</td>
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

// ── System health ───────────────────────────────────────────────────────────

function SystemTab({ locale, t, errorText }: { locale: Locale; t: T; errorText: (e: unknown) => string }): React.ReactElement {
  const [data, setData] = useState<AdminHealthView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setData(await getAdminHealth());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [errorText]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div className="card"><p className="muted-sm" role="status">{t("admin.analytics.loading")}</p></div>;
  if (error !== null) return <div className="card"><ErrorNote text={error} /></div>;
  if (data === null) return <div className="card"><p className="muted-sm">{t("admin.analytics.empty")}</p></div>;

  const statusKey = (status: string): string =>
    status === "healthy"
      ? "admin.system.status.healthy"
      : status === "degraded"
        ? "admin.system.status.degraded"
        : status === "unhealthy"
          ? "admin.system.status.unhealthy"
          : status === "not_configured"
            ? "admin.system.status.notConfigured"
            : status === "not_applicable"
              ? "admin.system.status.notApplicable"
              : "admin.system.status.unknown";

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-title">{t("admin.system.title")}</h2>
          <p className="page-sub">{t("admin.system.subtitle")}</p>
        </div>
        <span className="badge" id="adm-health-overall">
          {t(statusKey(data.overall))}
        </span>
      </div>

      <div className="card mt-8">
        <p className="muted-sm">
          {t("admin.system.checkedAt", { time: fmtDateLong(locale, data.checkedAt) })}
        </p>
        <div className="overflow-auto">
          <table className="table mt-8" id="adm-health-table">
          <thead>
            <tr>
              <th>{t("admin.system.components")}</th>
              <th>{t("admin.user360.status")}</th>
              <th>{t("admin.logs.message")}</th>
            </tr>
          </thead>
          <tbody>
            {data.components.map((component) => (
              <tr key={component.key}>
                <td>{t(componentLabel(component.key))}</td>
                <td>
                  <span className={`badge${component.status === "unhealthy" ? " badge-error" : ""}`}>
                    {t(statusKey(component.status))}
                  </span>
                </td>
                <td className="v-latn-num text-12">{component.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className="card mt-8">
        <h3 className="label text-gold">{t("admin.system.database")}</h3>
        <div className="mt-8 text-12">
          <div className="flex-between">
            <span className="muted-sm">{t("adminConsole.fact.migrations")}</span>
            <span className="v-latn-num">
              {fmtNumber(locale, data.facts.appliedMigrations)}
              {data.facts.expectedMigrations === null ? "" : ` / ${fmtNumber(locale, data.facts.expectedMigrations)}`}
            </span>
          </div>
          <div className="flex-between mt-8">
            <span className="muted-sm">{t("adminConsole.fact.head")}</span>
            <span className="v-latn-num">{data.facts.migrationHead ?? "—"}</span>
          </div>
          <div className="flex-between mt-8">
            <span className="muted-sm">{t("adminConsole.fact.tables")}</span>
            <span className="v-latn-num">{fmtNumber(locale, data.facts.tables)}</span>
          </div>
          <div className="flex-between mt-8">
            <span className="muted-sm">{t("adminConsole.fact.auditRows")}</span>
            <span className="v-latn-num">{fmtNumber(locale, data.facts.auditRows)}</span>
          </div>
          <div className="flex-between mt-8">
            <span className="muted-sm">{t("adminConsole.fact.authEvents")}</span>
            <span className="v-latn-num">{fmtNumber(locale, data.facts.authEvents)}</span>
          </div>
          <div className="flex-between mt-8">
            <span className="muted-sm">{t("admin.system.api")}</span>
            <span className="v-latn-num">
              {data.facts.nodeVersion} · {fmtNumber(locale, data.facts.processUptimeSeconds)}s
            </span>
          </div>
        </div>
        <div className="flex-gap-8 mt-12">
          <button className="btn-ghost btn-sm" type="button" id="adm-health-refresh" onClick={() => void load()}>
            {t("admin.system.refresh")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Analytics ───────────────────────────────────────────────────────────────

function AnalyticsTab({ locale, t, errorText }: { locale: Locale; t: T; errorText: (e: unknown) => string }): React.ReactElement {
  const [range, setRange] = useState<string>("30d");
  const [users, setUsers] = useState<AdminUsersAnalyticsView | null>(null);
  const [trading, setTrading] = useState<AdminTradingAnalyticsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [u, tr] = await Promise.all([getAdminUsersAnalytics(range), getAdminTradingAnalytics(range)]);
      setUsers(u);
      setTrading(tr);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [errorText, range]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="card">
        <div className="flex-wrap flex-gap-8">
          {RANGES.map((preset) => (
            <button
              key={preset}
              type="button"
              id={`adm-range-${preset}`}
              className={`btn-${range === preset ? "primary" : "ghost"} btn-sm`}
              aria-pressed={range === preset}
              onClick={() => setRange(preset)}
            >
              {t(RANGE_LABEL[preset])}
            </button>
          ))}
          <button className="btn-ghost btn-sm" type="button" id="adm-analytics-refresh" onClick={() => void load()}>
            {t("admin.analytics.refresh")}
          </button>
        </div>
        {users === null ? null : (
          <p className="muted-sm mt-8">
            {fmtDateLong(locale, users.range.from)} — {fmtDateLong(locale, users.range.to)}
          </p>
        )}
      </div>

      {error !== null ? (
        <div className="card mt-8">
          <ErrorNote text={error} />
        </div>
      ) : null}

      {loading ? (
        <div className="card mt-8">
          <p className="muted-sm" role="status">
            {t("admin.analytics.loading")}
          </p>
        </div>
      ) : (
        <>
          {users === null ? null : (
            <div className="card mt-8">
              <h3 className="label text-gold">{t("admin.analytics.sectionUsers")}</h3>
              <div className="kpi-grid mt-8">
                <Kpi labelKey="admin.analytics.totalUsers" value={fmtNumber(locale, users.totals.total)} t={t} />
                <Kpi labelKey="admin.analytics.newUsers" value={fmtNumber(locale, users.totals.newInRange)} t={t} tone="kpi-blue" />
                <Kpi labelKey="admin.analytics.activeUsers" value={fmtNumber(locale, users.totals.active)} t={t} tone="kpi-green" />
                <Kpi labelKey="admin.analytics.suspendedUsers" value={fmtNumber(locale, users.totals.suspended)} t={t} />
              </div>
              <div className="mt-12">
                <span className="muted-sm">{t("admin.analytics.byRole")}</span>
                <Breakdown rows={users.byRole} locale={locale} t={t} />
                <span className="muted-sm">{t("admin.analytics.byLocale")}</span>
                <Breakdown rows={users.byLocale} locale={locale} t={t} />
                <span className="muted-sm">{t("admin.analytics.registrationTrend")}</span>
                <div className="overflow-auto">
                  <table className="table" id="adm-analytics-users-trend">
                  <thead>
                    <tr>
                      <th>{t("admin.analytics.from")}</th>
                      <th>{t("admin.analytics.newUsers")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.registrationTrend.length === 0 ? (
                      <tr>
                        <td colSpan={2} className="muted-sm">
                          {t("admin.analytics.empty")}
                        </td>
                      </tr>
                    ) : (
                      users.registrationTrend.map((point) => (
                        <tr key={point.day}>
                          <td className="v-latn-num">{point.day}</td>
                          <td className="v-latn-num">{fmtNumber(locale, point.count)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
                </div>
              </div>
            </div>
          )}

          {trading === null ? null : (
            <div className="card mt-8">
              <h3 className="label text-gold">{t("admin.analytics.sectionTrading")}</h3>
              <div className="kpi-grid mt-8">
                <Kpi labelKey="admin.analytics.tradesInRange" value={fmtNumber(locale, trading.totals.trades)} t={t} />
                <Kpi labelKey="admin.analytics.wins" value={fmtNumber(locale, trading.totals.wins)} t={t} tone="kpi-green" />
                <Kpi labelKey="admin.analytics.losses" value={fmtNumber(locale, trading.totals.losses)} t={t} />
                <Kpi labelKey="admin.analytics.breakeven" value={fmtNumber(locale, trading.totals.breakEven)} t={t} />
                <Kpi labelKey="admin.analytics.netPnl" value={trading.totals.netPnl} t={t} tone="kpi-gold" />
                <Kpi labelKey="admin.analytics.totalVolume" value={trading.totals.volume} t={t} />
              </div>
              <div className="mt-12">
                <span className="muted-sm">{t("admin.analytics.bySymbol")}</span>
                <Breakdown rows={trading.bySymbol} locale={locale} t={t} />
                <span className="muted-sm">{t("admin.analytics.byDirection")}</span>
                <Breakdown rows={trading.byDirection} locale={locale} t={t} />
              </div>
              <div className="overflow-auto">
                <table className="table mt-8" id="adm-analytics-trading-trend">
                <thead>
                  <tr>
                    <th>{t("admin.analytics.from")}</th>
                    <th>{t("admin.analytics.netPnl")}</th>
                    <th>{t("admin.user360.trades")}</th>
                  </tr>
                </thead>
                <tbody>
                  {trading.pnlTrend.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="muted-sm">
                        {t("admin.analytics.empty")}
                      </td>
                    </tr>
                  ) : (
                    trading.pnlTrend.map((point) => (
                      <tr key={point.day}>
                        <td className="v-latn-num">{point.day}</td>
                        <td className="v-latn-num ts-mixed">{point.netPnl}</td>
                        <td className="v-latn-num">{fmtNumber(locale, point.count)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
