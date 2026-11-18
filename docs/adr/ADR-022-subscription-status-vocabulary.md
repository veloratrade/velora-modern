# ADR-022 — Subscription status vocabulary mapping (W0 decision OD-AC-SUBMAP)

## Status

Accepted — owner decision (2026-11-18): **Option A — provider-agnostic subscription model; keep history.**

## Context

The W0 gap analysis (audit §8.1 / §14 / gap register OD-AC-SUBMAP, MG-SCHEMA-MAPPING) flagged an open owner decision on how Modern maps Legacy's subscription lifecycle statuses (`grace`, `expired`, and related) onto Modern's `subscriptions` table. AC-13's load rehearsal established that Modern `subscriptions` (migration 0017) is the Stripe object and is **not** a target for Legacy's provider-less lifecycle — those columns are recorded as unmapped with reason. Wave W1 item A3 (subscription POST) needs a binding decision before a subscription endpoint is implemented: model subscriptions as a Stripe-backed provider-agnostic lifecycle with history preserved, or attempt to force Legacy's provider-less statuses onto the Stripe object.

## Decision

**Option A — provider-agnostic subscription model; keep history.**

- Modern's `subscriptions` table remains the Stripe object (per the AC-13 rehearsal finding); it is NOT repurposed as Legacy's provider-less lifecycle container.
- Subscription status vocabulary is modeled provider-agnostically on top of the Stripe object: statuses such as `grace` and `expired` are derived/computed Modern concepts layered over Stripe's native lifecycle (trial, active, past_due, canceled, unpaid, incomplete, incomplete_expired), not written directly as Legacy status strings into `subscriptions.status`.
- History is kept: no legacy subscription row is dropped, rewritten, or archived; the mapping is additive and read-side where it exists.
- Wave W1 A3 (subscription POST) implements a provider-agnostic create/checkout path against this model, returning Modern status vocabulary (with Stripe-backed lifecycle underneath) and preserving any existing subscription history.
- The decision is recorded here so W1 A3 and the subscription surfaces implement against a fixed contract instead of guessing the `grace`/`expired` mapping.

## Alternatives considered

- Option B (map Legacy `grace`/`expired` directly onto `subscriptions.status`) — declined: Modern `subscriptions` is the Stripe object; overwriting its status column with non-Stripe values corrupts Stripe parity and loses the provider lifecycle.
- Option C (defer subscription POST until a full billing subsystem exists) — declined: A3 needs a create path now; a provider-agnostic model over the existing Stripe object delivers it without inventing a billing subsystem.

## Consequences

### Positive
- W1 A3 can implement subscription POST against a stable model.
- Stripe parity on `subscriptions.status` is preserved; Legacy subscription history is not destroyed.
- `grace`/`expired` remain meaningful Modern concepts computed read-side.

### Negative
- Legacy's provider-less statuses are not natively stored; any import of legacy subscription rows into `subscriptions` stays blocked (OD-AC-SUBMAP blocks MG-G10 data migration until the owner supplies a real export + interpretation).

## Migration impact

None — no new migration; existing `subscriptions` (0017) unchanged. MG-SCHEMA-MAPPING's users-subscription-lifecycle column gap stays open (OD-AC-SUBMAP).

## Testing / verification requirements

- W1 A3 tests pin provider-agnostic subscription create behavior and that `grace`/`expired` are not written raw into `subscriptions.status`.
- `db/tests/migrations.test.ts` continues to pass (no migration change).

## Phase

Phase 2 wave W1 (admin: A3 subscription POST). Blocks MG-G03, MG-G10, MG-SCHEMA-MAPPING (OD-AC-SUBMAP).
