# ADR-001 — Money, Precision & PnL

## Status

Accepted — owner decision D-03 (2026-08-29): decimal-only arithmetic + scale matrix + golden vectors approved; rounding = **half-even for new currency computations**; historical parity preserves verified bcmath-equivalent behavior. Implementation not started.

## Context

Velora is a trading journal. PnL, volume, commissions, and R-multiples are the
product. The PHP system already treats this domain with string-based arbitrary
precision; the modern system must not regress, and must reproduce verified
financial verdicts exactly.

## Verified Evidence

- `api/src/Trades/PnlCalculator.php` (VERIFIED, read in full header + structure):
  - Uses **bcmath string arithmetic** "so currency rounding errors never occur (CTO checklist #5)".
  - `net_pnl = gross_pnl − commission − swap`
  - `gross = (exit − entry) × volume × contract_size` (buy); inverse for sell.
  - `contract_size`: FX 100000, XAUUSD 100, crypto/indices 1 (documented).
  - `r_multiple = net_pnl / risk`; **risk defaults to initial price delta when no stop-loss is defined**.
- Trades DDL scales (VERIFIED, `_database/database_corrected.sql`):
  `entry_price/exit_price/stop_loss/take_profit decimal(15,5)`, `volume decimal(15,2)`,
  `lot_size decimal(10,2)`, `commission/swap/profit_loss decimal(15,2)`,
  `net_pnl decimal(18,2)`, `r_multiple decimal(10,4)`, `status enum('OPEN','CLOSED')`.
- `v0.3_trade_financial_consistency.sql` (VERIFIED): added `contract_size decimal(18,8) NOT NULL DEFAULT 1.00000000` conditionally; also created shared `rate_limits` table.
- bcmath division **truncates** toward zero at the configured scale (VERIFIED library semantics — this is the de-facto rounding behavior of current `r_multiple`).

## Decision

1. **IEEE-754 floating point is prohibited for financial calculation** anywhere in the modern system (storage, API, domain logic, reporting, tests). Postgres `numeric` arrives in Node as a **string**; it must remain a string into the domain layer.
2. **A decimal library is mandatory in `packages/domain`** (candidates: `decimal.js`, `big.js`, `arbitrary-precision` wrappers). Selection is a Phase 1 bake-off judged against the golden vectors below (including bcmath-parity vectors). Library choice is OPEN; the requirement is not.
3. **Proposed Postgres scale matrix** (ceiling; final lock at Phase 1 with data profiling):

| Quantity | Today (MySQL) | Proposed (PG) | Rationale |
|---|---|---|---|
| price (entry/exit/SL/TP) | (15,5) | `numeric(20,8)` | crypto/tick precision headroom |
| volume | (15,2) | `numeric(20,8)` | crypto fractional lots |
| contract_size | (18,8) | `numeric(20,8)` | as-is headroom |
| currency amounts (commission, swap, net_pnl) | (15,2)/(18,2) | `numeric(20,2)` | account-currency cents |
| r_multiple | (10,4) | `numeric(20,8)` | avoid truncation loss on re-spec |

   These are **not final**: they are a defensible ceiling until (a) real data profiling of current values, and (b) the owner locks the rounding policy (below). Storing at higher precision than display never loses parity.
4. **Rounding:** Phase-1 golden vectors must reproduce PHP/bcmath outputs (truncation at scale) for parity on historical recomputation. For **new** computations a defined rounding mode (e.g., half-even for currency display, truncate-vs-round for r_multiple) is `OWNER DECISION REQUIRED`.
5. **Division guards:** `risk ≤ 0`, `volume = 0`, zero price delta must be explicit branches with defined outcomes — never NaN/Infinity. Exact current zero-risk behavior: `OPEN QUESTION` (verify against code before implementing; add golden vectors).
6. Partial exits: allocation order and PnL attribution across `trade_exits` is `OPEN QUESTION` (spec extraction in Phase 2); must be golden-tested.
7. Currency conversion: no FX conversion exists in `PnlCalculator` (VERIFIED absent). Multi-currency support is out of scope unless the owner adds it — `ASSUMPTION`.

## Alternatives Considered

- Storing money as integer minor units: rejected (trading volumes/prices are not 2-dp domains; would push complexity everywhere).
- Float + epsilon comparisons: rejected (the PHP system explicitly rejected this; regression unacceptable).
- PG `money` type: rejected (fixed 2-dp, locale-sensitive formatting).

## Consequences

### Positive
- Bit-parity with verified financial verdicts; no silent drift.
- Headroom for crypto-class instruments without migration.
- Domain stays pure and golden-testable.

### Negative
- String/decimal discipline everywhere (ergonomic cost, easy to violate by accident → CI guard required: lint rule banning arithmetic operators on `numeric`-typed values).
- Two rounding regimes (parity vs new-computation) until the owner locks policy.

## Security Impact

Financial values are integrity-critical (manipulation = wrong reporting).
Decimal-typed end-to-end prevents a class of integrity bugs; combined with
ADR-002 ledger semantics this forms the audit story.

## Migration Impact

`db/MIGRATION_MAP.md` must map every MySQL scale → PG scale; the transform
pipeline must never pass numerics through JS floats (string pipeline end-to-end).
PnL recomputation over migrated trades is a mandatory validation gate.

## Testing / Verification Requirements

- **Golden vector suite (Phase 1 exit gate)**: vectors captured from PHP
  staging (sanitized real trades) + synthetic edge cases (zero volume, no-SL
  fallback, partial exits, sell direction, negatives, max scales).
- Property tests: associativity/commutativity within scale; no float contamination
  (runtime type assertions in domain layer).
- CI guard: static rule forbidding `Number()`/`parseFloat`/`*` on financial fields.

## Open Questions

1. Owner: rounding policy for new computations (truncate vs half-even vs half-up, per quantity). — OWNER DECISION REQUIRED
2. Exact zero-risk / zero-delta behavior in current PHP (code-level verification pending).
3. Partial-exit allocation order (Phase 2 spec extraction).
4. Decimal library selection (Phase 1 bake-off).

## Phase

Phase 0 decision; implementation + golden vectors = Phase 1 gate.
