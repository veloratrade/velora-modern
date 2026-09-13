# Phase D — D1: ORM Spike / PostgreSQL Access Decision

**Date:** 2026-09-13 · **Branch:** `reconcile/foundation-first` · **Base:** `95ab7e06` (unchanged)
**Authorization:** Phase D explicit owner authorization (this session). Scope of this document: **D1 only** — inspect, decide, and prepare verification apparatus. No store adapters were implemented (that is D2).

**Owner decision (2026-09-13, post-report):** recommendation **APPROVED** — direct `pg` (TypeScript → pg → PostgreSQL); **no ORM in Phase D** (Prisma/Drizzle/Kysely/TypeORM excluded); D1 commit `9f2df9d`. Real-PG S1–S9 evidence is required **before** D2. Decision record: §10 items 2–3; execution status: §11.

---

## Verdict

**Recommendation: direct `pg` (node-postgres) — do NOT adopt an ORM.**

The existing architecture is already SQL-first at every layer that matters: hand-written PG-dialect migrations, a PG-specific trigger and partial indexes, a `roles.sql` privilege layer, an in-repo migration engine, and store **ports** whose contracts (atomic multi-step operations, version CAS, append-only events) are expressed in terms that map 1:1 onto SQL transactions. An ORM would add a second authority over schema/migrations, force raw-SQL escape hatches for exactly the concurrency primitives Phases D3/D4 exist to verify (FOR UPDATE row locking, CAS, single-statement upserts), and — in most candidates — endanger the ADR-001 "decimal-as-string" law at the driver boundary.

Per OD-6, this recommendation requires owner confirmation before D2 implements on top of it.

**Evidence legend (Phase D standard):** VERIFIED = observed in this workspace's code/files or installed dependencies this session; WEB-VERIFIED = confirmed against vendor/primary sources this session (cited); INFERRED = reasoned, not executed; NOT TESTED = apparatus exists, execution pending; BLOCKED = cannot be executed within Phase D boundaries.

---

## 1. Current persistence architecture (as inspected)

| Layer | State | Evidence class |
|---|---|---|
| **Ports** — `UserStore`, `AccountStore`, `TradeStore`, `RateLimitStore` — are plain interfaces in `apps/api/src/{auth,accounts,trades}/` + `packages/domain/src/rateLimit.ts`. Adapters are swappable per ADR-007 trigger #1; no repository framework anywhere. | VERIFIED |
| **Memory adapters** (`memoryTradeStore.ts` promise-chain serialization, `memoryAccountStore.ts`) power the dev/test battery today. | VERIFIED |
| **PGlite evidence tests** (`db/tests/*.test.ts`) already exercise the SQL schema (12 tables, 9 unique constraints) — but under PGlite, which by policy is **never** real-PG proof. | VERIFIED |
| **Migration engine** (`db/migrate.ts`): `MigrationEngine` interface with `query`/`exec`/`close`/optional `transaction`; PGlite branch + real-`pg` Client branch (BEGIN/COMMIT/ROLLBACK) already implemented; forward-only with `schema_migrations` tracking; per-file transaction; idempotent re-run (re-reading applied set). | VERIFIED |
| **Schema is deliberately PG-dialect** (0001–0005): `GENERATED ALWAYS AS IDENTITY`, `NUMERIC(20,8)/(20,2)`, `TIMESTAMPTZ`, JSONB, partial indexes, `velora_apply_exit()` BEFORE-INSERT trigger doing `SELECT … FOR UPDATE` internally, version-CAS columns, `deleted_at` tombstones, allocation CHECKs. | VERIFIED |
| **`db/roles.sql`** (4 roles; REVOKE UPDATE/DELETE on `trade_events`/`webhook_events` → append-only enforcement) is applied by **no** migration or test — a D5 item, independent of the ORM question. | VERIFIED |
| **`pg` dependency topology:** declared **only** by `apps/worker` (`pg ^8.12.0`, with `pg-boss ^10.1.0`); hoisted install is `pg 8.23.0`. `apps/api` dynamically imports `pg` (`server-main.ts:32,44`) and has `@types/pg ^8.23.1` in devDeps but does **not** declare `pg` — a latent assumption on hoisting (fix in D2, §6). | VERIFIED |
| **node-postgres driver behavior** (installed `pg-types` source): OID 20 (int8/BIGINT) → `parseBigInteger` returns digit-strings unchanged; OID 1700 (NUMERIC) has **no** scalar parser registered → arrives as the raw string; OID 1184 (timestamptz) → `parseDate` → JS `Date`; OID 1231 (`numeric[]`) → `parseFloatArray` (**hazard**, see §5-R3). No `setTypeParser` overrides exist anywhere in repo source. | VERIFIED (code-level; execution proof = pg-smoke S2–S4, NOT TESTED until the workflow runs) |

## 2. ORM candidates considered

| Candidate | Class | Fit summary | Evidence class |
|---|---|---|---|
| **Direct `pg` + typed row interfaces** | Driver | Already the migration runner's real-PG path; row types are already the PGlite adapters' pattern; SQL remains the single source of truth. | VERIFIED (patterns exist in repo) |
| **Drizzle ORM** | Typed SQL toolkit | Closest alternative: `numeric` columns infer as **string** by default (matches ADR-001); `for("update")` supported; drizzle-kit migrations optional. But it duplicates the schema definition (a second declaration of 12 tables/9 constraints to keep in sync), and its value-add (query building) targets exactly the code we must hand-verify for D3/D4 concurrency anyway. | WEB-VERIFIED numeric-as-string default (drizzle-orm issues #1042, PR #4281); rest INFERRED |
| **Kysely** | Typed query builder | No schema duplication (types only), stays SQL-shaped. Still adds a dependency + abstraction over statements whose exact SQL matters for locking/CAS evidence. | INFERRED (vendor-documented `forUpdate`; not fetched this session) |
| **Prisma** | Full ORM + Migrate | Poorest fit: typed client has no first-class `FOR UPDATE` — the documented pattern is dropping to `$queryRaw`; Decimal columns map to a Decimal.js object type (not the port's `string`); Prisma Migrate becomes a **second migration authority** alongside the in-repo MigrationEngine + MIGRATION_MAP + ADR-012 backup gate. | WEB-VERIFIED raw-SQL-for-locking pattern (Stack Overflow 78962255 and community transaction-pattern guides); Decimal mapping INFERRED (vendor docs, not fetched this session) |
| **TypeORM / Sequelize / Knex** | Full ORM / legacy builder | Rejected without deep dive: entity-decorator or legacy-builder models conflict with the port contracts and migration governance the same way Prisma does, with heavier dependency trees. | INFERRED |

## 3. Recommendation

**Direct `pg`.** D2 implements real-PG adapters for the four stores on `pg.Client`/`pg.Pool` with hand-written SQL, mirroring the PGlite adapter structure and the existing `MigrationEngine` contract.

## 4. Exact reasons

1. **The concurrency evidence is the product.** D3/D4 exist to prove, on real PostgreSQL, that quota locking (`SELECT … FOR UPDATE`), CAS (`UPDATE … WHERE version = $expected`), and event append + projection update are correct. Every ORM considered either hides the exact SQL (Drizzle/Kysely build it for you), lacks the primitive (Prisma's documented answer to row locking is `$queryRaw` — WEB-VERIFIED), or both. Direct `pg` makes the statement under test the statement written in the adapter.
2. **ADR-001 decimal-as-string is safest exactly at the raw-driver boundary.** Installed `pg-types` has no scalar NUMERIC parser → raw string by default (VERIFIED at code level). ORM layers re-type columns (Prisma → Decimal.js; Drizzle → string by default but with an opt-in `number` mode one careless `mode: 'number'` away from float contamination).
3. **One migration authority.** The in-repo MigrationEngine + `db/MIGRATION_MAP.md` + ADR-012 backup-gate law + forward-only ADR-010 policy are load-bearing governance. Prisma Migrate / drizzle-kit would either be dead weight or a competing authority. With direct `pg`, migrations stay exactly as verified in D5.
4. **The schema's PG-specific features are already the migration files' job** — trigger, partial indexes, constraint swap in 0005, roles.sql. ORMs don't model these; the SQL remains authoritative regardless, so the ORM's schema model would be a lossy shadow.
5. **Ports make the ORM question small.** Adapters are already swappable interfaces; the choice only affects four adapter files' internals. An ORM's container-level benefits (repository patterns, entity lifecycle) are redundant here.
6. **Dependency minimization is an explicit project value** (owner's point; OD-6). Direct `pg` adds **zero** new runtime dependencies for D2 — `pg` is already in the tree (worker) and merely needs proper declaration in `apps/api`.
7. **What we give up, and why it's acceptable:** no compile-time-checked query building (mitigated by typed row interfaces + parameterized SQL + the golden-vector and parity batteries), no automatic relation loading (the domain already composes via services), no cross-DB portability (the project is PostgreSQL-only by ADR/stack).

This is not "no framework because fashion": it is that the framework's surface (schema modeling + query building + its own migrations) overlaps zero with this codebase's needs, while its costs (second schema authority, boundary re-typing, escape-hatch SQL for locking) overlap fully with the Phase D risk surface.

## 5. PostgreSQL-specific risks discovered (D2–D6 must carry these)

- **R1 — Driver value shapes differ between PGlite and `pg`** (e.g., timestamptz handling; JSONB nulls already bit once). Adapters must normalize at the boundary and the pg-smoke pins the real shapes. VERIFIED (interface differences) / NOT TESTED (execution).
- **R2 — int8 → string everywhere** (ids, `COUNT(*)`, `RETURNING hits`): ports already use string ids; any count arithmetic must parse deliberately. VERIFIED (code-level).
- **R3 — `numeric[]` arrays parse to FLOAT** (`register(1231, parseFloatArray)`): never SELECT numeric array columns through `pg` defaults. No such column exists today (VERIFIED); keep it that way. VERIFIED (code-level).
- **R4 — Parser overrides are process-global**: one `setTypeParser` call anywhere (including a future dependency) silently breaks NUMERIC-as-string. Guard: no-override rule + D6 golden-vector numeric round-trip test. VERIFIED (mechanism) / INFERRED (risk).
- **R5 — Transaction discipline**: adapters need a `withTransaction`-style helper with rollback-on-error; multi-step store operations (trade edit + event append + projection) must run on one client/session. VERIFIED (requirement from port contracts).
- **R6 — Rate-limit atomicity**: the 3-statement read/update/write shape is not concurrency-safe; the D2 adapter should use the single-statement `INSERT … ON CONFLICT … RETURNING` shape proven in pg-smoke S9. INFERRED (shape designed; execution NOT TESTED).
- **R7 — Error-code mapping**: adapters must map `23505` (unique, → idempotent convergence), `23514` (check), `23503` (FK), `40001` (serialization), `57014` (timeout/cancel) to domain errors. pg-smoke pins 23505. VERIFIED (codes are PostgreSQL-documented; mapping NOT TESTED).
- **R8 — Lock waits**: no default `statement_timeout` on a vanilla server; D3/D4 tests must set explicit timeouts (pg-smoke S7 demonstrates). VERIFIED (mechanism) / NOT TESTED (execution).
- **R9 — Append-only enforcement is currently only `roles.sql`**, applied by nothing. Unchanged by this decision; D5 verifies it as the privilege layer. VERIFIED.
- **R10 — apps/api's undeclared reliance on hoisted `pg`** (via worker) — must be declared in D2. VERIFIED.

## 6. Required dependency changes

- **D1: none.** (No new dependency was added to implement the spike or the smoke; `tsx` and `pg` were already present.)
- **D2 (first adapter commit):** add `"pg": "^8.12.0"` to `apps/api/package.json` `dependencies` (matching worker's range; hoisted 8.23.0 satisfies it). `@types/pg ^8.23.1` is already in apps/api devDeps. **No other changes** — this is the entire dependency footprint of the direct-`pg` path, versus one-to-several new runtime deps for any ORM alternative.

## 7. Required GitHub Actions changes

- **Prepared (this spike, file only — not pushed, not executed):** `.github/workflows/postgres-evidence.yml` — manual-dispatch-only (`workflow_dispatch`), no push/PR/schedule triggers, `permissions: contents: read`, 15-minute timeout, `concurrency` cancel-in-progress, **no caches** (ci.yml cost discipline), `postgres:16-alpine` service container (same major as `infra/docker-compose.yml`), disposable **test-only** credentials (`velora_test` / `velora-test-only`) that die with the job, no deploy steps, no secrets, no production/staging access. It runs `npx tsx tools/pg-smoke.ts` and nothing else.
- **ci.yml: unchanged.** The existing battery (tsc, 304 tests, PGlite migration tests, secret-scan) keeps running as-is; real-PG evidence stays a separate, opt-in job so the two evidence classes never blur.
- **Execution is BLOCKED until the owner:** (a) pushes this branch — push is NOT authorized in Phase D — and (b) enables GitHub Actions for a window (repo-level disable per owner cost policy), then dispatches the workflow manually.

## 8. Exact files

**Created by D1 (this spike):**

| File | Purpose |
|---|---|
| `.github/workflows/postgres-evidence.yml` | Test-only real-PG workflow (§7) |
| `tools/pg-smoke.ts` | Env-gated smoke: 9 checks S1–S9 (§9); SKIP-exit-0 without `DATABASE_URL` — verified locally |
| `docs/reconciliation/PHASE-D-D1-ORM-SPIKE.md` | This report |
| `AGENTS.md` | One index row appended |

**Planned for D2 (design only — none created):** real-PG adapters beside the memory ones (e.g. `apps/api/src/auth/pgUserStore.ts`, `apps/api/src/accounts/pgAccountStore.ts`, `apps/api/src/trades/pgTradeStore.ts`, a PG rate-limit store per ADR-007, plus a shared connection/`withTransaction` helper), `apps/api/package.json` (declare `pg`), wiring in `apps/api/src/server-main.ts`, and real-PG test batteries under `db/tests/` gated the same way as the smoke. Final file list is a D2 decision presented before implementation.

## 9. Tests that can prove the decision

**`tools/pg-smoke.ts` — the D1 apparatus, ready to run in the workflow:**

| # | Check | Proves |
|---|---|---|
| S1 | server_version + migrations 0001–0005 apply; re-run no-op | The migration engine's real-PG path works (D5 preview) |
| S2 | `NUMERIC(20,8)/(20,2)` round-trip as exact scale-padded strings | ADR-001 law holds at the real driver boundary |
| S3 | BIGINT id and `COUNT(*)` arrive as strings | R2 boundary rule for adapters |
| S4 | `TIMESTAMPTZ` → `Date` with exact epoch ms | R1 shape normalization target |
| S5 | `velora_apply_exit`: allocation increment + over-allocation rejection | PG-specific trigger works on real PG (D4 preview) |
| S6 | `engine.transaction` rolls back atomically | The migration engine's tx semantics on real PG |
| S7 | two sessions: `FOR UPDATE` blocks session B until `statement_timeout` (57014) | Real cross-session row locking — **impossible in PGlite**, the core D3/D4 primitive |
| S8 | duplicate `event_uid` → error code 23505; JSONB round-trip parsed | R7 idempotency mapping + JSONB shape |
| S9 | single-statement `ON CONFLICT … RETURNING hits` = "1" then "2" | R6 atomic rate-limit shape |

**Executed this session (local):** SKIP-path gate (exit 0 without `DATABASE_URL`) VERIFIED; secret-scan PASS VERIFIED (the workflow initially FAILED the scan — its header comment spelled out a credential-shaped URL; fixed, and this is now a documented scan-pattern lesson); YAML validity VERIFIED; typecheck clean VERIFIED; full battery 304/304 and migrations 5/5 VERIFIED (no regression from D1 files).

**NOT TESTED (by design, awaiting the authorized environment):** S1–S9 against a real server. When the workflow runs, its log is the evidence; PGlite battery results are never substitutes.

## 10. Blockers and owner decisions still required

1. **Real-PG execution: owner-authorized (2026-09-13); still mechanically blocked from this workspace.** S1–S9 must run before D2 (owner execution order). This workspace has 0 git remotes, no `gh` CLI, and no GitHub credentials (re-verified 2026-09-13), so push/enable/dispatch are owner-side operations. S1–S9 remain NOT TESTED until the run executes. See §11.
2. **RESOLVED — owner approval (2026-09-13):** direct `pg` (TypeScript → pg → PostgreSQL); no ORM in Phase D (Prisma/Drizzle/Kysely/TypeORM excluded); D1 commit `9f2df9d` referenced in the approval. OD-6 closed.
3. **RESOLVED — owner D2 authorization (2026-09-13), conditional on green real-PG S1–S9:** four real-PG stores (UserStore/AccountStore/TradeStore/RateLimitStore), `pg` declared in `apps/api`, existing ports/PGlite adapters/ADR-001..004, ownership checks, tombstones, CAS, ledger behavior, and transaction boundaries preserved; no unrelated redesign; adapter filenames per §8 unless implementation evidence requires adjustment (any deviation reported, never silent).

---

## 11. Post-approval execution status (2026-09-13)

Owner approved D1 and ordered real-PG S1–S9 via `postgres-evidence` before D2. State verified at that moment:

- Workspace: branch `reconcile/foundation-first`, tree clean, **0 remotes, no `gh` CLI, no credentials** → push/dispatch impossible from this workspace (mechanical, not governance).
- GitHub (anonymous API, same day): repo public; default branch `main` @ `99e024c829…`; `reconcile/foundation-first` does not exist on GitHub; 20 historical Actions runs (latest: CI run #19 success on main, 2026-09-11T23:14Z); current Actions enable-state not anonymously verifiable (`/actions/permissions` → 401).
- None of main's 11 workflows has a `schedule:` trigger (all push/PR-filtered or dispatch/call-only) → an enable-window creates no scheduled-run risk; pushing the feature branch auto-triggers nothing (its only workflows: `ci.yml` (push/PR → main) and `postgres-evidence.yml` (dispatch-only)).
- `workflow_dispatch` requires the workflow file on the **default branch** (GitHub docs) — `postgres-evidence.yml` exists only on this branch, and `main` must not be modified. Owner-side options: (a) temporary default-branch switch → UI dispatch → switch back; (b) authenticated `gh workflow run postgres-evidence.yml --ref reconcile/foundation-first` (reported to work without default-branch presence; not verifiable from here); (c) amend the workflow to also trigger on push to exactly this branch (one commit; owner approval pending).
- Prepared for owner-side push: `velora-phase-d-foundation-first.bundle` (workspace root, outside the repo) containing the full branch history.

S1–S9 **RESULT (2026-09-13): GREEN — run 34731411400**, S1–S9 all PASS on PostgreSQL 16.15 (`postgres:16-alpine` service container), commit under test `cad84f35`. Full record with verbatim log lines, execution mechanics, and scope boundaries: `docs/evidence/PHASE-D-D1-PG-EVIDENCE.md`. **D1 decision (direct `pg`) confirmed valid; D2 gate open.**

---

### Appendix — OD-6 criteria matrix (11 criteria, per `RECONCILIATION_DECISIONS.md`)

| Criterion | Direct `pg` | Drizzle | Kysely | Prisma |
|---|---|---|---|---|
| 1. NUMERIC exact/string-safety | Raw string by default (VERIFIED code-level) | String default, `number` opt-in (WEB-VERIFIED) | String (passes through driver) | Decimal.js object (INFERRED) |
| 2. Transactions | Explicit BEGIN/COMMIT on client | Supported | Supported | Interactive `$transaction` |
| 3. Row locking (FOR UPDATE) | Native SQL (the evidence target) | `for("update")` builder | `forUpdate()` | `$queryRaw` escape hatch (WEB-VERIFIED) |
| 4. Optimistic concurrency/CAS | Native `WHERE version = $n` | Builder-compatible | Builder-compatible | Awkward (`updateMany` + count) |
| 5. PG constraints/triggers/partial indexes | SQL files remain authoritative | Not modeled | Not modeled | Not modeled |
| 6. Append-only ledger enforcement | roles.sql REVOKEs (D5) | N/A | N/A | N/A |
| 7. Migration control | In-repo engine (unchanged) | drizzle-kit optional | None (bring your own) | Prisma Migrate = second authority |
| 8. Repository/port boundaries | Adapters fit existing ports | Fits | Fits | Repository model redundant/conflicting |
| 9. Testability | Injectable engines, driver mocks | Same | Same | Heavier (engine process) |
| 10. Dependency complexity | Zero new | +1 runtime + kit | +1 | +engine+client gen |
| 11. Team/language fit | SQL-first codebase, TS types at row level | TS-first | TS-first | Schema-first DSL |

**Winner on 1, 3, 5, 6, 7, 10 (the criteria that carry Phase D risk); tied or acceptable elsewhere.**
