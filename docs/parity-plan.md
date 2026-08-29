# VELORA-MODERN — Parity Plan (Executable Specification)

Goal: detect **silent business-rule divergence** between PHP production and the
modern implementation — without comparing implementation details.

## Principles

1. **Primary signal: executable external-contract specification.** Specs are
   black-box HTTP/behavior scenarios bound to `docs/external-contracts.md` rows,
   authored from capability specs (not from PHP code).
2. **Differential testing is a secondary signal** — same specs, two targets,
   compared **semantically**.
3. **No naive raw response comparison.** Comparison = semantic equality over a
   declared tolerance allowlist; everything not tolerated must match.
4. PHP remains the behavioral source of truth until cutover (one-way sync).

## Tolerance allowlist (defaults)

Tolerated (per-field, declared): generated IDs; timestamps/clocks; ordering where
the contract does not specify order; non-contractual headers; whitespace/formatting
with identical semantic value; locale of error messages where message keys match.

Everything else (status codes, envelope shape, business values, error semantics,
locale headers, link formats, set-of-URLs, throttle behavior) must match exactly —
any addition to the allowlist is a reviewed decision recorded in the spec file.

## Suite categories

| Category | Scope | Source |
|---|---|---|
| health | C-01 envelope + DB-connectivity proof | verified live suite |
| auth journeys | register→verify→login→forgot→reset→re-login→change-password (11-step port) | verified E2E |
| email links | C-06/C-07 formats + single-use token semantics | verified live tests |
| locale | C-02 routing + `X-VELORA-Locale` + fa/en status | verified healthcheck |
| public routes | C-03 URL set + status + locale variant | sitemap (verified) |
| SEO | C-04/C-05 sitemap/robots env behavior, canonical/hreflang (after verification) | healthcheck + F-10 |
| webhook behavior | C-08 signature accept/reject, dedupe, idempotent projection | ADR-008 |
| error semantics | only where externally contractual (C-10 envelope, 404/403 classes) | healthcheck suite |

## Runner contract (documentation-level; implementation = Phase 1 item)

- Specs stored as data (declarative scenarios), runnable as:
  `parity run --target=php-staging` and `--target=modern-staging` (+ `--diff` mode).
- Target config: base URL + credentials bootstrap only; specs are target-agnostic.
- Mocked third parties (AI providers, MetaApi) for deterministic verdicts;
  live-provider checks stay staging-only and rate-budgeted (PHP-era pattern).
- Result artifact: per-spec PASS/FAIL + diff report (tolerated vs mismatched fields),
  linked as evidence in the capability registry before any SYNCED marking.

## Gating

- A capability may be marked SYNCED only when its specs pass on the modern
  target **and** the differential report shows only tolerated differences — plus
  human sign-off (registry rules).
- Scheduled differential runs (weekly parity increment) detect drift introduced
  by new PHP changes; failures open registry debt items, never auto-close.

## Phase 1 exit requirement

Runner exists and executes health + locale + public-route categories against
**both** stagings, producing evidence artifacts.
