# VELORA-MODERN — External Contract Inventory (Frozen Tier)

Per ADR-006: only externally meaningful contracts are listed. Internal PHP routes
are deliberately absent. "Frozen?" = proposed classification for owner review.

| # | Contract | Current behavior (VERIFIED unless noted) | Source evidence | Frozen? | Consumer | Modern implementation target | Test requirement | Migration risk |
|---|---|---|---|---|---|---|---|---|
| C-01 | Health endpoint | `GET /health` → 200, envelope `{status, data:{status:"ok"}}`, proves DB connectivity | baseline §4 (B-8), live-tested | YES | monitors, deploy gates | same path+envelope; semantic equality | parity suite: exact envelope match both stacks | Low |
| C-02 | Locale routing + header | `/` = fa, `/en/`; `X-VELORA-Locale` header on responses | router/locale-router source + healthcheck suite | YES | browsers, SEO | middleware-based routing, same URLs + header | parity: header + status per route | Medium (route drift, F-10) |
| C-03 | Public page URLs | `/`, `/en/`, `/register`, `/login`, `/forgot-password`, `/privacy`, `/terms`, `/blog/*`, `/support`, `/news`, `/markets` | sitemap.xml (verified) | YES | users, search engines | identical URL set; changes only with 301 map | parity: status+locale per URL; URL inventory diff | Medium |
| C-04 | sitemap.xml | 200 in production; staging deliberately 404 | healthcheck suite (verified) | YES (env behavior) | search engines | DB-driven, env-gated identically | parity per environment | Low |
| C-05 | robots.txt | prod allow-listing (app dirs disallowed), staging `Disallow: /` | robots.txt (verified content) | YES | crawlers | same semantics | parity exact | Low |
| C-06 | Email verification link | `{frontend_url}/verify-email#token=<rawurlencoded>`; token single-use; removed from history post-click | AuthService (verified line) | YES | users' email clients | same URL shape + fragment semantics | link-format contract test + journey test | Medium (link-breaking = verification loss) |
| C-07 | Password reset link | `{frontend_url}/reset-password#token=<...>`; single-use token | PasswordService (verified line) | YES | users' email clients | same shape | journey test | Medium |
| C-08 | MetaApi webhook | `POST /api/v1/webhooks/metaapi`; public transport; HMAC verified in service; test route dev-only (prod 404) | controller + docs (verified) | YES (path + auth scheme) | MetaApi cloud | ADR-008 pipeline; same path + HMAC scheme; header details verified in Phase 2 | signature/replay vectors + dedupe | Medium (secret rotation window) |
| C-09 | Email From identity | fixed `VELORA TRADE <no-reply@veloratrade.ir>`; Resend transport; 7 templates, CID icons | live-verified suites | YES (identity) | mailbox providers (reputation!) | same From + templates (rebuilt as code) | template contract tests (ported assertions) | Medium (deliverability reputation) |
| C-10 | Response envelope | `{status, data…}` on all public/external endpoints | B-8 contract (verified) | YES (external tier only) | email clients' link targets, monitors | preserved on external tier | envelope shape assertions | Low |
| C-11 | Content translation lookup | `POST /api/v1/content-translations/lookup` public | baseline §4 (verified) | ASSUMED Velora-UI-only — VERIFY; if 3rd-party consumers exist → freeze | Velora frontend (assumed) | redesignable unless verification finds consumers | classification test in Phase 1 | Low |
| C-12 | n8n article pipeline interface | n8n (approved+archived gate) → GitHub/site content | N8N_ARCHIVE_AGENT (verified docs) | YES (gate semantics) | n8n automation | Phase 3 adapter; approval authority stays n8n+human | gate tests (no auto-publish) | Medium (workflow rewiring) |
| C-13 | GSC verification | verification file on origin | repo file (verified presence) | YES | Google Search Console | preserved on new origin | cutover checklist item | Low |
| C-14 | Auth link expiry/limits | resend-verification 4/3600s etc. | baseline §4 (verified limits) | PARTIAL (limits as defaults, tunable) | users | carried as defaults | throttle parity tests | Low |

## Maintenance rules

- Any change to a frozen row: versioned, owner-approved, with migration note (e.g., 301 map).
- New endpoints declare tier at PR time (ADR-006 CI rule).
- This file is the parity suite's source of truth for scope (docs/parity-plan.md).
