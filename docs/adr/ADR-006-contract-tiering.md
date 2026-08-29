# ADR-006 — Contract Tiering

## Status

Accepted — owner decision D-12 (2026-08-29): two-tier contract model + frozen external tier (`docs/external-contracts.md`) approved. C-11 consumer verification remains a Phase 1 item; C-15 structured-data added as an unfrozen candidate row.

## Context

"Reproduce the PHP API" is the wrong goal. Only externally-observed behavior
must stay compatible; internals may be redesigned. Freezing everything would
smuggle PHP's shape into the modern system.

## Verified Evidence

- 38 API routes exist (VERIFIED baseline §4 route table) — the vast majority are
  consumed only by Velora's own frontend (internal tier).
- Externally observed surfaces (VERIFIED): MetaApi webhook endpoint (HMAC),
  email links (`/verify-email#token=`, `/reset-password#token=` exact formats),
  public pages + sitemap/robots content, locale routing + `X-VELORA-Locale` header,
  `GET /health` envelope `{status, data:{status:"ok"}}` (B-8 contract, live-tested),
  public `POST /api/v1/content-translations/lookup`, fixed email From identity,
  GSC verification file.

## Decision

**Two tiers:**

1. **Frozen external tier** (inventory + freeze status in `docs/external-contracts.md`):
   - MetaApi webhook contract (path, HMAC scheme, response semantics)
   - email verification & reset link formats
   - public/SEO routes, sitemap.xml, robots.txt behavior, locale URLs, `X-VELORA-Locale`
   - `GET /health` envelope
   - externally consumed callbacks (n8n article pipeline interface)
   Any change to this tier = versioned migration + owner approval.

2. **Internal tier:** everything else (all `/api/v1/*` app routes consumed by
   Velora's own UI) may be redesigned freely; the modern frontend and the contracts
   package define them.

**Principle (binding):**

> PHP implementation shape is not the architecture of the modern system.

**Parity binding:** the parity suite (docs/parity-plan.md) tests the **external
tier first and strictly**; internal-tier parity is tested only as business-outcome
equivalence (via journey tests), never field-by-field response cloning.

## Alternatives Considered

- Freeze all 38 routes: rejected (recreates PHP internals; blocks improvement).
- Freeze nothing: rejected (breaks webhooks, email links, SEO at cutover).

## Consequences

### Positive
- Redesign freedom where it is safe; compatibility where it is required.
- Small, explicitly-maintained frozen surface (testable exhaustively).

### Negative
- Tier membership is a maintained decision (new endpoints need classification at PR time — registry checklist item).

## Security Impact

Frozen tier includes security-relevant behaviors (webhook verification, health
shape, origin guards on public POSTs) — they get first-class tests, never drift silently.

## Migration Impact

Cutover only has to preserve the frozen tier externally; everything else switches with the frontend.

## Testing / Verification Requirements

- External-contract suite must cover 100% of `docs/external-contracts.md` rows (parity-plan).
- CI check: every new API route PR declares its tier (registry/lint rule).

## Open Questions

1. Whether `content-translations/lookup` payload shape is consumed by third parties (assumed Velora-frontend-only — NEEDS VERIFICATION before freeze classification is final).

## Phase

Phase 0 decision; contract inventory live from Phase 1.
