# ADR-008 — Webhook Ingestion Standard

## Status

Proposed

## Context

MetaApi already delivers webhooks to the PHP system; n8n callbacks and future
integrations will follow. One standard pipeline, applied to all inbound webhooks,
prevents forgery, replay, and duplicate-processing bugs.

## Verified Evidence

- `POST /api/v1/webhooks/metaapi` (VERIFIED): public transport, **HMAC verified
  in service** (`METAAPI_WEBHOOK_SECRET` env); test route dev-only, production 404.
- `webhook_events` table exists (VERIFIED DDL) — raw event persistence is already
  part of the data model.
- Duplicate delivery is normal for webhooks (platform fact; also consistent with
  the idempotency posture of the sync worker).

## Decision

**Standard pipeline (all inbound webhooks):**

```
Receive
  → Timestamp validation (tolerance window, proposed ±5 min, configurable, clock-skew aware)
  → HMAC verification (constant-time compare; per-source secret, env-only)
  → Event-ID dedupe (persistent, windowed)
  → Immutable raw payload archive (append-only store)
  → Normalization (schema-validated via zod contracts; unknown fields preserved)
  → Idempotent projection (business upserts keyed by external IDs, ADR-002)
```

Applied to: **MetaApi** (Phase 2 wave ③), **n8n callbacks** (Phase 3 — signed
with scoped service credentials), **future external webhooks** (same contract template).

**Replay requirement:** re-running archived raw events through normalization →
projection must reproduce identical state (projection rebuild tool; also the
recovery path for corrupted projections).

**Failure behavior (fail-closed, explicit):**

| Failure | Response | Side effect |
|---|---|---|
| Bad signature / stale timestamp | 4xx, no retry expected | counter + security log |
| Unknown/malformed payload | 4xx, archived as quarantine | alert (integration contract drift) |
| Internal projection failure | 5xx, retriable | raw archived; DLQ after retries |
| Duplicate event id | 2xx fast-path | dedupe counter (sender satisfied, no double effect) |

**Observability:** accepted / rejected / deduped / quarantined / failed counters
per source; alert on rejection-rate spikes and quarantine occurrences
(integration drift detector — see observability-contract).

## Alternatives Considered

- Verify-at-controller per integration (status quo style): rejected — per-endpoint drift is how standards rot.
- Queue-first, verify-later: rejected —unverified payloads must never enter processing.

## Consequences

### Positive
- One audited security path for all inbound integration traffic; replayability; drift detection.
- MetaApi semantics preserved (frozen external tier) with stronger guarantees.

### Negative
- Slightly more machinery per new webhook source (template mitigates).

## Security Impact

This is a primary attack surface (forgery, replay, payload abuse). Constant-time
HMAC, timestamp window, and dedupe are mandatory controls; secrets never in logs.

## Migration Impact

`webhook_events` history imports (immutable archive parity); projections are
rebuilt, not migrated.

## Testing / Verification Requirements

- Forgery/replay/expired-timestamp test vectors; duplicate-delivery convergence;
  payload-corruption quarantine; projection rebuild == live state property test.

## Open Questions

1. Final timestamp tolerance value (proposed ±5 min) — owner confirmation.
2. MetaApi signature header details for spec extraction (Phase 2, read-only against PHP code + docs).

## Phase

Phase 0 decision; MetaApi implementation = Phase 2 wave ③; n8n adapter = Phase 3.
