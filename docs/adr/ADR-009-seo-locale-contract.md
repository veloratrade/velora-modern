# ADR-009 — SEO & Locale Contract

## Status

Accepted — owner decision D-14 (2026-08-29): route-map contract, locale URL strategy, `X-VELORA-Locale`, cache classes A–D, CSP-nonce policy approved. **Checkout URL shape decided: `/fa/checkout` + `/en/checkout`** (resolves F-03 design). hreflang/canonical current-state verification remains a Phase 2 item.

## Context

Velora's public surface is SEO-critical and bilingual fa/en. The PHP repo's own
finding F-10 documents SEO/locale drift **within a single stack** — this is a
contract problem, not a frontend detail. Next.js does not solve SEO automatically.

## Verified Evidence

- Public route map (VERIFIED from sitemap.xml + robots.txt + repo tree):
  `/` (fa default), `/en/`, `/register`, `/login`, `/forgot-password`, `/privacy`,
  `/terms`, `/blog/*` (multiple articles), `/support`, `/news`, `/markets`;
  app routes disallowed: `/dashboard`, `/trades`, `/accounts`, `/profile`,
  `/wallet`, `/performance`, `/intelligence`, `/api/`, `/admin/` (VERIFIED robots.txt).
- `X-VELORA-Locale` response header (VERIFIED: emitted by router/locale-router;
  checked by the live healthcheck suite).
- Environment-differentiated SEO (VERIFIED): staging sitemap → 404 + `X-Robots-Tag:
  noindex,nofollow` + robots `Disallow: /`; production sitemap → 200, indexable.
- Known defect F-03 (VERIFIED docs): checkout bypasses locale routing; no
  independent EN route. Known defect F-04: 161 Persian nodes leaked into EN output.
- hreflang/canonical implementation detail: NEEDS VERIFICATION (F-10 says drift exists).

## Decision

1. **Route map is contractual:** the verified public URL set above is the modern
   system's URL contract; changes require 301 mappings (maintained in
   `docs/external-contracts.md` before cutover).
2. **Locale URLs:** `/` = fa default, `/en/` prefix for English (status-quo);
   `X-VELORA-Locale` header preserved (frozen external tier). All routes have a
   defined locale variant or explicit exclusion (fixes F-03-class bypasses by design).
   **Checkout (F-03) — DECIDED (owner decision D-14, 2026-08-29): `/fa/checkout` +
   `/en/checkout`.** Note: fa routes are otherwise prefixless; whether a prefixless
   `/checkout` alias/redirect is also served is a Phase 2 route-map detail under
   this ADR — not decided here.
3. **SEO surface contracts:** sitemap (DB-driven, env-gated as today), robots
   (env-differentiated), canonical per page, hreflang fa/en pairs (verify current
   state, then freeze correct behavior), structured-data registry (inventory in Phase 2).
4. **Cache classes — deliberately different by route class:**

| Class | Routes | Policy |
|---|---|---|
| A — market data | `/markets`, market JSON | short s-maxage + stale-while-revalidate (minutes) |
| B — editorial | `/blog/*`, `/news` | ISR long TTL + tag-based invalidation on publish |
| C — static public | auth/legal/support pages | long cache, versioned assets |
| D — authenticated app | dashboard etc. | private, no-store, never CDN-cached |

5. **CSP:** strict CSP with nonce propagation through middleware from day one;
   CSP guard test in CI (PHP-repo philosophy adapted). No `unsafe-inline` budget.
6. **GSC:** verification preserved; cutover includes GSC re-verification on the
   new origin + sitemap resubmission.
7. **Metadata discipline:** title/description/OG per page per locale from the
   i18n catalog — validators (ported rules: parity, placeholders, hardcoded-UI
   freeze, bilingual SEO guardrails) run in modern CI.

## Alternatives Considered

- Single-locale URLs with cookie switching: rejected (SEO regression; loses /en/ indexation).
- One cache policy everywhere: rejected (market data staleness vs editorial freshness conflict — explicitly: market data ≠ blog ≠ static).

## Consequences

### Positive
- Zero-SEO-loss cutover path; drift becomes a CI failure, not a discovery.
- Performance policy matched to content type.

### Negative
- Route-class table must be maintained (small, reviewed).

## Security Impact

Class D must never be cached (private data leakage); CSP nonces constrain XSS.
Locale routing rules prevent bypasses of the F-03 class.

## Migration Impact

301 map only for changed URLs (goal: none); sitemap/robots parity tested at cutover rehearsal.

## Testing / Verification Requirements

- Parity suite categories: public routes, locale headers, sitemap/robots env behavior.
- CI validators for i18n + SEO metadata (ported, blocking).

## Open Questions

1. Current hreflang/canonical exact state (NEEDS VERIFICATION — then frozen).
2. Checkout route locale design — **RESOLVED**: `/fa/checkout` + `/en/checkout` (owner decision D-14, 2026-08-29); prefixless-alias detail deferred to Phase 2 route-map work.

## Phase

Phase 0 decision; implementation = Phase 2 wave ①; cutover checks = Phase 4.
