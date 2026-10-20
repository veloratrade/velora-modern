/*
 * Admin-console surface guards — Phase 6.
 *
 * WHY THIS FILE EXISTS. The console is the one screen where a missing string, a
 * missing permission gate, or an invented CSS class is a *capability* defect
 * rather than a cosmetic one: an operator who sees a raw key cannot tell whether
 * a module is broken, and a tab rendered without its permission is a redirect into
 * a 403. Three classes of defect were found while building it:
 *
 *   1. KEYS THAT SILENTLY FALL BACK. The tab strip, the analytics range presets and
 *      the health-component labels are passed to the translator as VALUES
 *      (`t(entry.labelKey)`, `t(RANGE_LABEL[preset])`, `t(componentLabel(key))`),
 *      not as `t("literal")` calls. A scan that only looked for the latter shipped
 *      a console that rendered "adminConsole.tab.overview" to the operator. This
 *      test scans BOTH shapes — the loose pass matches the SHAPE of a catalog key —
 *      and excludes the strings that are legitimately not keys: the RBAC permission
 *      names, read out of `packages/contracts/src/rbac.ts` rather than hard-coded,
 *      so a new permission cannot be mistaken for a string.
 *
 *   2. A TAB IS NOT A SECURITY BOUNDARY, AND MUST NOT PRETEND TO BE ONE. The page
 *      computes its tab set from the permission list the SERVER reports, so a
 *      caller without `analytics.view` never sees the analytics tab. The test pins
 *      both halves: the client hides, AND the server route that backs each tab
 *      still enforces the same permission (checked against the route module's
 *      source, because a hidden control plus a permissive route is exactly the
 *      failure this project must not ship).
 *
 *   3. INVENTED CSS. The page first shipped `.tabs`/`.tab-active`/`.row between`,
 *      none of which exist in the stylesheet — the console would have lost the
 *      glass/gold identity and the RTL spacing of every other page. Every class the
 *      page applies is now asserted to exist in `app.css`/`shell.css`.
 *
 * It also pins the sensitive-field rule at the source level: without
 * `audit.view_sensitive` the console must SAY the field is not available to the
 * caller instead of printing an empty cell, because "hidden from you" and "not
 * recorded" are different facts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTranslator, messagesFor } from "./catalog.js";
import type { Locale } from "../contracts/locale.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..");
const REPO = join(WEB, "..", "..");
const PAGE = join(WEB, "src", "app", "(app)", "admin", "page.tsx");
const RESOURCES = join(WEB, "src", "lib", "api", "resources.ts");
const RBAC = join(REPO, "packages", "contracts", "src", "rbac.ts");
/**
 * Every module that owns an admin-facing route. A permission may be enforced by
 * any of them — the support queue lives with the Phase 5 ticket module, and the
 * per-user routes live in the kernel — so the assertion below asks whether the
 * permission is checked SOMEWHERE on the server, not in one blessed file.
 */
const ROUTE_MODULES: readonly string[] = [
  join(REPO, "apps", "api", "src", "admin", "adminConsoleRoutes.ts"),
  join(REPO, "apps", "api", "src", "admin", "adminRoutes.ts"),
  join(REPO, "apps", "api", "src", "support", "supportRoutes.ts"),
  join(REPO, "apps", "api", "src", "kernel", "server.ts"),
  // The AI surface — including the agent-tool panel. It was added to this list WITH the tab that reads it:
  // `aiManage`/`aiRouteManage` are enforced in `aiAdminRoutes.ts` rather than in the admin console's own
  // module, and a tab whose permission nobody checks server-side is exactly the bypass this test exists
  // to catch.
  join(REPO, "apps", "api", "src", "ai", "aiAdminRoutes.ts"),
];
const APP_CSS = join(WEB, "src", "app", "(app)", "app.css");
const SHELL_CSS = join(WEB, "src", "components", "layout", "shell.css");

const FEATURES = ["common", "errors", "admin", "support"] as const;
const LOCALES: readonly Locale[] = ["fa", "en"];

const CORRUPTION = ["\uFFFD", "Ã", "Â", "Ø", "Ù", "ð", "\\u", "&amp;"];
const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

const read = (path: string): string => readFileSync(path, "utf8");
const pageSrc = read(PAGE);
/** Comments stripped: only real code may satisfy (or trip) a source assertion. */
const pageCode = pageSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\s\/\/.*$/gm, "");

/**
 * Every RBAC permission name declared in the contracts package.
 *
 * DOTTED names are the house style, but Legacy's two AI permissions are deliberately UNDOTTED
 * (`aiManage`, `aiRouteManage`, kept verbatim so `Role.php` diffs by name), and the agent-tool tab is
 * gated on them. An earlier version of this scan matched only `x.y`, so widening it to accept a bare
 * identifier is what keeps a real permission from being mistaken for a missing catalog key — and, on the
 * other side of the same assertion, keeps `permission: "aiManage"` from failing the "is that a declared
 * permission?" check with a false accusation.
 */
function declaredPermissions(): Set<string> {
  return new Set([...read(RBAC).matchAll(/"([a-z][A-Za-z0-9_]*(?:\.[a-z_]+)*)"/g)].map((m) => m[1]!));
}

/**
 * Every catalog key the page can render. The strict pass catches `t("k")`; the
 * loose pass catches a key handed to `t` as a VALUE (tab labels, range presets,
 * the health-component label map). Permission names are removed because they are
 * the only other dotted literals in the file.
 */
function pageKeys(): string[] {
  const permissions = declaredPermissions();
  const keys = new Set<string>();
  for (const m of pageSrc.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.add(m[1]!);
  for (const m of pageSrc.matchAll(/"([a-z][A-Za-z0-9]*\.[A-Za-z0-9._#-]+)"/g)) keys.add(m[1]!);
  return [...keys].filter((k) => k.includes(".") && !permissions.has(k)).sort();
}

const translator = (locale: Locale) => createTranslator(locale, [...FEATURES]);

test("the admin page renders a real key set (guard against an empty scan)", () => {
  const keys = pageKeys();
  assert.ok(keys.length >= 100, `expected a real key set from the console, found ${keys.length}`);
  // The three shapes that were broken: a value-passed tab label, a value-passed
  // range preset, and a value-passed component label.
  for (const must of [
    "adminConsole.tab.overview",
    "admin.user360.title",
    "admin.status.active",
    "adminConsole.tab.audit",
    "admin.analytics.rangeToday",
    "admin.analytics.rangeAll",
    "adminConsole.component.migrations",
    "adminConsole.component.rate_limiter",
    "admin.system.database",
    "admin.user360.title",
  ]) {
    assert.ok(keys.includes(must), `${must} is no longer referenced by the admin page`);
  }
  // And the permission names must NOT be in the scan — otherwise a permission
  // typo would look like a satisfied key.
  for (const permission of declaredPermissions()) {
    assert.ok(!keys.includes(permission), `${permission} leaked into the key scan`);
  }
});

test("every key the admin page can render resolves in BOTH locales it loads", () => {
  const keys = pageKeys();
  for (const locale of LOCALES) {
    const tr = translator(locale);
    const catalog = messagesFor(locale, [...FEATURES]);
    for (const key of keys) {
      const value = tr(key, null, "\u0000MISSING\u0000");
      assert.ok(!value.includes("MISSING"), `${locale}: ${key} is missing from the loaded catalogs`);
      assert.ok(key in catalog, `${locale}: ${key} is not in the loaded catalog`);
      assert.notEqual(catalog[key]!.trim(), "", `${locale}: ${key} is empty`);
      for (const bad of CORRUPTION) {
        assert.ok(!value.includes(bad), `${locale}: ${key} rendered ${JSON.stringify(bad)}`);
      }
    }
  }
});

test("the console's copy is Persian in fa and English in en — checked on RENDERED values", () => {
  const fa = messagesFor("fa", [...FEATURES]);
  const en = messagesFor("en", [...FEATURES]);
  const sample = [
    "admin.user360.title",
    "admin.user360.suspend",
    "admin.user360.revokeSessions",
    "admin.analytics.netPnl",
    "admin.system.status.notApplicable",
    "admin.security.currentRole",
    "adminConsole.support.title",
  ];
  for (const key of sample) {
    assert.ok(ARABIC_SCRIPT.test(fa[key]!), `fa:${key} is not Persian: ${fa[key]}`);
    assert.ok(!ARABIC_SCRIPT.test(en[key]!), `en:${key} is not English: ${en[key]}`);
  }
});

test("the operator's labels are Legacy's OWN words, byte for byte", () => {
  const fa = messagesFor("fa", [...FEATURES]);
  const en = messagesFor("en", [...FEATURES]);
  // Byte copies of Legacy public/locales/{fa,en}.json @edede31. If a label is ever
  // "improved", the operator loses the vocabulary the Legacy panel taught them.
  const legacyWords: readonly [string, string, string][] = [
    ["admin.user360.title", "کاربر ۳۶۰ درجه", "User 360"],
    ["admin.user360.activeSessions", "نشست‌های فعال", "Active sessions"],
    ["admin.user360.revokeSessions", "لغو نشست‌ها", "Revoke sessions"],
    ["admin.user360.knownDevices", "دستگاه‌های شناخته‌شده", "Known devices"],
    ["admin.user360.tradingAccounts", "حساب‌های معاملاتی", "Trading Accounts"],
    ["admin.user360.permissionDenied", "مجوز این اقدام را ندارید.", "You do not have permission for this action."],
    ["admin.analytics.netPnl", "سود/زیان خالص معاملات", "Net trading P&L"],
    ["admin.system.status.notApplicable", "کاربرد ندارد", "Not applicable"],
    ["admin.logs.empty", "هیچ لاگی با فیلترها مطابقت ندارد", "No log entries match the filters"],
    ["pages.support.badge.unread", "خوانده‌نشده", "Unread"],
  ];
  for (const [key, faValue, enValue] of legacyWords) {
    assert.equal(fa[key], faValue, `fa:${key} drifted from Legacy`);
    assert.equal(en[key], enValue, `en:${key} drifted from Legacy`);
  }
});

test("the tab set is permission-driven on the client AND enforced on the server", () => {
  // Client: the tab list is filtered by the permission set the server reports…
  assert.ok(pageCode.includes("TABS.filter"), "the tab strip is no longer filtered by permissions");
  assert.ok(pageCode.includes("getAdminSelf"), "the page no longer asks the server for its own permissions");
  assert.ok(
    pageCode.includes("availableTabs.length === 0") && pageCode.includes("admin.forbidden"),
    "a caller with no console permission must get the forbidden state, not an empty shell",
  );
  // …and no action button is rendered without its capability flag.
  for (const gate of ["canManage", "canVerify", "canChangeRole", "canReadAudit"]) {
    assert.ok(pageCode.includes(gate), `the page stopped gating on ${gate}`);
  }
  // Server: every permission the tab map names is really checked by the route
  // module. A hidden tab backed by an unguarded route is a bypass, not a UI state.
  const routes = ROUTE_MODULES.map(read).join("\n");
  const permissions = declaredPermissions();
  const used = new Set([...pageCode.matchAll(/permission: "([^"]+)"/g)].map((m) => m[1]!));
  assert.ok(used.size >= 5, `expected the tab map to name real permissions, found ${used.size}`);
  for (const permission of used) {
    assert.ok(permissions.has(permission), `${permission} is not a declared RBAC permission`);
    assert.ok(
      routes.includes(`"${permission}"`),
      `the console route module never checks ${permission} — the client would hide a tab the API leaves open`,
    );
  }
});

test("the sensitive network fields are omitted by the server and LABELLED by the client", () => {
  // The server omits the keys unless the caller holds audit.view_sensitive.
  const routes = read(ROUTE_MODULES[0]!);
  assert.ok(routes.includes("audit.view_sensitive"), "the route module no longer gates the sensitive fields");
  // The client must distinguish "not shown to you" from "not recorded".
  assert.ok(pageCode.includes("admin.user360.notAvailable"), "the console no longer labels an unavailable sensitive field");
  assert.ok(pageCode.includes("sensitive ?"), "the console prints sensitive fields without a sensitivity check");
  assert.ok(pageCode.includes("sensitiveHidden"), "the console no longer explains WHY the field is absent");
  // And the client type keeps them optional, so a caller without the permission is
  // represented honestly instead of with a fabricated null.
  const resources = read(RESOURCES);
  assert.ok(/ipAddress\?:/.test(resources) && /userAgent\?:/.test(resources), "the session/security types must keep ipAddress/userAgent optional");
});

test("User 360 renders paginated login history through the guarded per-user contract", () => {
  const resources = read(RESOURCES);
  const kernel = read(ROUTE_MODULES[3]!);
  assert.ok(resources.includes("getUserLoginHistory"), "the client resource for login history is missing");
  assert.ok(resources.includes("/login-history"), "the resource no longer targets the login-history route");
  assert.ok(pageCode.includes("getUserLoginHistory") && pageCode.includes("setLoginHistoryPage"), "User 360 no longer loads/paginates login history");
  assert.ok(pageCode.includes("authEventField"), "sensitive fields are no longer rendered with omission-aware labels");
  assert.ok(kernel.includes("/login-history$"), "the per-user login-history route is missing");
  assert.ok(kernel.includes('adminUsersRoute("users.view"'), "login history no longer uses users.view authorization");
  assert.ok(kernel.includes("maySeeSensitive"), "the route no longer omits sensitive fields for restricted callers");
  assert.ok(/ipAddress\?:/.test(resources) && /userAgent\?:/.test(resources), "sensitive history fields must remain optional");
});

test("a tool check's verdict is rendered from the RESPONSE, in both directions — never re-derived", () => {
  // The browser pass (round 5) proved the ONLY honest picture: the list endpoint reports the KEYS and the
  // 424 carries the same evidence envelope as the 200. Three ways this could rot, all silent:
  //   1. the client starts swallowing non-2xx envelope data again — then the UI has "a failure" to show and
  //      not WHICH failure, and the operator cannot tell INVALID_CREDENTIAL from a dead network;
  //   2. the page re-reads the table expecting the row to flip — it never can (nothing is cached), so the
  //      re-read is a wasted request that trains everyone to ignore what the table says;
  //   3. a "Last checked" column comes back — under this contract it can only ever read "never", which is
  //      the precise definition of a column that lies by being correct.
  const resources = read(RESOURCES);
  const client = read(join(WEB, "src", "lib", "api", "client.ts"));
  assert.ok(resources.includes("adminAiToolVerdictFromError"), "the client no longer recovers the 424 verdict body");
  assert.ok(/err\.status === 424/.test(resources), "the verdict recovery no longer keys on 424 specifically");
  assert.ok(/payloadData/.test(client), "the shared client discards non-2xx envelope data again");
  assert.ok(pageCode.includes("adminConsole.ai.noCache"), "the panel no longer explains that check results are never cached");
  assert.ok(!pageCode.includes("adminConsole.ai.lastChecked"), "a 'Last checked' column is back on an endpoint that never caches a check");
  // Scoped to `probe` itself: `load()` MAY (must, in fact) fetch the table — what may not happen again is
  // the probe re-reading it underneath, as if a check were supposed to move the row.
  const probeBody = pageCode.slice(pageCode.indexOf("async function probe"), pageCode.indexOf("if (loading)"));
  assert.ok(probeBody.length > 100 && !probeBody.includes("getAdminAiTools"), "the probe re-reads the table expecting the state to have moved");
  // Round 5's browser pass caught the same sentence printed twice on an `unsupported` row (badge AND the
  // runtime suffix). The suffix only earns its place when it ADDS to the state word.
  assert.ok(
    pageCode.includes('row.state !== "unsupported"'),
    "the runtime-unsupported suffix is printed unconditionally again — an `unsupported` row says it twice",
  );
});

test("every class the console applies exists in the stylesheet", () => {
  const defined = new Set<string>();
  for (const css of [APP_CSS, SHELL_CSS]) {
    for (const m of read(css).matchAll(/^\.([a-z0-9-]+)/gm)) defined.add(m[1]!);
  }
  const used = new Set<string>();
  for (const m of pageCode.matchAll(/className="([^"]+)"/g)) {
    for (const token of m[1]!.split(/\s+/)) if (token !== "") used.add(token);
  }
  // Template-literal class names (the button variants) are covered by the
  // canonical stems below.
  for (const stem of ["btn-primary", "btn-ghost", "btn-sm", "kpi-value", "badge-error"]) {
    assert.ok(defined.has(stem), `the stylesheet lost .${stem}`);
  }
  const unknown = [...used].filter((token) => !defined.has(token));
  assert.deepEqual(unknown, [], `the console applies classes the stylesheet does not define: ${unknown.join(", ")}`);
  assert.ok(used.size >= 15, `expected the console to reuse the canonical class set, found ${used.size}`);
});

test("the console carries no hard-coded user-facing string", () => {
  // Only the documented fallbacks may appear as literals in `t(key, params, fallback)`
  // and they are English; any Persian literal in CODE (not comments) is a string a
  // Persian reader would see untranslated the moment the catalogs change.
  assert.ok(!ARABIC_SCRIPT.test(pageCode), "the admin page hard-codes a Persian string");
  const fallbacks = [...pageCode.matchAll(/,\s*"([^"]{4,})"\s*\)/g)].map((m) => m[1]!);
  for (const fallback of fallbacks) {
    assert.ok(!ARABIC_SCRIPT.test(fallback), `fallback "${fallback}" is Persian`);
  }
  assert.ok(fallbacks.length >= 1, "expected the page to pass a fallback to at least one key");
});
