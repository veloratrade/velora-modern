// Round 5 — real-browser verification of the admin "Agent tools" tab.
//
// Drives the REAL Next dev server (apps/web) which rewrites /api to the REAL API
// app booted by ./server.mts with a mocked provider fetch. Everything asserted
// here is asserted on RENDERED DOM: what a human would see, in both locales,
// with real cookies, real bearer flows, real refusals. The response/console tap
// additionally scans every byte the browser received for the rig's sentinel
// canary — if a route ever leaked a credential value into a client-visible body,
// this run reports LEAK, not a green check.
//
// One CONTEXT PER PERSONA: the session cookie is real, and the login page
// redirects a caller who already holds one — sharing a context between accounts
// would silently test root's permissions under admin's name. Isolation is not
// convenience here, it is what makes the permission assertions mean anything.
//
// Usage: PLAYWRIGHT_BROWSERS_PATH=/opt/playwright/browsers node node_modules/tsx/dist/cli.mjs tools/admin-ui-verify/browser.mts --scenario=<name>
import playwright from "file:///opt/playwright/node_modules/playwright/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
const { chromium } = playwright;

const WEB = "http://localhost:3000";
const SCENARIO = process.argv.find((a) => a.startsWith("--scenario="))?.slice(11) ?? "configured";
const SENTINEL = "RIGSENTINEL-do-not-log-4f7c2a";
const PW = "local-verify-rig-password-123";
const OUT = `docs/state/evidence/admin-ui-round5/${SCENARIO}`;
mkdirSync(OUT, { recursive: true });

const checks: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail.slice(0, 240)}`}`);
};

// The sandbox has ~2 GB; a Chromium context is worth ~150 MB and Next dev is worth more. Launch lean,
// and CLOSE EVERY CONTEXT THE MOMENT ITS PERSONA IS DONE — five live contexts is how the last run OOM-killed
// the dev server mid-scenario, which is a failure of this driver, not of the product.
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-background-networking", "--renderer-process-limit=1", "--disable-extensions", "--mute-audio"] });
const captured: { url: string; status: number }[] = [];
const consoleLines: string[] = [];
let leak = "";

async function session(): Promise<any> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // The dev server compiles each route ONCE, serially; a cold navigation can wait on a compile that
  // has nothing to do with this page. Playwright's 30s default measures the queue, not the app.
  context.setDefaultNavigationTimeout(120_000);
  context.on("page", (page: any) => {
    page.on("response", async (res: any) => {
      try {
        const url: string = res.url();
        if (!url.includes("/api/")) return;
        const body: string = await res.text().catch(() => "");
        captured.push({ url, status: res.status() });
        if (body.includes(SENTINEL)) leak = leak || `response ${url}`;
      } catch {
        /* capture is best-effort; assertions never depend on it */
      }
    });
    page.on("console", (msg: any) => {
      const text = msg.text();
      consoleLines.push(text);
      if (text.includes(SENTINEL)) leak = leak || "console line";
    });
  });
  return context.newPage();
}

async function login(page: any, email: string): Promise<void> {
  await page.goto(`${WEB}/en/login`, { waitUntil: "commit" });
  await page.fill("#email", email, { timeout: 60_000 });
  await page.fill("#password", PW, { timeout: 30_000 });
  await page.click('form button[type="submit"]');
  await page.waitForURL((u: URL) => !u.pathname.includes("login"), { timeout: 60_000 });
}

async function openAdmin(page: any): Promise<void> {
  // After login the client router immediately prefetches EVERY sidebar link (that is what the wave of
  // `?_rsc=` requests is). A goto issued into that storm queues behind it — the earlier 120 s timeouts
  // here measured Next's queue, not the admin page. One quiet settle, then the goto, then — if the tabs
  // still have not arrived — one retry: a hang that repeats after the storm is a real hang and must fail.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  try {
    await page.goto(`${WEB}/en/admin`, { waitUntil: "commit" });
    await page.waitForSelector('button[role="tab"]', { timeout: 45_000 });
  } catch (err) {
    await page.waitForTimeout(3_000);
    await page.goto(`${WEB}/en/admin`, { waitUntil: "commit" });
    await page.waitForSelector('button[role="tab"]', { timeout: 60_000 });
  }
}

async function adminConsoleOpensFor(page: any): Promise<boolean> {
  // The route guard sends a caller without console permission to their dashboard, not to a blank admin
  // page — that is the app protecting itself, and the honest assertion is "the console did not open",
  // not a guess about WHICH safe page it landed on.
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.goto(`${WEB}/en/admin`, { waitUntil: "commit" });
  const tabs = await page.waitForSelector('button[role="tab"]', { timeout: 45_000 }).then(() => true).catch(() => false);
  return tabs && page.url().includes("/admin");
}

async function clickAiTab(page: any): Promise<void> {
  await page.click('button[role="tab"]:has-text("Agent tools")');
  await page.waitForSelector("#adm-ai-tools-table, .text-error", { timeout: 30_000 });
}

try {
  if (SCENARIO === "configured") {
    // ── the operator who may both read and probe ───────────────────────────────
    const page = await session();
    await login(page, "root@verify.local");
    await openAdmin(page);
    record("tab visible to super_admin", await page.locator('button[role="tab"]:has-text("Agent tools")').count() === 1);
    await clickAiTab(page);
    const rows = page.locator("#adm-ai-tools-table tbody tr");
    record("three tool rows rendered", (await rows.count()) === 3, `count=${await rows.count()}`);
    const first = rows.first();
    record(
      "web_search starts at 'Configured, not checked'",
      (await first.locator("td").nth(2).innerText()).includes("Configured, not checked"),
      await first.locator("td").nth(2).innerText(),
    );
    // The credentials column lists KEY NAMES with presence flags — never values.
    const creds = await first.locator("td").nth(3).innerText();
    record("credentials column names keys + presence", creds.includes("TAVILY_API_KEY") && creds.includes("set"), creds);
    record("no 'Last checked' column on a never-caching endpoint", !(await page.locator("thead").innerText()).includes("Last checked"));
    record("no sentinel in the DOM", !(await page.content()).includes(SENTINEL));
    const headBadge = await page.locator(".page-head .badge", { hasText: /tools/i }).first().innerText();
    record("the header badge states the tool count", headBadge.includes("3"), headBadge);
    await page.screenshot({ path: `${OUT}/01-before-validate.png`, fullPage: true });

    // ── Validate: the one live probe button, pressed by a human ────────────────
    await page.click("#adm-ai-validate-web_search");
    await page.waitForSelector("#adm-ai-verdict", { timeout: 30_000 });
    const meta = await page.locator("#adm-ai-verdict").innerText();
    record(
      "verdict line carries the evidence: state, status, latency, instant",
      meta.includes("The provider answered") && meta.includes("Verified just now") && meta.includes("VALID") && /\d+ ms/.test(meta),
      meta,
    );
    const stateAfter = await rows.first().locator("td").nth(2).innerText();
    // THE ANTI-LIE ASSERTION: a green check must NOT rewrite the table. If a future change "makes the UI
    // nicer" by painting the row verified from page state, this goes red — and it should, because that
    // paint is exactly the stale-green the no-cache design refuses to show.
    record("row does NOT flip — the table reports keys, not cached verdicts", stateAfter.includes("Configured, not checked"), stateAfter);
    record("the panel explains why the row did not move", (await page.locator("body").innerText()).includes("never cached"));
    await page.screenshot({ path: `${OUT}/02-after-validate.png`, fullPage: true });

    // A hard reload must show NO stale green: the verdict was momentary by contract.
    await page.reload({ waitUntil: "commit" });
    await page.waitForSelector('button[role="tab"]', { timeout: 60_000 });
    await clickAiTab(page);
    const afterReload = await page.locator("#adm-ai-tools-table tbody tr").first().locator("td").nth(2).innerText();
    record("no stale green after reload — the verdict was momentary, the keys are now", afterReload.includes("Configured, not checked"), afterReload);
    record("the verdict line is gone after reload (not kept in page memory)", (await page.locator("#adm-ai-verdict").count()) === 0);

    // ── the audit trail, through the product's own audit tab ──────────────────
    await page.click('button[role="tab"]:has-text("Audit log"), button[role="tab"]:has-text("Audit")');
    await page.waitForTimeout(1500);
    const auditText = await page.locator("body").innerText();
    record(
      "audit tab shows AI_TOOL_VALIDATED with its verdict",
      auditText.includes("AI_TOOL_VALIDATED") && auditText.includes("tool:web_search verdict:ok"),
      auditText.slice(auditText.indexOf("AI_TOOL_VALIDATED"), auditText.indexOf("AI_TOOL_VALIDATED") + 120),
    );
    record("no sentinel in the audit tab DOM", !(await page.content()).includes(SENTINEL));
    await page.screenshot({ path: `${OUT}/03-audit-tab.png`, fullPage: true });
    await page.context().close(); // the root session ends here; a second one opens for fa

    // ── admin (read, not probe): the button must not exist for it ──────────────
    const page2 = await session();
    await login(page2, "admin@verify.local");
    await openAdmin(page2);
    await clickAiTab(page2);
    record("admin sees the rows", (await page2.locator("#adm-ai-tools-table tbody tr").count()) === 3);
    record("admin sees NO probe button", (await page2.locator("#adm-ai-validate-web_search").count()) === 0);
    const note2 = await page2.locator("body").innerText();
    record("admin is TOLD why (needsPermission copy)", note2.includes("super-admin route permission"), "panel says reading ≠ probing");
    await page2.screenshot({ path: `${OUT}/04-admin-no-button.png`, fullPage: true });

    // …and the refusal is the ROUTE's, not the button's: call it directly.
    const direct = await page2.evaluate(async (pw: string) => {
      const login = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@verify.local", password: pw }),
      });
      const token = (await login.json()).data.tokens.accessToken as string;
      const v = await fetch("/api/v1/admin/ai/tools/web_search/validate", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      return { status: v.status, body: (await v.text()).slice(0, 400) };
    }, PW);
    record("direct POST as admin → 403 from the route", direct.status === 403, JSON.stringify(direct).slice(0, 160));
    record("the refusal carries no secret material", !direct.body.includes(SENTINEL) && !direct.body.toLowerCase().includes("tavily"), direct.body.slice(0, 120));
    await page2.context().close(); // the admin session has now also proven the ROUTE refusal, in-browser

    // ── plain user: no tab at all, and the API refuses the URL itself ──────────
    const page3 = await session();
    await login(page3, "plain@verify.local");
    const consoleOpened = await adminConsoleOpensFor(page3);
    record("plain user: the console never opens for them (route guard moved them)", !consoleOpened, page3.url());
    record("plain user: no Agent-tools tab anywhere on screen", !consoleOpened || (await page3.locator('button[role="tab"]:has-text("Agent tools")').count()) === 0);
    const forbidden = await page3.evaluate(async (pw: string) => {
      const login = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "plain@verify.local", password: pw }),
      });
      const token = (await login.json()).data.tokens.accessToken as string;
      const g = await fetch("/api/v1/admin/ai/tools", { headers: { authorization: `Bearer ${token}` } });
      return { status: g.status, body: (await g.text()).slice(0, 300) };
    }, PW);
    record("plain user: GET /admin/ai/tools → 403 in-browser", forbidden.status === 403, JSON.stringify(forbidden).slice(0, 160));
    await page3.screenshot({ path: `${OUT}/05-plain-user.png`, fullPage: true });
    await page3.context().close();

    // ── Persian rendering of the same tab (design system, not a translation stub)
    const pageFa = await session();
    await login(pageFa, "root@verify.local");
    await pageFa.goto(`${WEB}/admin`, { waitUntil: "commit" });
    await pageFa.waitForSelector('button[role="tab"]', { timeout: 60_000 });
    await pageFa.click('button[role="tab"]:has-text("ابزارهای ایجنت")');
    await pageFa.waitForSelector("#adm-ai-tools-table", { timeout: 30_000 });
    const faBadge = await pageFa.locator("#adm-ai-tools-table tbody tr").first().locator("td").nth(2).innerText();
    record("fa tab renders Persian state label", /[\u0600-\u06FF]/.test(faBadge), faBadge);
    const faDir = await pageFa.evaluate(() => document.documentElement.dir || document.body.closest("[dir]")?.getAttribute("dir") || "");
    record("fa render is rtl-context", faDir === "rtl" || faDir === "auto", `dir=${faDir}`);
    await pageFa.screenshot({ path: `${OUT}/06-fa-tab.png`, fullPage: true });
    await pageFa.context().close();
  }

  if (SCENARIO === "reject") {
    const page = await session();
    await login(page, "root@verify.local");
    await openAdmin(page);
    await clickAiTab(page);
    await page.click("#adm-ai-validate-web_search");
    await page.waitForSelector("#adm-ai-verdict, .text-error", { timeout: 30_000 });
    const line = await page.locator("#adm-ai-verdict").innerText();
    const body = await page.locator("body").innerText();
    record("424 is presented as a verdict, not success", body.includes("The provider did not answer") && !body.includes("Verified just now"), line);
    record("the verdict names the code the provider returned", line.includes("STATUS") || line.includes("UNKNOWN"), line);
    const badge = await page.locator("#adm-ai-tools-table tbody tr").first().locator("td").nth(2).innerText();
    record("row is unchanged by a refused probe (no cached failing either)", badge.includes("Configured, not checked"), badge);
    await page.screenshot({ path: `${OUT}/01-reject-verdict.png`, fullPage: true });
    await page.context().close();
  }

  if (SCENARIO === "hang") {
    const page = await session();
    await login(page, "root@verify.local");
    await openAdmin(page);
    await clickAiTab(page);
    await page.click("#adm-ai-validate-web_search");
    // While the probe is in flight, the SAME button must not be pressable again:
    // a second click would spend a second provider request on one intention.
    await page.waitForTimeout(400);
    record("button disabled while probing (no double-spend)", await page.locator("#adm-ai-validate-web_search").isDisabled());
    const label = await page.locator("#adm-ai-validate-web_search").innerText();
    record("button says 'Checking…' mid-flight", label.includes("Checking"), label);
    await page.screenshot({ path: `${OUT}/01-in-flight.png`, fullPage: true });
    await page.waitForSelector("#adm-ai-verdict", { timeout: 40_000 });
    const verdict = await page.locator("#adm-ai-verdict").innerText();
    record("timeout verdict is failure, never a stale 'verified'", verdict.includes("did not answer"), verdict);
    record("the timeout verdict carries its code", verdict.includes("TIMEOUT") || verdict.includes("NETWORK_ERROR"), verdict);
    const badge = await page.locator("#adm-ai-tools-table tbody tr").first().locator("td").nth(2).innerText();
    record("row unchanged after the timeout", badge.includes("Configured, not checked"), badge);
    await page.screenshot({ path: `${OUT}/02-after-timeout.png`, fullPage: true });
    await page.context().close();
  }

  if (SCENARIO === "worker") {
    const page = await session();
    await login(page, "root@verify.local");
    await openAdmin(page);
    await clickAiTab(page);
    const banner = page.locator("#adm-ai-tools-table tbody tr", { hasText: "banner_raster" });
    const badge = await banner.locator("td").nth(2).innerText();
    record("raster row says 'Not possible in this runtime'", badge.includes("Not possible in this runtime"), badge);
    record("raster row is NOT rendered as mere 'Not configured'", !badge.includes("Not configured"), badge);
    await banner.locator("button").click();
    await page.waitForSelector("#adm-ai-verdict, .text-error", { timeout: 20_000 });
    const body = await page.locator("body").innerText();
    record("probe of an unverifiable tool says 'no request was sent'", body.includes("no request was sent"), body.slice(Math.max(0, body.indexOf("banner_raster") - 40), body.indexOf("banner_raster") + 400));
    await page.screenshot({ path: `${OUT}/01-worker-unsupported.png`, fullPage: true });
    await page.context().close();
  }

  if (SCENARIO === "none") {
    const page = await session();
    await login(page, "root@verify.local");
    await openAdmin(page);
    await clickAiTab(page);
    const body = await page.locator("body").innerText();
    record("absent tool services → error state, not an empty table", (await page.locator("#adm-ai-tools-table").count()) === 0 && body.includes("loaded"), "");
    await page.screenshot({ path: `${OUT}/01-no-capability.png`, fullPage: true });
    await page.context().close();
  }

  if (SCENARIO === "nosecret") {
    const page = await session();
    await login(page, "root@verify.local");
    await openAdmin(page);
    await clickAiTab(page);
    const badge = await page.locator("#adm-ai-tools-table tbody tr").first().locator("td").nth(2).innerText();
    record("without credentials the row says 'Not configured'", badge.includes("Not configured"), badge);
    const creds = await page.locator("#adm-ai-tools-table tbody tr").first().locator("td").nth(3).innerText();
    record("the credentials cell names the missing key", creds.includes("TAVILY_API_KEY") && creds.includes("missing"), creds);
    const reason = await page.locator("#adm-ai-tools-table tbody tr").first().locator("td").nth(4).innerText();
    record("and the reason column carries the code", reason.includes("MISSING_API_KEY"), reason);
    await page.click("#adm-ai-validate-web_search");
    await page.waitForSelector("#adm-ai-verdict", { timeout: 30_000 });
    const verdict = await page.locator("#adm-ai-verdict").innerText();
    record("probe-without-credential is a stated verdict, not silence", verdict.includes("did not answer") && verdict.includes("NOT_CONFIGURED"), verdict);
    await page.screenshot({ path: `${OUT}/01-unavailable.png`, fullPage: true });
    await page.context().close();
  }
} catch (err) {
  // A thrown driver error must never masquerade as a passing run: it is recorded AS a failed check.
  record("driver completed", false, `${(err as Error).name}: ${String((err as Error).message).slice(0, 300)}`);
} finally {
  record("no sentinel leaked in any response or console", leak === "", leak || "clean");
  const failed = checks.filter((c) => !c.ok);
  writeFileSync(
    `${OUT}/results.json`,
    JSON.stringify({ scenario: SCENARIO, checks, failures: failed.length, apiResponses: captured.length }, null, 2),
  );
  console.log(`SCENARIO=${SCENARIO} checks=${checks.length} failures=${failed.length}`);
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
}
