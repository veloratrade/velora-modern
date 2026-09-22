# Reconciliation Plan — `main` vs `reconcile/foundation-first`

**Status:** ANALYSIS ONLY — **not implemented.** Requires owner approval.
**Prepared:** 2026-09-17 · **main** `99e024c8` · **branch** `126a6ee0`

---

## 1. The core finding

These are **not two versions of one application**. They are **two different
application generations** that share a repository name:

| | `main` (`99e024c8`) | `reconcile/foundation-first` (`126a6ee0`) |
|---|---|---|
| Layout | single package, `src/` | npm **workspaces** monorepo, `apps/*` + `packages/*` |
| Entry | `src/app.ts` | `apps/api/src/server-main.ts` |
| ORM / DB | **Prisma** (`prisma/schema.prisma`, 2 migrations) | raw SQL (`db/migrations/`, 14 migrations) |
| Railway config | **`railway.toml`** — NIXPACKS, `prisma generate`, `npm start` | **`railway.json`** — RAILPACK, `tsx db/migrate.ts && tsx server-main.ts` |
| Test runner | `vitest` | `node:test` |
| Scripts | 17 (`lint`, `format:check`, `i18n:check`, …) | 7 (no `lint`) |
| Merge base | **none** — unrelated histories | |

`git diff main HEAD` = **419 path differences**: 281 added, **133 deleted**, 5 modified.

**⚠ The `railway.toml` / `railway.json` collision is the sharpest hazard.** If both
files existed in one tree, Railway would have two competing build/deploy configs, and
`railway.toml`'s `prisma generate` + `npm start` would **fail outright** against the
monorepo. Any reconciliation must end with **exactly one** deployment config.

## 2. Classification of the 133 files that direct promotion would delete

| Class | Count | Disposition |
|---|---|---|
| **2 — Operational infrastructure that MUST survive** | 18 | 10 workflows + 7 `scripts/` + PR template |
| **4 — Obsolete previous-generation code** | 68 | `src/` (31 modules, 6 core), `prisma/` (3), `tests/` (22), `vitest.config.ts`, `tsconfig.json` — **superseded**, must NOT be resurrected |
| **5 — Documentation** | 40 | `docs/ops` (8), `docs/migration` (6), `docs/governance` (4), phase reports… — **preserve**; cheap and historically valuable |
| **6 — Other** | 7 | `.env.example`, `.eslintrc.json`, `.prettierrc`, `locales/{en,fa}.json`, `CLAUDE.md`, **`railway.toml`** |

**Deleting class 4 is correct and intended** — that is what "modern replaces legacy"
means. Deleting classes 2 and 5 is **not** acceptable. The earlier warning ("promotion
deletes 133 files") was right to stop the promotion, but the nuance matters: **64** of the
133 must be rescued (18 ops + 40 docs + 6 other, excluding `railway.toml`, which is
deliberately retired); the remaining **69** — 68 obsolete-generation files plus
`railway.toml` — are correctly dropped.

## 3. Portability audit of main's 10 workflows

Tested by resolving every `npm run …` / `npx tsx scripts/…` against HEAD's `package.json`:

| Workflow | Verdict | Blocker |
|---|---|---|
| `deploy.yml` (production) | **PORTABLE** | — |
| `rollback.yml` | **PORTABLE** | — |
| `healthcheck-{suite,staging,production}.yml` | **PORTABLE** | — |
| `error-log-staging.yml` | **PORTABLE** | — |
| `backup-evidence-gate.yml` | **NEEDS WORK** | `scripts/validate-backup-evidence.ts` absent — **and superseded** by `ops/backup/backup_gate.py` |
| `secret-scan.yml` | **NEEDS WORK** | `scripts/secret-scan.ts` absent (HEAD uses `tools/secret-scan.sh`) |
| `deploy-staging.yml` | **NEEDS WORK** | `github:cost:check`, `validate-frontend-url.ts`; **superseded** by `deploy-staging-gated.yml` |
| `ci.yml` / `quality-gate.yml` | **NEEDS WORK** | `lint`, `format:check`, `structure:check`, `i18n:check` — none exist in HEAD |

**Conclusion:** carrying main's workflows over *unmodified* would produce a repo whose
CI fails on day one. This is why promotion cannot be a file-level union.

## 4. Two important supersessions (not losses)

- **`backup-evidence-gate.yml` → `ops/backup/backup_gate.py` + `backup-gate.yml`.** The old
  gate accepts `EMPTY-TARGET-BOOTSTRAP` *instead of* evidence. Staging is now data-bearing
  (19 tables, 14 migrations), and `RECONCILIATION_DECISIONS.md` **OD-4** records that
  exception as **NOT APPROVED**. The old gate must **not** be restored as-is.
- **`deploy-staging.yml` → `deploy-staging-gated.yml`.** The old one gates on evidence *or*
  a bootstrap attestation; the new one has no bypass and performs a real backup.

## 5. Recommended strategy — `main` becomes the monorepo, ops layer re-based

Rejected alternatives: wholesale replacement (destroys ops), file-union merge (breaks CI,
two Railway configs), long-lived divergence (two deployment paths — the present problem).

**Proposed sequence** (each step reviewable, none destructive to production):

1. **Preserve first.** Tag `main` as `archive/main-pre-monorepo-99e024c8` so every deleted
   file stays permanently recoverable. *(Backup branch `backup/main-before-migration-promotion-99e024c8` already exists.)*
2. **Port class-2 ops onto the branch, adapted** — not copied blindly:
   - carry the 5 PORTABLE workflows as-is;
   - re-target `secret-scan.yml` at `tools/secret-scan.sh`;
   - drop `backup-evidence-gate.yml` and `deploy-staging.yml` (superseded — record in ADR);
   - adapt `ci.yml`/`quality-gate.yml` to HEAD's real script set, or add the missing scripts.
3. **Carry class-5 docs** unchanged (40 files).
4. **Resolve the config collision explicitly:** delete `railway.toml`, keep `railway.json`.
   State the Railway builder change (NIXPACKS → RAILPACK) in the promotion record.
5. **Keep class-4 deleted**, with the archive tag as the audit trail.
6. **Then** promote via a merge commit preserving both parents — as already planned in
   `PROMOTION_TO_MAIN_REPORT.md`, but against a tree that no longer drops ops.

## 6. Expected resulting architecture

```
push/dispatch → GitHub Actions (CI → backup → verify → store → storage-verify → GATE)
                                                                                  │
                                                             gate PASS ───────────┘
                                                                                  ↓
                                                              Railway staging (railway up)
                                                                                  ↓
                                                                          health check
```

Production remains on the **untouched** `main → production` trigger until a separate
owner-approved promotion plan exists.

## 7. Owner decisions required

1. Approve the strategy in §5 (or choose another).
2. Confirm `railway.toml` is deleted in favour of `railway.json` (builder NIXPACKS → RAILPACK).
3. Confirm `backup-evidence-gate.yml` and `deploy-staging.yml` are retired as superseded.
4. Decide whether `lint` / `format:check` / `structure:check` / `i18n:check` should be
   **re-implemented** for the monorepo or formally dropped.
5. Authorise the archive tag and, separately, the push destination.
