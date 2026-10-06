# ops/verify — environment verification (MG-OPS-TOOLING, AC-36)

The modern counterpart of Legacy's `ops/velora-mgmt/probe/*.tmpl` one-use PHP
probes (@edede31, read-only reference). The CAPABILITY is unchanged — verify a
live environment's real state safely, with least privilege, before trusting
it — but the MECHANISM follows Modern's deployment reality:

| Legacy (shared hosting) | Modern (PG + worker/API hosts) |
|---|---|
| One-use PHP template uploaded per-run via FTP, token-gated header, self-deleting | A local CLI run where `DATABASE_URL` already lives (Railway shell / operator box). Nothing is uploaded, nothing is exposed over HTTP, nothing persists |
| `inspect`/`plan`/`verify` read-only ops; `migrate` hard-gated behind backup token + env match | `npm run ops:verify` is READ-ONLY BY CONSTRUCTION (SELECT / catalog queries only — test-pinned two ways: runtime spy + static keyword scan). Mutating operations are the separately gated migration CLIs + the ADR-012 backup gate |
| Prints metadata only, never credentials/DSNs/row payloads | Same law: no DSN, no secret env values, no user row payloads — counts and catalog rows only |

## What it checks

1. **Server identity** — PostgreSQL version, current database, current user.
2. **Migration ledger diff** — applied migrations (`schema_migrations`) vs the
   migration FILES in `db/migrations/`: unmigrated files and ledger entries
   without files are both drift.
3. **Table inventory + row counts** — every public table with its live count.
4. **Privilege audit (report-only)** — what the connection's user can actually
   do (per-table grants), so a mis-granted deploy account is visible. Report
   only, like Legacy: the tool never changes anything.
5. **FK integrity** — orphaned child rows per foreign key. Hard failure in
   `--check` mode.

## Usage

```bash
DATABASE_URL=... npm run ops:verify                     # human report
DATABASE_URL=... npm run ops:verify -- --json          # machine output
DATABASE_URL=... npm run ops:verify -- --check         # exit 1 on drift (CI/gate)
```

Exit codes: `0` clean · `1` drift (only with `--check`) · `2` failure to run
(driver errors are logged as a CODE only — never a message body, which can
embed host/port details).

Without `DATABASE_URL` the tool applies the real migrations to a disposable
PGlite instance and verifies THAT (dev evidence only — labeled as such in the
output). With `DATABASE_URL` it verifies the live target as-is: missing
migrations there are drift, exactly what `--check` is for.

Code layout: `ops/verify/verifyEnvironment.ts` is the importable, test-pinned
core (all SQL lives there — SELECT/catalog only); `tools/ops-verify.mjs` is the
thin CLI (modes, `--json`/`--check`, exit codes, DSN masking). The battery
`db/tests/opsVerify.test.ts` pins clean/missing-ledger/phantom/orphan verdicts
and the read-only law itself.

## Lineage (what each Legacy probe becomes here)

- `mgmt_probe.php.tmpl` (server metadata + privileges) → sections 1 + 4
- `db_verify_probe.php.tmpl` (tables/counts) → sections 2 + 3
- `trade_migration_probe.php.tmpl` / `admin_migration_probe.php.tmpl` /
  `app_schema_migration_probe.php.tmpl` (migration-step verification) →
  section 2's ledger diff + section 5's FK integrity; per-domain recompute
  checks (PnL etc.) land with the data-migration CLI (MG-DATA-MIGRATION),
  which reuses this tool's primitives
- `db_backup_probe.php.tmpl` (backup state) → already superseded by the
  ported backup-gate law (`ops/backup/`, audit §17.2 COMPLETE-and-extended)
