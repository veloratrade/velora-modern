import { chromium } from '/home/user/.npm/_npx/c828ed9cb5b1a5eb/node_modules/playwright/index.mjs';
const base = 'http://localhost:3999';
const routes = ['/login/','/register/','/dashboard/','/trades/','/trades/new/','/accounts/connect/','/profile/','/markets/','/news/','/performance/','/wallet/','/intelligence/','/support/'];
const browser = await chromium.launch();
for (const loc of ['fa','en']) {
  for (const w of [1366, 420]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 });
    await ctx.addCookies([{ name: 'velora_locale', value: loc, url: base }]);
    await ctx.addInitScript((l) => localStorage.setItem('velora.locale', l), loc);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    for (const r of routes) {
      await page.goto(base + r, { waitUntil: 'networkidle' }).catch(()=>{});
      await page.waitForTimeout(400);
      const dir = await page.evaluate(() => document.documentElement.dir + '/' + document.documentElement.lang);
      const name = `${loc}_${w}_${r.replace(/\//g,'_').replace(/^_|_$/g,'')||'root'}.png`;
      await page.screenshot({ path: 'shots/' + name, fullPage: true });
      console.log(name, dir, errors.length ? 'ERRORS:' + errors.splice(0).join(' | ').slice(0,200) : 'ok');
    }
    await ctx.close();
  }
}
await browser.close();
