# Phase 1 — visual & responsive QA evidence (2026-10-04)

Screenshots from a real browser (Playwright/Chromium 153) against the **production build**
(`next build` + `next start`, `VELORA_API_ORIGIN` → the live API on PostgreSQL 16.15), signed in
with a real account created through the public register → verify → login flow.

Why the production build: in this sandbox the dev server never completes hydration (the HMR
WebSocket handshake fails with `ERR_INVALID_HTTP_RESPONSE`), so anything measured on `next dev`
would describe the environment, not the product. `next start` also exercises the strict CSP.

| File | View | Locale / dir | Viewport |
|---|---|---|---|
| `01-profile-fa-desktop.png` | `/profile` | fa · rtl | 1366×900 |
| `02-settings-fa-desktop.png` | `/settings` (Security + Preferences + E-mail) | fa · rtl | 1366×900 |
| `03-settings-fa-after-toggle.png` | `/settings` after an e-mail toggle (server-answered state) | fa · rtl | 1366×900 |
| `04-settings-fa-password-error.png` | `/settings` wrong current password → localized alert | fa · rtl | 1366×900 |
| `05-settings-fa-mobile.png` | `/settings` | fa · rtl | 390×844 |
| `06-profile-fa-mobile.png` | `/profile` | fa · rtl | 390×844 |
| `07-settings-en-desktop.png` | `/en/settings` | en · ltr | 1366×900 |
| `08-profile-en-desktop.png` | `/en/profile` | en · ltr | 1366×900 |
| `09-settings-after-locale-switch.png` | after switching the locale select EN→fa | fa · rtl | 1366×900 |
| `10-mobile-drawer-closed.png` | mobile nav drawer, closed | fa · rtl | 390×844 |
| `11-mobile-drawer-open.png` | mobile nav drawer, open | fa · rtl | 390×844 |
| `12-profile-narrow-320.png` | `/profile` at the narrowest supported width | fa · rtl | 320×844 |
| `13-settings-en-mobile.png` | `/en/settings` | en · ltr | 390×844 |

## What was checked, and the result

1. **Horizontal overflow** — `document.documentElement.scrollWidth - innerWidth` is **0** at
   1366 / 390 / 320 px in both locales, and no element spills outside the viewport except the
   intentionally off-canvas closed drawer.
2. **RTL/LTR** — `dir=rtl` + `lang=fa-IR-u-nu-latn` on the fa routes, `dir=ltr` on `/en/*`;
   Latin digits everywhere (`v-latn-num`), Persian label alignment unchanged.
3. **Localization** — the ONLY Persian text left on an English page is `فا` (the locale toggle's
   target) and `فارسی` (a language's own name inside the language select). Both are intentional.
   The Persian nav label that used to appear in the English shell is fixed and guarded by
   `src/i18n/shellSurface.test.ts`.
4. **States** — loading (skeleton/`…`), success note («ترجیحات اعلان ایمیل بهروزرسانی شد.»),
   error alert («رمز عبور فعلی نادرست است.»), client validation («رمز جدید باید حداقل 10 کاراکتر باشد.»),
   honest unavailability (Telegram «روی این نصب فعال نیست», HTTP 503), and empty/disabled states
   before `/auth/me` resolves.
5. **Interactions** — all 6 e-mail toggles + the AI-consent toggle persist through the server
   (state re-read after reload / from the response body), the locale select navigates to the other
   locale's route, and the change-password form keeps the field values on failure.
6. **Keyboard/a11y** — tab order: logo → 11 nav items → account card → sign-out → locale toggle →
   page link → password fields → submit → consent → 6 e-mail toggles. **Every control shows a
   visible focus ring** (the only element without one is `<body>` at the wrap-around point).
7. **Console** — no page errors, no React hydration warnings. The only console noise is the
   expected `503 /v1/telegram/status` (Telegram is not configured on this installation) and the
   deliberate `400 /v1/auth/change-password` from the wrong-password check.
8. **Design preservation** — obsidian/glass/gold unchanged, Estedad loaded, density and spacing
   identical to the pre-existing pages, cards/badges/buttons/inputs reused (no new component kit,
   no layout redesign, no nav flattening).
9. **Rate limit (observed, not simulated)** — after roughly forty authenticated page loads the
   API's Postgres-backed `auth:refresh` bucket (30/300 s) returned **429**; the shell degraded
   correctly (redirect to `/login`, no crash, no unhandled rejection). Counts are visible in the
   `rate_limits` table.
