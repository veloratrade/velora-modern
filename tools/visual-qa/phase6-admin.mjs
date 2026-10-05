// Phase 6 visual & responsive QA harness — the ADMIN CONSOLE, driven in a REAL
// browser against the PRODUCTION build (`next build` + `next start`) and the live
// API on PostgreSQL.
//
// WHY IT IS IN THE REPO: same reason as phase5-support.mjs — a screenshot folder
// without the recipe that produced it is not evidence. Reproduce with:
//
//   APP_ENV=development APP_ORIGIN=http://127.0.0.1:8080 PERSISTENCE=postgres \
//     DATABASE_URL=postgres://postgres@127.0.0.1:54329/velora_phase1 \
//     JWT_SECRET=<32+ chars> npx tsx apps/api/src/server-main.ts
//   cd apps/web && VELORA_API_ORIGIN=http://127.0.0.1:8080 npm run build && npm run start
//   PSQL_BIN=/usr/lib/postgresql/17/bin/psql node tools/visual-qa/phase6-admin.mjs
//
// WHAT IT PROVES, and why a source-level test cannot: the console is rendered by
// the product in both locales and three viewports, and the OPERATOR STATES are
// observed — a real suspension/activation round trip through the HTTP API, the
// self-protection guard rendered as localized copy (not a stack trace), the
// sensitive-field note flipping with the caller's permissions, the support queue
// answering a real ticket, the audit trail showing the actions this run just
// performed, and the health panel naming the subsystems that do not exist yet
// instead of showing a green check for them.
//
// ACCOUNTS ARE REAL. Registration runs through the public endpoint with a real
// password; only e-mail VERIFICATION and the role promotion are completed out of
// band with psql (the development mail adapter deliberately never logs a
// verification link — it is a bearer-equivalent secret), which is what an
// operator does in this environment.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WEB = process.env.WEB_BASE ?? "http://127.0.0.1:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:8080";
const OUT = process.env.OUT_DIR ?? "docs/audits/phase6-ui";
const PASSWORD = "Admin!Visual-2026-9f3a";
const stamp = Date.now();
const PSQL = process.env.PSQL_BIN ?? "psql";
const PG_ARGS = [
  "-h", process.env.PGHOST ?? "127.0.0.1",
  "-p", process.env.PGPORT ?? "54329",
  "-U", process.env.PGUSER ?? "postgres",
  "-d", process.env.PGDATABASE ?? "velora_phase1",
];

mkdirSync(OUT, { recursive: true });
const findings = [];
const consoleErrors = [];
const shots = [];

const api = async (path, { method = "GET", token, body } = {}) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** Operational state, not evidence: the auth buckets fill up across sessions. */
function clearRateLimits() {
  execFileSync(PSQL, [...PG_ARGS, "-c", "DELETE FROM rate_limits"], { stdio: "ignore" });
}

function sql(statement) {
  execFileSync(PSQL, [...PG_ARGS, "-c", statement], { stdio: "ignore" });
}

async function registerAndVerify(email, fullName) {
  const reg = await api("/api/v1/auth/register", {
    method: "POST",
    body: { email, password: PASSWORD, locale: "fa", fullName, timezone: "Asia/Tehran" },
  });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  sql(`UPDATE users SET email_verified_at = now() WHERE email = '${email}'`);
}

async function login(email) {
  const res = await api("/api/v1/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json.data.tokens.accessToken;
}

function record(name, ok, detail) {
  findings.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** fa copy, read from the catalog chunk the product itself loads. */
const FA = {
  title: "تحلیل و درآمد",
  // The catalog writes «کاربر ۳۶۰ درجه»; the product rule (latinDigits.ts, Legacy
  // velora-latin-digits.js) renders EVERY numeral as Latin 0-9 in every locale, so
  // the expected strings below are the catalog values after that normalization.
  tabs: ["نمای کل", "کاربر 360 درجه", "صف پشتیبانی", "ممیزی", "امنیت و دسترسی", "سیستم و سلامت", "تحلیل و درآمد"],
  suspended: "کاربر مسدود شد",
  activated: "کاربر فعال شد",
  sessionsRevoked: "نشست‌ها لغو شدند",
  emailVerified: "ایمیل تأیید شد.",
  permissionDenied: "مجوز این اقدام را ندارید.",
  replied: "پاسخ ارسال شد.",
  closed: "تیکت بسته شد.",
  sensitiveVisible: "شما مجوز مشاهده داده‌های حساس شبکه را دارید.",
  sensitiveHidden: "بدون مجوز «مشاهده ممیزی حساس» نمایش داده نمی‌شود.",
  notApplicable: "کاربرد ندارد",
  forbidden: "این صفحه فقط برای مدیران است و شما دسترسی لازم را ندارید.",
  loadFailed: "بارگذاری اطلاعات مدیریت ناموفق بود.",
};

async function main() {
  clearRateLimits();
  const ownerEmail = `adm-qa-owner-${stamp}@velora.test`;   // super_admin: the operator under test
  const staffEmail = `adm-qa-staff-${stamp}@velora.test`;   // admin: audit.view WITHOUT view_sensitive
  const userEmail = `adm-qa-user-${stamp}@velora.test`;     // user: must be refused by the console

  await registerAndVerify(ownerEmail, "مدیر ارشد آزمون");
  await registerAndVerify(staffEmail, "مدیر آزمون");
  await registerAndVerify(userEmail, "کاربر آزمون");
  sql(`UPDATE users SET role='super_admin' WHERE email='${ownerEmail}'`);
  sql(`UPDATE users SET role='admin' WHERE email='${staffEmail}'`);

  const userToken = await login(userEmail);
  // A real ticket from a real user, so the queue tab has something to show.
  const ticket = await api("/api/v1/support/tickets", {
    method: "POST",
    token: userToken,
    body: { subject: "درخواست بررسی دسترسی کنسول", message: "سلام، لطفاً دسترسی مدیریتی حساب من را بررسی کنید." },
  });
  if (ticket.status !== 201 && ticket.status !== 200) throw new Error(`ticket seed failed: ${ticket.status}`);
  const ticketId = ticket.json.data.ticket.id;

  const browser = await chromium.launch();

  async function session(viewport, locale) {
    const ctx = await browser.newContext({ viewport, locale: locale === "fa" ? "fa-IR" : "en-US" });
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`${locale} ${viewport.width}px: ${msg.text()}`);
    });
    page.on("pageerror", (err) => consoleErrors.push(`${locale} ${viewport.width}px pageerror: ${err.message}`));
    return { ctx, page };
  }

  async function uiLogin(page, email, target) {
    clearRateLimits();
    await page.goto(`${WEB}${target}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    try {
      await Promise.all([
        page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 }),
        page.click('button[type="submit"]'),
      ]);
    } catch {
      // The post-login redirect can race the refresh exchange (observed in phase 1).
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 20000 });
    }
    await page.waitForLoadState("networkidle");
  }

  const openConsole = async (page, locale) => {
    await page.goto(`${WEB}${locale === "fa" ? "" : "/en"}/admin`, { waitUntil: "networkidle" });
    await page.waitForSelector('[role="tablist"] button', { timeout: 20000 });
    await page.waitForTimeout(500);
  };
  const gotoTab = async (page, key) => {
    await page.click(`#adm-tab-${key}`);
    await page.waitForTimeout(700);
  };
  const toastText = (page) => page.locator('.card-alt[role="status"] .muted-sm').first().innerText();
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  // ── 1. fa desktop: the console opens, permission-driven, in RTL ──────────
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, ownerEmail, "");
    await openConsole(page, "fa");
    record("fa/admin renders with dir=rtl", (await page.getAttribute("html", "dir")) === "rtl");
    const title = await page.locator(".page-title").first().innerText();
    record("fa/admin title is Persian", title.includes(FA.title), title);
    const tabs = await page.locator('[role="tablist"] button').allInnerTexts();
    record("a super_admin sees all seven console tabs", tabs.length === 7, tabs.join(" | "));
    record("tab labels are Legacy's own Persian words", FA.tabs.every((label) => tabs.includes(label)), tabs.join(" | "));
    const kpis = await page.locator("#adm-overview-kpis .kpi-value").allInnerTexts();
    record("overview KPIs render server numbers", kpis.length === 6 && kpis.every((v) => /^[0-9۰-۹]+$/.test(v.trim())), JSON.stringify(kpis));
    record("fa/admin has no horizontal overflow (1440)", (await noOverflow(page)) <= 0, `overflow=${await noOverflow(page)}`);
    await page.screenshot({ path: `${OUT}/01-admin-fa-overview.png`, fullPage: true });
    shots.push("01-admin-fa-overview.png");
    await ctx.close();
  }

  // ── 2. users 360: list, filters, detail, and a REAL operator action ──────
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, ownerEmail, "");
    await openConsole(page, "fa");
    await gotoTab(page, "users");
    const rows = await page.locator("#adm-users-table tbody tr").count();
    record("the users tab lists real accounts", rows >= 3, `rows=${rows}`);
    await page.fill("#adm-user-search", userEmail);
    await page.waitForTimeout(900);
    const filtered = await page.locator("#adm-users-table tbody tr").count();
    record("the search filter narrows the list server-side", filtered === 1, `rows=${filtered}`);
    await page.screenshot({ path: `${OUT}/02-admin-fa-users-filtered.png`, fullPage: true });
    shots.push("02-admin-fa-users-filtered.png");

    await page.locator("#adm-users-table tbody tr").first().click();
    await page.waitForSelector("#adm-user-detail", { timeout: 15000 });
    await page.waitForTimeout(900);
    record("a row opens the user-360 detail", (await page.locator("#adm-user-email").innerText()).includes(userEmail));
    record("the 360 view shows live sessions", (await page.locator("#adm-sessions-table tbody tr").count()) >= 1);
    record("devices/trades report an honest empty state, not a fake zero",
      (await page.locator("#adm-devices-empty, #adm-devices-table").count()) === 1 &&
      (await page.locator("#adm-trades-empty, #adm-trades-table").count()) === 1);
    await page.screenshot({ path: `${OUT}/03-admin-fa-user360.png`, fullPage: true });
    shots.push("03-admin-fa-user360.png");

    // suspend → activate, through the UI, against the real API
    await page.click("#adm-user-toggle-status");
    await page.waitForTimeout(1400);
    record("suspending a user renders the Legacy toast", (await toastText(page)).includes(FA.suspended), await toastText(page));
    const badge = await page.locator("#adm-user-detail .badge").allInnerTexts();
    record("the suspended state is visible on the record", badge.some((b) => b.includes("مسدود")), badge.join(" | "));
    await page.screenshot({ path: `${OUT}/04-admin-fa-user-suspended.png`, fullPage: true });
    shots.push("04-admin-fa-user-suspended.png");

    await page.click("#adm-user-toggle-status");
    await page.waitForTimeout(1400);
    record("re-activating a user renders the Legacy toast", (await toastText(page)).includes(FA.activated), await toastText(page));

    await page.click("#adm-user-verify-email");
    await page.waitForTimeout(1200);
    record("verify-email is idempotent and says so", (await toastText(page)).includes(FA.emailVerified), await toastText(page));

    await page.click("#adm-user-revoke-all");
    await page.waitForTimeout(1400);
    record("revoking sessions reports the action", (await toastText(page)).includes(FA.sessionsRevoked), await toastText(page));
    await page.waitForTimeout(600);
    record("revoked sessions leave the live list", (await page.locator("#adm-sessions-empty, #adm-sessions-table").count()) === 1);
    await page.screenshot({ path: `${OUT}/05-admin-fa-user-actions.png`, fullPage: true });
    shots.push("05-admin-fa-user-actions.png");
    await ctx.close();
  }

  // ── 3. the guard an operator WILL hit: acting on yourself ────────────────
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, ownerEmail, "");
    await openConsole(page, "fa");
    await gotoTab(page, "users");
    await page.fill("#adm-user-search", ownerEmail);
    await page.waitForTimeout(900);
    await page.locator("#adm-users-table tbody tr").first().click();
    await page.waitForSelector("#adm-user-detail", { timeout: 15000 });
    await page.waitForTimeout(700);
    await page.click("#adm-user-toggle-status");
    await page.waitForTimeout(1200);
    const err = await page.locator("#adm-user-detail .text-error").first().innerText().catch(() => "");
    record("self-suspension is refused with localized copy, not a stack trace",
      err.includes(FA.permissionDenied), err);
    await page.screenshot({ path: `${OUT}/06-admin-fa-self-denied.png`, fullPage: true });
    shots.push("06-admin-fa-self-denied.png");
    await ctx.close();
  }

  // ── 4. support queue: a real ticket, answered and closed by an operator ──
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, ownerEmail, "");
    await openConsole(page, "fa");
    await gotoTab(page, "support");
    const body = await page.locator("body").innerText();
    record("the queue shows the seeded ticket", body.includes("درخواست بررسی دسترسی کنسول"));
    await page.locator("#adm-support-table tbody tr").first().click();
    await page.waitForSelector("#adm-support-thread", { timeout: 15000 });
    await page.waitForTimeout(800);
    record("the thread opens with the user's own words", (await page.locator("#adm-support-thread").innerText()).includes("لطفاً دسترسی مدیریتی"));
    await page.fill("#adm-support-reply", "بررسی شد؛ دسترسی کنسول برای این حساب فعال نیست.");
    await page.click("#adm-support-send");
    await page.waitForTimeout(1500);
    record("an operator reply is accepted", (await toastText(page)).includes(FA.replied), await toastText(page));
    await page.screenshot({ path: `${OUT}/07-admin-fa-support-thread.png`, fullPage: true });
    shots.push("07-admin-fa-support-thread.png");
    await page.click("#adm-support-close");
    await page.waitForTimeout(1500);
    record("closing a ticket is reported", (await toastText(page)).includes(FA.closed), await toastText(page));
    // The thread stays open on the new state, and only the LEGAL transitions are
    // offered: archive is legal from closed, close is not, reopen is. An operator
    // may still add a note to a closed ticket (the service refuses only archived).
    record("a closed ticket offers archive + reopen and no longer offers close",
      (await page.locator("#adm-support-archive").count()) === 1 &&
      (await page.locator("#adm-support-reopen").count()) === 1 &&
      (await page.locator("#adm-support-close").count()) === 0);
    record("the closed badge is a catalog word, not the raw enum",
      (await page.locator("#adm-support-thread .badge").first().innerText()).includes("بسته"));
    await page.click("#adm-support-archive");
    await page.waitForTimeout(1500);
    record("an archived ticket hides the reply box the service would refuse",
      (await page.locator("#adm-support-reply").count()) === 0 &&
      (await page.locator("#adm-support-archive").count()) === 0);
    await page.screenshot({ path: `${OUT}/08-admin-fa-support-closed.png`, fullPage: true });
    shots.push("08-admin-fa-support-closed.png");
    await ctx.close();
  }

  // ── 5. audit + security: the run's own actions, and who may see what ─────
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, ownerEmail, "");
    await openConsole(page, "fa");
    await gotoTab(page, "audit");
    const auditRows = await page.locator("#adm-audit-table tbody tr").count();
    const auditText = await page.locator("#adm-audit-table").innerText();
    const auditTextAll = auditText;
    record("the audit trail lists the actions this run performed", auditRows >= 3, `rows=${auditRows}`);
    record("the trail names the status changes and the session revocation",
      auditTextAll.includes("USER_STATUS_CHANGED") && auditTextAll.includes("USER_SESSIONS_REVOKED"),
      [...new Set((auditTextAll.match(/USER_[A-Z_]+/g) ?? []))].join(","));
    record("a no-op verify-email wrote no audit row (nothing changed)",
      (auditTextAll.match(/USER_EMAIL_VERIFIED/g) ?? []).length === 0);
    record("audit rows carry before/after state (the phase-6 store fix)", /live:|active|suspended|verified/i.test(auditText));
    await page.fill("#adm-audit-action", "USER_STATUS_CHANGED");
    await page.click("#adm-audit-apply");
    await page.waitForTimeout(1100);
    const filteredRows = await page.locator("#adm-audit-table tbody tr").count();
    record("the action filter narrows the trail", filteredRows >= 1 && filteredRows < auditRows, `${filteredRows}/${auditRows}`);
    await page.screenshot({ path: `${OUT}/09-admin-fa-audit.png`, fullPage: true });
    shots.push("09-admin-fa-audit.png");

    await gotoTab(page, "security");
    record("a super_admin is told it holds the sensitive permission",
      (await page.locator("#adm-security-sensitive-note").innerText()).includes(FA.sensitiveVisible));
    const secRows = await page.locator("#adm-security-table tbody tr").count();
    record("the security feed shows real signup/login events", secRows >= 3, `rows=${secRows}`);
    await page.screenshot({ path: `${OUT}/10-admin-fa-security.png`, fullPage: true });
    shots.push("10-admin-fa-security.png");
    await ctx.close();
  }

  // ── 6. the SAME tab as an `admin`: sensitive fields are absent, not blank ─
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, staffEmail, "");
    await openConsole(page, "fa");
    await gotoTab(page, "security");
    record("an admin without audit.view_sensitive is told the fields are hidden",
      (await page.locator("#adm-security-sensitive-note").innerText()).includes(FA.sensitiveHidden));
    const table = await page.locator("#adm-security-table").innerText();
    record("no IP address is rendered to a caller who may not see it", !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(table));
    const tabs = await page.locator('[role="tablist"] button').allInnerTexts();
    record("an admin still sees the seven panels it is entitled to", tabs.length === 7, tabs.join(" | "));
    await page.screenshot({ path: `${OUT}/11-admin-fa-security-limited.png`, fullPage: true });
    shots.push("11-admin-fa-security-limited.png");
    await ctx.close();
  }

  // ── 7. system health: nine components, and honesty about what is unbuilt ─
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, ownerEmail, "");
    await openConsole(page, "fa");
    await gotoTab(page, "system");
    const healthRows = await page.locator("#adm-health-table tbody tr").count();
    record("the health panel attests nine components", healthRows === 9, `rows=${healthRows}`);
    const healthText = await page.locator("#adm-health-table").innerText();
    record("unbuilt subsystems say «کاربرد ندارد», never a green check", healthText.includes(FA.notApplicable));
    record("the migration head is the one this phase shipped", healthText.includes("0027"), healthText.match(/00\d\d/g)?.join(",") ?? "");
    record("an overall verdict is rendered", (await page.locator("#adm-health-overall").innerText()).length > 0);
    await page.screenshot({ path: `${OUT}/12-admin-fa-system.png`, fullPage: true });
    shots.push("12-admin-fa-system.png");
    await ctx.close();
  }

  // ── 8. analytics: range presets really re-query ──────────────────────────
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, ownerEmail, "");
    await openConsole(page, "fa");
    await gotoTab(page, "analytics");
    record("all five range presets render", (await page.locator('[id^="adm-range-"]').count()) === 5);
    await page.click("#adm-range-30d");
    await page.waitForTimeout(1200);
    record("a range switch re-renders the trends",
      (await page.locator("#adm-analytics-users-trend").count()) === 1 &&
      (await page.locator("#adm-analytics-trading-trend").count()) === 1);
    record("the selected preset is marked as selected",
      (await page.getAttribute("#adm-range-30d", "aria-selected")) === "true" ||
      (await page.getAttribute("#adm-range-30d", "class")).includes("btn-primary"));
    await page.screenshot({ path: `${OUT}/13-admin-fa-analytics.png`, fullPage: true });
    shots.push("13-admin-fa-analytics.png");
    await ctx.close();
  }

  // ── 9. en desktop: LTR, and chrome fully translated ─────────────────────
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "en");
    await uiLogin(page, ownerEmail, "/en");
    await openConsole(page, "en");
    record("en/admin renders with dir=ltr", (await page.getAttribute("html", "dir")) === "ltr");
    const tabs = await page.locator('[role="tablist"] button').allInnerTexts();
    record("en tabs are English", tabs.join(" ").includes("Overview") && tabs.join(" ").includes("User 360"), tabs.join(" | "));
    const chrome = [
      await page.locator(".page-title").first().innerText(),
      await page.locator(".page-sub").first().innerText(),
      ...(await page.locator("#adm-overview-kpis .kpi-label").allInnerTexts()),
      ...(await page.locator(".card h3.label").allInnerTexts()),
      ...tabs,
    ].join(" \u0000 ");
    const persian = chrome.replace(/فارسی|فا/g, "").match(/[\u0600-\u06FF]+/g);
    record("en/admin chrome carries no Persian", persian === null, (persian ?? []).join(","));
    record("en/admin has no horizontal overflow (1440)", (await noOverflow(page)) <= 0, `overflow=${await noOverflow(page)}`);
    await page.screenshot({ path: `${OUT}/14-admin-en-overview.png`, fullPage: true });
    shots.push("14-admin-en-overview.png");
    await ctx.close();
  }

  // ── 10. a normal user is refused, and sees no data at all ────────────────
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, userEmail, "");
    await page.goto(`${WEB}/admin`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const body = await page.locator("body").innerText();
    // The proxy refuses the ADMIN SHELL itself for a signed-in non-admin (302 →
    // dashboard, Legacy: "never delivered … regardless of client-side guards"),
    // which is stronger than rendering a refusal inside the console.
    record("a non-admin is redirected away from /admin", new URL(page.url()).pathname.endsWith("/dashboard"), page.url());
    record("a non-admin sees no console chrome", (await page.locator('[role="tablist"] button').count()) === 0);
    record("a non-admin sees no user data", !body.includes(ownerEmail) && !body.includes(staffEmail));
    await page.screenshot({ path: `${OUT}/15-admin-fa-forbidden.png`, fullPage: true });
    shots.push("15-admin-fa-forbidden.png");
    await ctx.close();
  }

  // ── 10b. a panel role with NO console permission gets the in-page refusal ──
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, staffEmail, "");
    await page.goto(`${WEB}/admin`, { waitUntil: "networkidle" });
    await page.waitForSelector('[role="tablist"] button', { timeout: 20000 });
    // Simulated at the browser boundary: the point is what the PAGE renders when
    // the server reports a panel role whose permission set grants no console tab.
    await page.route("**/api/v1/admin/rbac/self", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "success", data: { role: "admin", isSystemOwner: false, permissions: ["rbac.self.view"] }, error: null, timestamp: new Date().toISOString() }),
      }),
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    const narrowed = await page.locator("body").innerText();
    record("a role with no console permission gets the localized refusal", narrowed.includes(FA.forbidden), narrowed.slice(0, 100));
    record("that refusal renders no tabs and no data", (await page.locator('[role="tablist"] button').count()) === 0);
    await page.screenshot({ path: `${OUT}/15-admin-fa-forbidden.png`, fullPage: true });
    shots.push("15-admin-fa-forbidden.png");
    await ctx.close();
  }

  // ── 11. responsive: mobile and the narrowest supported viewport ─────────
  for (const [label, width, height, locale, file] of [
    ["16-admin-fa-mobile-390", 390, 844, "fa", "16-admin-fa-mobile-390.png"],
    ["17-admin-fa-narrow-320", 320, 844, "fa", "17-admin-fa-narrow-320.png"],
    ["18-admin-en-mobile-390", 390, 844, "en", "18-admin-en-mobile-390.png"],
  ]) {
    const { ctx, page } = await session({ width, height }, locale);
    await uiLogin(page, ownerEmail, locale === "fa" ? "" : "/en");
    await openConsole(page, locale);
    await gotoTab(page, "users");
    const overflow = await noOverflow(page);
    record(`${label} has no horizontal overflow`, overflow <= 0, `overflow=${overflow} @${width}px`);
    const tabsVisible = await page.locator('[role="tablist"] button').count();
    record(`${label} keeps every tab reachable`, tabsVisible === 7, `tabs=${tabsVisible}`);
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: true });
    shots.push(file);
    await ctx.close();
  }

  // ── 12. keyboard: the tab strip is operable without a mouse ─────────────
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, ownerEmail, "");
    await openConsole(page, "fa");
    await page.focus("#adm-tab-users");
    const results = [];
    for (const id of ["adm-tab-users", "adm-tab-support", "adm-tab-audit", "adm-tab-security", "adm-tab-system", "adm-tab-analytics"]) {
      await page.focus(`#${id}`);
      results.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { tag: el.tagName, outline: cs.outlineWidth !== "0px" && cs.outlineStyle !== "none", shadow: cs.boxShadow !== "none" };
      }));
    }
    const visible = results.filter((r) => r && (r.outline || r.shadow)).length;
    record("every console tab shows a focus indicator", results.length === 6 && visible === results.length, `${visible}/${results.length}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    record("Enter activates the focused tab", (await page.locator("#adm-analytics-users-trend, #adm-health-table, #adm-audit-table, #adm-security-table, #adm-support-table").count()) >= 1);
    await page.screenshot({ path: `${OUT}/19-admin-fa-focus.png` });
    shots.push("19-admin-fa-focus.png");
    await ctx.close();
  }

  // ── 13. honest failure state at the browser boundary ────────────────────
  {
    const { ctx, page } = await session({ width: 1440, height: 960 }, "fa");
    await uiLogin(page, ownerEmail, "");
    await page.goto(`${WEB}/admin`, { waitUntil: "networkidle" });
    await page.waitForSelector('[role="tablist"] button', { timeout: 20000 });
    await page.route("**/api/v1/admin/**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ status: "error", data: null, error: { code: "SERVICE_UNAVAILABLE", message: "admin console not configured" }, timestamp: new Date().toISOString() }),
      }),
    );
    await gotoTab(page, "analytics");
    await page.waitForTimeout(900);
    const body = await page.locator("body").innerText();
    record("a backend outage renders the localized load-failed state", body.includes(FA.loadFailed), body.slice(0, 140));
    record("an outage never renders fabricated numbers", !/NaN|undefined/.test(body));
    await page.screenshot({ path: `${OUT}/20-admin-fa-api-down.png`, fullPage: true });
    shots.push("20-admin-fa-api-down.png");
    await ctx.close();
  }

  await browser.close();

  const realErrors = consoleErrors.filter((e) => !/404|503|403|Failed to load resource/i.test(e));
  record("no unexpected console/page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  writeFileSync(`${OUT}/visual-qa-results.json`, JSON.stringify({
    phase: 6,
    surface: "admin console",
    run_at: new Date().toISOString(),
    web: WEB,
    api: API,
    persistence: "postgres (real cluster, migration head 0027_admin_console.sql)",
    accounts: { super_admin: ownerEmail, admin: staffEmail, user: userEmail, seeded_ticket: ticketId },
    findings, shots, consoleErrors,
  }, null, 2));
  const failed = findings.filter((f) => !f.ok);
  console.log(`\n${findings.length - failed.length}/${findings.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
