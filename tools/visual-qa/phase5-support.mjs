// Phase 5 visual & responsive QA harness — the support center, driven in a REAL
// browser against the PRODUCTION build (`next build` + `next start`) and the live
// API on PostgreSQL.
//
// WHY IT IS IN THE REPO (not a scratch file): the Phase 1 run kept only its
// screenshots, so re-running that QA needed the harness to be rewritten from
// memory. This file is the recipe — every check below is reproducible with:
//
//   APP_ENV=development APP_ORIGIN=http://127.0.0.1:8080 PERSISTENCE=postgres \
//     DATABASE_URL=postgres://postgres@127.0.0.1:54329/velora_phase1 \
//     JWT_SECRET=<32+ chars> npx tsx apps/api/src/server-main.ts
//   cd apps/web && VELORA_API_ORIGIN=http://127.0.0.1:8080 npm run build && npm run start
//   node tools/visual-qa/phase5-support.mjs        (needs `playwright` + chromium)
//
// WHAT IT PROVES, and why a source-level test cannot: the page is rendered by the
// product, in both locales and three viewports, and the states a person meets are
// OBSERVED — the create/reply/reopen round-trips go through the real HTTP API,
// the closed-ticket reply hiding is checked on the DOM, and the degraded states
// (503, 429) are read off the rendered text.
//
// THE ACCOUNT IS REAL. Registration runs through the public endpoint with a real
// password; only the e-mail VERIFICATION step is completed out of band (the
// development mail adapter deliberately never logs a verification link — it is a
// bearer-equivalent secret), which is what an operator does in this environment.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const WEB = process.env.WEB_BASE ?? "http://127.0.0.1:3000";
const API = process.env.API_BASE ?? "http://127.0.0.1:8080";
const OUT = process.env.OUT_DIR ?? "docs/audits/phase5-ui";
const PASSWORD = "Support!Visual-2026-9f3a";
const stamp = Date.now();
const PSQL = process.env.PSQL_BIN ?? "psql";
const PG_ARGS = ["-h", process.env.PGHOST ?? "127.0.0.1", "-p", process.env.PGPORT ?? "54329", "-U", process.env.PGUSER ?? "postgres", "-d", process.env.PGDATABASE ?? "velora_phase1"];

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

async function registerAndVerify(email, fullName) {
  const reg = await api("/api/v1/auth/register", {
    method: "POST",
    body: { email, password: PASSWORD, locale: "fa", fullName, timezone: "Asia/Tehran" },
  });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  execFileSync(PSQL, [...PG_ARGS, "-c", `UPDATE users SET email_verified_at = now() WHERE email = '${email}'`], { stdio: "ignore" });
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

async function main() {
  clearRateLimits();
  const userEmail = `sup-qa-${stamp}@velora.test`;
  const adminEmail = `sup-qa-admin-${stamp}@velora.test`;

  await registerAndVerify(userEmail, "پشتیبانی تست");
  await registerAndVerify(adminEmail, "مدیر تست");
  execFileSync(PSQL, [...PG_ARGS, "-c", `UPDATE users SET role='admin' WHERE email='${adminEmail}'`], { stdio: "ignore" });

  const userToken = await login(userEmail);
  const adminToken = await login(adminEmail);

  // Seed the states a person would see, THROUGH THE REAL API.
  const created = await api("/api/v1/support/tickets", {
    method: "POST",
    token: userToken,
    body: { subject: "حساب من شارژ نشد", message: "سلام، پس از واریز، موجودی حساب من به‌روزرسانی نشد.\nلطفاً بررسی کنید." },
  });
  const ticketId = created.json.data.ticket.id;
  await api(`/api/v1/admin/communications/tickets/${ticketId}/messages`, {
    method: "POST",
    token: adminToken,
    body: { message: "سلام، درخواست شما دریافت شد. همگام‌سازی حساب را در صف قرار دادیم؛ تا دقایقی دیگر موجودی به‌روزرسانی می‌شود." },
  });
  const second = await api("/api/v1/support/tickets", {
    method: "POST",
    token: userToken,
    body: { subject: "درخواست فاکتور رسمی", message: "برای معاملات مهر، فاکتور رسمی لازم دارم." },
  });
  const closedId = second.json.data.ticket.id;
  await api(`/api/v1/admin/communications/tickets/${closedId}/messages`, { method: "POST", token: adminToken, body: { message: "فاکتور در پنل کاربری قابل دانلود است." } });
  await api(`/api/v1/admin/communications/tickets/${closedId}/status`, { method: "POST", token: adminToken, body: { action: "close" } });

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

  // ── 1. fa desktop: list + new-ticket form ────────────────────────────────
  {
    const { ctx, page } = await session({ width: 1366, height: 900 }, "fa");
    await uiLogin(page, userEmail, "");
    await page.goto(`${WEB}/support`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const dir = await page.getAttribute("html", "dir");
    record("fa/support renders with dir=rtl", dir === "rtl", `dir=${dir}`);
    const persian = await page.locator(".page-title").innerText();
    record("fa/support title is Persian", persian.includes("پشتیبانی"), persian);
    const kpi = await page.locator(".kpi-value").allInnerTexts();
    record("fa/support KPIs render server numbers", kpi.length === 3 && kpi.every((v) => /^[0-9]+$/.test(v.trim())), JSON.stringify(kpi));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    record("fa/support has no horizontal overflow (1366)", overflow <= 0, `overflow=${overflow}`);
    await page.screenshot({ path: `${OUT}/01-support-fa-desktop.png`, fullPage: true });
    shots.push("01-support-fa-desktop.png");
    await ctx.close();
  }

  // ── 2. en desktop: list ──────────────────────────────────────────────────
  {
    const { ctx, page } = await session({ width: 1366, height: 900 }, "en");
    await uiLogin(page, userEmail, "/en");
    await page.goto(`${WEB}/en/support`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const dir = await page.getAttribute("html", "dir");
    record("en/support renders with dir=ltr", dir === "ltr", `dir=${dir}`);
    const title = await page.locator(".page-title").innerText();
    record("en/support title is English", title.includes("Support"), title);
    // The chrome only: a ticket's subject/body is USER CONTENT (written in Persian
    // by the user) and must never be translated. The language switcher shows «فارسی».
    const chrome = [
      await page.locator(".page-title").innerText(),
      await page.locator(".page-sub").innerText(),
      ...(await page.locator(".kpi-label").allInnerTexts()),
      ...(await page.locator(".card h3.label").allInnerTexts()),
      ...(await page.locator("button").allInnerTexts()),
    ].join(" \u0000 ");
    const persianChrome = chrome.replace(/فارسی|فا/g, "").match(/[\u0600-\u06FF]+/g);
    record("en/support chrome is fully translated", persianChrome === null, (persianChrome ?? []).join(","));
    await page.screenshot({ path: `${OUT}/02-support-en-desktop.png`, fullPage: true });
    shots.push("02-support-en-desktop.png");
    await ctx.close();
  }

  // ── 3. a real create through the UI ──────────────────────────────────────
  {
    const { ctx, page } = await session({ width: 1366, height: 900 }, "fa");
    await uiLogin(page, userEmail, "");
    await page.goto(`${WEB}/support`, { waitUntil: "networkidle" });
    await page.fill("#sup-subject", "خطا در ورود به حساب");
    await page.fill("#sup-message", "هنگام ورود، پیام «نشست منقضی شده» نمایش داده می‌شود.");
    await page.click(".btn-primary");
    await page.waitForTimeout(1200);
    const body = await page.locator("body").innerText();
    record("UI create shows the Legacy success toast", body.includes("تیکت شما ثبت شد."));
    record("UI create clears the form", (await page.inputValue("#sup-subject")) === "");
    const rows = await page.locator('[role="button"]').count();
    record("UI list shows the created ticket", rows >= 3, `rows=${rows}`);
    await page.screenshot({ path: `${OUT}/03-support-fa-after-create.png`, fullPage: true });
    shots.push("03-support-fa-after-create.png");

    await page.fill("#sup-subject", "موضوع بدون پیام");
    await page.click(".btn-primary");
    await page.waitForTimeout(300);
    const err = await page.locator(".text-error").first().innerText().catch(() => "");
    record("UI shows the localized required-fields error", err.includes("موضوع و پیام الزامی است"), err);
    await page.screenshot({ path: `${OUT}/04-support-fa-validation.png`, fullPage: true });
    shots.push("04-support-fa-validation.png");
    await ctx.close();
  }

  // ── 4. the thread, with both sides ───────────────────────────────────────
  {
    const { ctx, page } = await session({ width: 1366, height: 900 }, "fa");
    await uiLogin(page, userEmail, "");
    await page.goto(`${WEB}/support?ticket=${ticketId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const body = await page.locator("body").innerText();
    record("thread deep link opens the ticket", body.includes("حساب من شارژ نشد"));
    record("thread shows the support side", body.includes("پشتیبانی") && body.includes("درخواست شما دریافت شد"));
    record("thread shows the user side", body.includes("شما"));
    record("thread shows the user's-turn badge", body.includes("در انتظار پاسخ شما"));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    record("thread has no horizontal overflow", overflow <= 0, `overflow=${overflow}`);
    await page.screenshot({ path: `${OUT}/05-support-fa-thread.png`, fullPage: true });
    shots.push("05-support-fa-thread.png");

    await page.fill("#sup-reply", "ممنون، اما هنوز موجودی به‌روزرسانی نشده است.");
    await page.click(".btn-primary");
    await page.waitForTimeout(1500);
    const after = await page.locator("body").innerText();
    record("UI reply is accepted and re-rendered", after.includes("پاسخ ارسال شد.") && after.includes("هنوز موجودی به‌روزرسانی نشده"));
    await page.screenshot({ path: `${OUT}/06-support-fa-after-reply.png`, fullPage: true });
    shots.push("06-support-fa-after-reply.png");
    await ctx.close();
  }

  // ── 5. a CLOSED ticket: reply box hidden, reopen available ───────────────
  {
    const { ctx, page } = await session({ width: 1366, height: 900 }, "fa");
    await uiLogin(page, userEmail, "");
    await page.goto(`${WEB}/support?ticket=${closedId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const replyVisible = await page.locator("#sup-reply").count();
    record("closed thread hides the reply box", replyVisible === 0, `reply inputs=${replyVisible}`);
    const body = await page.locator("body").innerText();
    record("closed thread offers reopen", body.includes("بازگشایی تیکت"));
    record("closed thread shows the closed badge", body.includes("بسته"));
    await page.screenshot({ path: `${OUT}/07-support-fa-closed.png`, fullPage: true });
    shots.push("07-support-fa-closed.png");

    await page.click('button:has-text("بازگشایی تیکت")');
    await page.waitForTimeout(1500);
    const after = await page.locator("body").innerText();
    record("reopen returns the ticket to support", after.includes("تیکت بازگشایی شد") && after.includes("در انتظار پشتیبانی"));
    record("reopened thread shows the reply box again", (await page.locator("#sup-reply").count()) === 1);
    await page.screenshot({ path: `${OUT}/08-support-fa-after-reopen.png`, fullPage: true });
    shots.push("08-support-fa-after-reopen.png");
    await ctx.close();
  }

  // ── 6. mobile + narrowest + en mobile ────────────────────────────────────
  for (const [label, width, height, locale, target] of [
    ["09-support-fa-mobile", 390, 844, "fa", "/support"],
    ["10-support-fa-narrow-320", 320, 844, "fa", "/support"],
    ["11-support-en-mobile", 390, 844, "en", "/en/support"],
  ]) {
    const { ctx, page } = await session({ width, height }, locale);
    await uiLogin(page, userEmail, locale === "fa" ? "" : "/en");
    await page.goto(`${WEB}${target}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    record(`${label} has no horizontal overflow`, overflow <= 0, `overflow=${overflow} @${width}px`);
    await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: true });
    shots.push(`${label}.png`);
    await ctx.close();
  }

  // ── 7. keyboard focus visibility on the support controls ─────────────────
  {
    const { ctx, page } = await session({ width: 1366, height: 900 }, "fa");
    await uiLogin(page, userEmail, "");
    await page.goto(`${WEB}/support`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const results = [];
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { tag: el.tagName, outline: cs.outlineWidth !== "0px" && cs.outlineStyle !== "none", shadow: cs.boxShadow !== "none" };
      });
      if (info && info.tag !== "BODY") results.push(info);
    }
    const visible = results.filter((r) => r.outline || r.shadow).length;
    record("every tabbable support control shows a focus indicator", results.length > 0 && visible === results.length, `${visible}/${results.length}`);
    await page.screenshot({ path: `${OUT}/12-support-fa-focus.png` });
    shots.push("12-support-fa-focus.png");
    await ctx.close();
  }

  // ── 8. honest failure states ─────────────────────────────────────────────
  // Simulated at the BROWSER boundary (the API is healthy in this run), because
  // the point of the check is what the PAGE shows, not how the outage happens.
  {
    const { ctx, page } = await session({ width: 1366, height: 900 }, "fa");
    await uiLogin(page, userEmail, "");
    await page.goto(`${WEB}/support`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.route("**/api/v1/support/**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ status: "error", data: null, error: { code: "SERVICE_UNAVAILABLE", message: "support not configured" }, timestamp: new Date().toISOString() }),
      }),
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const downBody = await page.locator("body").innerText();
    record("backend outage renders the localized load-failed state", downBody.includes("خطا در بارگذاری؛ دوباره تلاش کنید."));
    await page.screenshot({ path: `${OUT}/13-support-fa-api-down.png`, fullPage: true });
    shots.push("13-support-fa-api-down.png");

    await page.unroute("**/api/v1/support/**");
    await page.route("**/api/v1/support/tickets", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ status: "error", data: null, error: { code: "TOO_MANY_REQUESTS", message: "Too many requests" }, timestamp: new Date().toISOString() }),
      }),
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    await page.fill("#sup-subject", "آزمون محدودیت");
    await page.fill("#sup-message", "این درخواست باید با پیام محدودیت پاسخ داده شود.");
    await page.click(".btn-primary");
    await page.waitForTimeout(600);
    const limited = await page.locator("body").innerText();
    record("a 429 renders the localized rate-limit message", limited.includes("بیش از حد"), limited.match(/.{0,40}بیش از حد.{0,40}/)?.[0] ?? "not found");
    await page.screenshot({ path: `${OUT}/14-support-fa-rate-limited.png`, fullPage: true });
    shots.push("14-support-fa-rate-limited.png");
    await ctx.close();
  }

  await browser.close();

  const realErrors = consoleErrors.filter((e) => !/404|503|Failed to load resource/i.test(e));
  record("no unexpected console/page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  writeFileSync(`${OUT}/visual-qa-results.json`, JSON.stringify({ findings, shots, consoleErrors }, null, 2));
  const failed = findings.filter((f) => !f.ok);
  console.log(`\n${findings.length - failed.length}/${findings.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
