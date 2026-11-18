# ADR-021 — Public vs protected public surfaces (W0 decision R8)

## Status

Accepted — owner decision (2026-11-18): **Option C — `/markets` and `/news` public (contract), `/support` behind login (legacy).**

## Context

The W0 gap analysis (audit §10.2 S6 / gap register OD-AC-R8) flagged an open owner decision on whether Legacy's public contract routes (`/markets`, `/news`, `/support`) stay public in Modern or move behind login. MG-SEC-EDGE-AUTHZ notes Legacy's 11 server-gated HTML routes have no modern edge equivalent, and the SEC-04 edge gate (session probe, fail-closed) is on the tree. Wave W7 (docs) and the public-surface work need a binding routing decision before the edge gate and public pages are finalized.

## Decision

**Option C — `/markets` and `/news` public (contract), `/support` behind login (legacy).**

- `/markets` — public, no session required. Renders Legacy's watchlist keys only; no fabricated quotes (Legacy's page was a static demo; Modern says so instead of inventing data).
- `/news` — public, no session required. Static key cards from the ported news chunk; parity is the content, not a fake feed (AC-32).
- `/support` — behind login; the support ticket center (create/thread/reply/reopen) requires an authenticated session, consistent with Legacy's gated ticket center and Phase 5 (support is implemented end-to-end, 29/29 browser QA).
- The SEC-04 edge gate enforces this: protected HTML routes are not served until the API confirms a live session; an unavailable API fails CLOSED (`gate-unavailable`) rather than open.
- Public vs protected status is recorded here so W7 (docs) and any edge-gating work implement against a fixed contract.

## Alternatives considered

- Option A (all three public) — declined: `/support` writes tickets and user data; Legacy gates it, so opening it to unauthenticated users would weaken authorization.
- Option B (all three behind login) — declined: `/markets` and `/news` are public contract surfaces in Legacy; gating them would break the public contract and remove discoverable content.

## Consequences

### Positive
- Public contract preserved for `/markets`/`/news`; `/support` remains authorization-bounded.
- Edge gate (SEC-04) has a clear route-level policy to enforce.

### Negative
- `/support` is unreachable anonymously; unauthenticated users are redirected to login (fail-closed), matching Legacy behavior.

## Migration impact

None — no schema change, no migration.

## Testing / verification requirements

- W7 docs and edge-gating tests pin `/markets`/`/news` public (200 anonymous) and `/support` redirected to login (302) / 401 without session.
- `protectedRoutes.test.ts` and proxy HSTS/no-store pins continue to pass.

## Phase

Phase 2 wave W7 (docs/public surfaces) and the edge-gating surface. Blocks MG-G06 and MG-SEC-EDGE-AUTHZ (R8 decision + browser verification).
