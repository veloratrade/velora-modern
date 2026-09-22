# ADR-011 — Phase 1 Implementation Record (Architecture Foundation)

## Status

Accepted (implementation record under owner authorization D-10, 2026-08-31).
Records WHAT was implemented, WHAT passed, and WHAT is explicitly BLOCKED —
so no implementation status can be mistaken for production readiness.
Gate 3B (production hosting) remains **BLOCKED 0/20** throughout.

## Implemented (IMPLEMENTED CHANGE)

| Area | Decision | Traceability |
|---|---|---|
| Monorepo | npm workspaces: `packages/{config,contracts,domain}`, `apps/{api,worker,web}`; strict TS (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | ADR-010/D-15 |
| Decimal engine | **First-party** BigInt fixed-point (`packages/domain/decimal.ts`), string-in/string-out, dual rounding (`bcmath-truncate` for historical parity, `half-even` for new computations), `fromNumber` forbidden | ADR-001/D-03 |
| PnL | Verified PHP formula set incl. no-SL fallback; explicit `undefined-risk` branches (never NaN) | ADR-001 |
| Trade ledger | Event union + ownership matrix + optimistic versioning + exit over-allocation guard + tombstones + idempotent fold; DB mirror via CHECK + trigger | ADR-002/D-01 |
| Schema | `0001_core.sql`: canonical email UNIQUE, NUMERIC(20,8)/(20,2) scales, `timestamptz`/UTC + dual trading timestamps, append-only event log, webhook raw archive + dedupe | ADR-001/002/003/004/008 |
| Roles | `app_readwrite` / `velora_worker` / `velora_migrator` / `velora_readonly`; append-only revokes on ledger tables | ADR-010/D-15 |
| Auth | `VeloraHasher`: bcryptjs verify (migrated `$2y$`) + hash-wasm Argon2id **m=19456,t=2,p=1**; rehash policy in domain | ADR-005/D-04 |
| Queue | `QueuePort` abstraction; deterministic `MemoryQueue`; pg-boss adapter (pinned major); runner enforces timeout/retry/DLQ | ADR-007/D-13 |
| API kernel | node:http thin shell: B-8 envelope, `/health` C-01, readiness, locale+cache headers C-02/C-03, logout origin guard, CSP nonce, request-id | ADR-006/009 + C-01/02/03 |
| Web kernel | Locale routing decisions incl. `/en` → 308 `/en/`; no alternative URL structures | ADR-009/D-14 |
| Redis | **Absent by design** — triggers documented in contracts (`REDIS_INTRODUCTION_TRIGGERS`); rate limiting keeps a shared-store table shape | ADR-007/D-13 |
| CI / infra | `ci.yml` (typecheck+tests+migrations+secret-scan; standard runner; no schedules/caches), compose files, backup/restore scripts + DR runbook, Dockerfiles (non-root) | ADR-010 |

## Test evidence (TEST RESULT, 2026-08-31)

- **70/70** unit/contract tests PASS (golden vectors incl. dual-mode divergence;
  ledger ownership/conflicts/over-allocation/tombstones/idempotency; backoff/
  DLQ/lease; locale map; envelope; origin guard; CSP nonce uniqueness).
- **5/5** migration tests PASS on PGlite (disposable real-PG-semantics engine):
  idempotent apply, canonical-email constraint behavior, ADR-001 scales +
  timestamptz verified from `information_schema`, external-deal idempotency,
  DB-level over-allocation rejection, webhook dedupe.
- **bcrypt `$2y$` PROOF GATE: PASSED** — PHP-generated vector
  (`rasmuslerdorf`, cost 10) verifies TRUE, wrong password FALSE; `$2y≡$2b`
  prefix equivalence proven; Argon2id hash carries exact D-04 parameters.
- Parity smoke: **6/6 PASS** (health envelope C-01 incl. `checks.database`
  presence + all four contractual locale URLs + 404 envelope) against the live
  local API kernel over real HTTP, ephemeral port — executed via
  `npx tsx tools/parity-smoke.ts` on 2026-08-31. Execution mode: the runner
  (`parity/run.mjs`) is imported **in-process** because this dev sandbox drops
  child→parent loopback TCP connections (verified: parent fetch → 200, child
  fetch → timeout). In CI/staging the same runner runs cross-process via
  `node parity/run.mjs --target URL`.
- Typecheck: clean across all five TS projects (`tsc -b` exit 0, 2026-08-31;
  includes `@types/pg`, typed pg-boss shim).

## Explicit boundaries & blocks (BLOCKER / boundary)

1. **PGlite is dev/test ONLY.** It is NOT production hosting evidence; Gate 3B
   rows remain 0/20.
2. **pg-boss live integration: BLOCKED** — no PostgreSQL server exists in the
   dev sandbox (Docker absent). Semantics are covered deterministically via
   MemoryQueue; live verification executes when the dev/staging environment
   (compose) first runs — tracked as a Phase 1H exit item for that environment.
3. **Docker compose startup: BLOCKED** in this sandbox (Docker absent) — files
   provided, execution pending a Docker-capable environment.
4. **CI execution: PENDING** — Actions is disabled repository-wide per the
   owner's cost policy; CI runs only after push authorization + enablement.
5. **Image digest pinning: deferred** until registry evidence exists (Gate 3B
   rows 11–12).
6. **Framework adoption (NestJS/Next.js): Phase 2.** ADR-010's choices stand;
   Phase 1 delivers framework-independent kernels + a thin node:http API shell
   so contracts are testable now. The NestJS controller layer and Next.js app
   router are thin adapters over these kernels when feature build-out begins.
   *(RECOMMENDATION the owner may overrule; flagged, not silent.)*
7. **Legacy timezone: NOT interpreted.** No transform code exists;
   `LEGACY_TZ_INTERPRETATION.status === "BLOCKED_ON_SAMPLING"` (ADR-004).
8. **Restore drill: BLOCKED** in sandbox (no PG); runbook + scripts staged
   (infra/backup/DR-RUNBOOK.md).

## Security notes

Secret-safety scan clean (`bash tools/secret-scan.sh`, executed 2026-08-31 →
PASS, 0 findings; the scanner excludes its own file, which contains the
detection patterns verbatim). No secrets, no
credentials, no infrastructure identifiers committed. CSP strict-nonce tested.
Same-origin guard parity-tested. All financial math BigInt-based.

## Open questions

1. PnL intermediate-scale parity: golden vectors pin FINAL outputs; exact PHP
   intermediate scales remain unverified (Phase 2 spec extraction may refine).
2. pg-boss schema creation mode (boss migrations vs db/migrate ownership) —
   decide at first live staging bring-up.
