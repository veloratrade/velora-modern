# Phase D — D5: PostgreSQL Roles & Privilege Enforcement

**Status: IMPLEMENTED + LOCALLY VERIFIED ON REAL POSTGRESQL — CANONICAL GHA EVIDENCE NOT YET EXECUTED.**

D5 implementation is complete and the battery passes **18/18 (0 fail, 0 skipped) against a real PostgreSQL server**. However, the **canonical** Phase D evidence source — the `postgres-evidence` GitHub Actions workflow on `postgres:16-alpine` — **has not been run**, because no GitHub credential was available in the execution environment (no push, no `workflow_dispatch`). Per Phase D policy and AGENTS.md rule 10, **D5 is NOT claimed CLOSED**. No pass is claimed for anything that did not execute.

**Authorization:** owner message 2026-09-13 — D5 (roles/privileges, append-only enforcement, least-privilege verification, `roles.sql` defect correction, real-PG evidence, Railway staging preparation). B-2 AUTHORIZED, B-3 DEFERRED TO D6, B-4 AUTHORIZED WITH EXPLICIT OWNERSHIP MODEL.

---

## 1. Evidence classes — read this before citing any number

| Class | Environment | Status | Admissible as Phase D canonical evidence? |
|---|---|---|---|
| **A — Canonical** | GHA `postgres-evidence`, `postgres:16-alpine` (PostgreSQL **16.x**), disposable | **NOT EXECUTED** — no credential | Yes (when run) |
| **B — Local real PG** | Sandbox-installed **PostgreSQL 17.11** (Debian), disposable cluster in `/tmp` | **EXECUTED — 18/18 pass, 0 fail, 0 skipped** | **No** — supplementary only |
| **C — PGlite/memory** | Local battery 304/304, migrations 5/5 | EXECUTED | No (existing policy) |

**Class B is a genuine PostgreSQL server** — real roles, real `SET ROLE`, real `42501` — so it is materially stronger than PGlite. It is still **not** the canonical class: the version differs (**17.11 local vs 16.15 in CI**) and it was not produced by the audited workflow. Class A must be executed before D5 closes.

---

## 2. Ownership model (B-4) — stated explicitly, not invented silently

> **`velora_migrator` owns the application schema. Migrations run as `velora_migrator`. Runtime roles own nothing.**

**Why this model and not another** — established by execution, not assumption:

- The right to `ALTER`/`DROP` an object is **inherent in the owner and is not grantable** (PostgreSQL 16/17 `GRANT` docs). Migrations `0002/0004/0005` issue 15 `ALTER TABLE`/`CREATE INDEX` statements.
- **VERIFIED by execution:** a migrator holding only `CREATE ON SCHEMA` fails with `ERROR: must be owner of table users`.
- **VERIFIED by execution:** ownership **cannot be retrofitted** from the bootstrap superuser — `REASSIGN OWNED BY velora_test TO velora_migrator` fails with `cannot reassign ownership of objects owned by role velora_test because they are required by the database system`. The migrator must therefore own the schema **from the first migration onward**.
- **VERIFIED by execution:** with the migrator owning the schema, the entire chain (`0001` → `0002` ALTERs) applies cleanly, and `schema_migrations` is migrator-owned.

**Properties against the owner's criteria**

| Criterion | How it is met |
|---|---|
| Least privilege | Migrator holds DDL only and **no runtime DML** (P13); runtime roles hold **no DDL** (P16) |
| Compatible with the existing migration chain | Unmodified `db/migrate.ts`, unmodified `0001–0005` — only the *connecting role* changes |
| Reproducible in disposable PostgreSQL | `roles-bootstrap.sql` → migrate → `roles.sql`, executed in the battery fixture |
| Compatible with future Railway PostgreSQL | Standard SQL only; needs `CREATEROLE` + DB ownership, not true superuser |
| Documented in evidence | This section |

**Deployment order (the contract):**

```
1. db/roles-bootstrap.sql   — once per environment, as superuser/provisioning role
2. npx tsx db/migrate.ts    — connected AS velora_migrator  (owns what it creates)
3. db/roles.sql             — after migrations; idempotent, re-run after each deploy
```

---

## 3. `roles.sql` changes — defects D-1…D-5

| Defect | Before | Fix | Verification |
|---|---|---|---|
| **D-1** ordering incoherent | Header: "execute … BEFORE app deployment", but REVOKEs name migration-created tables | Split into `roles-bootstrap.sql` (pre-migration, roles/schema only) and `roles.sql` (post-migration, table privileges). Order documented in both files | **VERIFIED by execution** — running the old file pre-migration fails: `ERROR: relation "trade_events" does not exist` |
| **D-2** future tables lose privileges | `GRANT ON ALL TABLES` is a point-in-time snapshot; no `ALTER DEFAULT PRIVILEGES` anywhere | Added `ALTER DEFAULT PRIVILEGES FOR ROLE velora_migrator` for tables + sequences | **VERIFIED** — P15: a new migrator-created table is immediately SELECT/INSERT-able by `app_readwrite`, SELECT-only for `velora_readonly` |
| **D-3** LOGIN roles, no password | Roles `LOGIN` with no credential | **No credentials invented.** Passwords are provisioned out-of-band; the limitation is documented in-file and in §7 | By inspection; login auth explicitly **NOT TESTED** |
| **D-4** false pg-boss claim | Header claimed `pgboss.*` grants "included with IF EXISTS guards" — none existed | **Claim removed.** No queue grants created (pg-boss is out of D5 scope) | By inspection — no `pgboss` reference remains |
| **D-5** migrator cannot maintain schema | Only `CREATE ON SCHEMA public` | Ownership model §2 + migrator `USAGE, CREATE` in bootstrap | **VERIFIED by execution** (see §2) |

**Additional hardening (small, in-scope):**
- `REVOKE CREATE ON SCHEMA public FROM PUBLIC` — deny-by-default (required on PG < 15).
- `TRUNCATE` added to the ledger REVOKEs — `DELETE` alone does not stop `TRUNCATE`.
- `schema_migrations` write access revoked from runtime roles.

---

## 4. Privilege matrix — results (Class B, local real PostgreSQL 17.11)

| Test | Assertion | Result |
|---|---|---|
| P1 | All four roles exist | **PASS** |
| P2 | `roles.sql` idempotent (3× applied); append-only survives re-application | **PASS** |
| P3 | `app_readwrite` **CAN INSERT** `trade_events` | **PASS** |
| P4 | `app_readwrite` **CANNOT UPDATE** `trade_events` → `42501` | **PASS** |
| P5 | `app_readwrite` **CANNOT DELETE** `trade_events` → `42501` | **PASS** |
| P6 | `app_readwrite` **CANNOT UPDATE/DELETE** `webhook_events` → `42501` | **PASS** |
| P7 | `velora_worker` **CAN INSERT** both ledger tables | **PASS** |
| P8 | `velora_worker` **CANNOT UPDATE/DELETE** either ledger table → `42501` (×4) | **PASS** |
| P9 | `app_readwrite` retains full DML on ordinary tables (`trades`, `users`) | **PASS** |
| P10 | `velora_readonly` **CAN SELECT** | **PASS** |
| P11 | `velora_readonly` **CANNOT** INSERT/UPDATE/DELETE → `42501` (×4) | **PASS** |
| P12 | `velora_migrator` CAN `CREATE`/`ALTER`/`CREATE INDEX`/`DROP` | **PASS** |
| P13 | `velora_migrator` holds **no** runtime DML → `42501` | **PASS** |
| P14 | Exit path works under `app_readwrite` — non-`SECURITY DEFINER` trigger UPDATEs `trades`; allocation `0.40000000` | **PASS** |
| P14b | Over-allocation still rejected as a **business** guard, explicitly **not** `42501` | **PASS** |
| P15 | Future migrator-created table inherits correct default privileges | **PASS** |
| P15b | **Documented residual risk** — a future *ledger* table is **not** append-only automatically | **PASS** (asserts the true state) |
| P16 | No unnecessary privileges: no CREATE for runtime roles; no role is superuser/CREATEDB/CREATEROLE | **PASS** |

**Totals (Class B): tests 18 · pass 18 · fail 0 · skipped 0.**
All negative tests assert **SQLSTATE `42501`**; no assertion matches message text.

### Battery honesty controls

- **SKIP-path:** without `DATABASE_URL` → `# tests 18 / # pass 0 / # skipped 18` — a local SKIP can never read as a pass.
- **Negative control (mutation test):** removing the `trade_events` REVOKE from `roles.sql` makes the battery **fail 4 tests** (P2, P4, P5, P8) — proving it actually detects a broken privilege layer rather than passing vacuously.
  *Note:* an earlier attempt to sabotage by `GRANT`ing directly on the database did **not** fail the battery — because the fixture re-applies `roles.sql` per test and self-heals. That is correct fixture behaviour; the file-level sabotage above is the valid control. Recorded rather than hidden.
- **Harness defect found and fixed (not worked around):** P15/P15b initially failed (16/18). Root cause — `SET LOCAL ROLE` expires at `COMMIT`, so the "future" table was created by the connection role, not the migrator, bypassing the default-privilege path under test. Fixed with a dedicated `createAsMigrator` helper (`SET ROLE` + `RESET ROLE`, no rollback). **A test-harness defect, not a privilege defect; no assertion was weakened.**

### Regression (Class B, same database with the privilege layer applied)

| Battery | Result |
|---|---|
| `pgUserStore` 6/6 · `pgAccountStore` 3/3 · `pgTradeStore` 11/11 · `pgRateLimitStore` 6/6 · `pgQuota` 4/4 · `pgTradeConcurrency` 14/14 | **44/44 pass, 0 fail, 0 skipped** |

**Existing application behaviour is not broken by the privilege layer.**

### Local gates

`tsc -b` **0 errors** · local battery **304/304** · migrations **5/5** · `secret-scan` **PASS (0 findings)**.

---

## 5. Files changed

| File | Change |
|---|---|
| `db/roles.sql` | Rewritten — D-1…D-5 fixes, default privileges, TRUNCATE/`schema_migrations` hardening |
| `db/roles-bootstrap.sql` | **NEW** — pre-migration role + ownership bootstrap |
| `db/tests/pgRoles.pg.test.ts` | **NEW** — 18-test D5 battery, `SET ROLE`-based, 42501 assertions |
| `.github/workflows/postgres-evidence.yml` | **NEW** D5 step with anti-SKIP (`# pass 18` / `# fail 0` / `# skipped 0`, `set -o pipefail`); job name + scope note updated |
| `docs/evidence/PHASE-D-D5-ROLES.md` | This record |

**No application code, no migrations, no schema, no dependencies changed.**

---

## 6. Canonical evidence — what must still run

```
Workflow : postgres-evidence   (workflow_dispatch)
Branch   : reconcile/foundation-first
Expected : D5 step asserts  # pass 18 / # fail 0 / # skipped 0
Record   : run ID + server_version + verbatim totals into §4 above
```

**Run ID: NOT YET ASSIGNED. PostgreSQL version under canonical test: NOT YET OBSERVED (expected 16.x).**

⚠️ **Version caveat:** local verification ran on **17.11**; CI runs **16.x**. Nothing used is version-specific (`SET ROLE`, `ALTER DEFAULT PRIVILEGES`, `42501` all long-standing), but the totals must be re-observed on 16.x before D5 closes.

---

## 7. What is NOT proven

- **Canonical GHA evidence on `postgres:16-alpine` — NOT EXECUTED.** The blocking item.
- **Login / password authentication — NOT TESTED and NOT CLAIMED.** Privileges were exercised with `SET ROLE`. This proves the **authorization grid**; it does **not** prove `pg_hba`/scram authentication, connection-string wiring, or that the app can *connect* as `app_readwrite`. No test passwords were created (owner instruction). Real login verification requires out-of-band credentials — a separate, later item.
- **Deployment application of the privilege layer.** `railway.json`'s `startCommand` runs `db/migrate.ts` only; **nothing applies `roles-bootstrap.sql` or `roles.sql` in a deployment**, and migrations there do not run as `velora_migrator`. So a deployed environment would still have no privilege layer. Not silently changed — altering `startCommand` is a deployment-behaviour change beyond D5 verification scope. **Prerequisite for Railway staging.**
- **Future ledger tables are not automatically append-only** (P15b) — each new append-only table needs an explicit REVOKE in `roles.sql`.
- **Phase E ledger/business-semantic enforcement** — out of scope (OD-9). D5 is the database privilege layer only.
- **pg-boss/queue privileges** — deliberately absent (D-4).
- **Full application battery on real PG** — B-3, deferred to D6.
- **Railway staging** — no credential; nothing inspected, nothing deployed (§8).
- **Production readiness** — no production environment exists; nothing here claims it.

---

## 8. Railway — preflight status (separate from D5 evidence)

**No Railway action was taken. No Railway resource was created, modified, inspected, or deployed.**

- `backboard.railway.app/graphql/v2` → **HTTP 403** unauthenticated; no `RAILWAY_TOKEN`, no `railway` CLI. Read-only inspection (S10) was **not possible**.
- Production deployment (`main`) untouched; reconcile branch not deployed anywhere.

**Repo-side portability audit (what could be verified without Railway):**

| Requirement | Finding |
|---|---|
| Standard PostgreSQL, no platform-specific schema | **VERIFIED** — no Railway assumptions in `db/`; only comments reference Railway |
| Existing SQL migrations reusable | **VERIFIED** — `0001–0005` unchanged, apply cleanly as `velora_migrator` |
| `DATABASE_URL` externally configurable | **VERIFIED** — read from env in `server-main.ts` / `boot.ts` / worker; never hard-coded |
| Backup/restore feasible | **VERIFIED BY EXECUTION** — `infra/backup/backup.sh` produced a 44 KB custom-format dump; `pg_restore` into a fresh database restored **13 tables** |
| **Privileges survive restore?** | **VERIFIED — THEY DO NOT.** `backup.sh` uses `--no-owner --no-privileges`, so the restored database has **no grants at all** (`app_readwrite` SELECT on `trades` = false). Re-applying `roles.sql` after restore correctly re-establishes the grid (SELECT=true, ledger UPDATE=false). **`db/roles.sql` MUST be re-applied as a mandatory restore step** — a runbook requirement, verified by execution |
| Persistent volume | **NOT VERIFIED** — requires Railway access. D3 recorded a volumeless postgres losing data on redeploy; a volume must be explicitly confirmed before any persistent staging DB is used |

**Railway prerequisites before staging can proceed** (none actioned):
1. Securely configured Railway credential (never in chat/repo/logs).
2. Read-only inspection of existing staging/production services first.
3. Explicit persistent-volume verification.
4. A decision on how `roles-bootstrap.sql`/`roles.sql` are applied at deploy time, and migrations running as `velora_migrator`.
5. Backup/restore drill on the staging DB, including the re-apply-`roles.sql` step above.
6. No real Velora user/trading data.

---

## 9. Scope boundaries honored

No Phase E ledger/business-semantic enforcement · no MetaAPI · no email · no OCR/AI · no admin · no i18n/SEO · no pg-boss/queue · no trusted-proxy/XFF · no production or staging access · no Railway changes · no DNS/cutover · no `main` modification · no merge/force-push/history rewrite · no application code, schema, migration, or dependency changes.
