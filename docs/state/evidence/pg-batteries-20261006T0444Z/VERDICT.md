# Real-PG battery run — pg-batteries-20261006T0444Z

- Command: `DATABASE_URL=postgres://…@127.0.0.1:5432/velora_test tools/run-pg-batteries.sh`
- PostgreSQL 17.11 (Debian, local disposable cluster), role velora (superuser for SET-ROLE harness), database velora_test — created fresh for this run.
- Result: **batteries: 33 · runs: 66 (forward + reverse) · failures: 0 · skipped: 0 → REAL-PG EVIDENCE: PASS**
- 66 per-battery logs in this directory (forward + reverse for each `.pg.test.ts`).
- DSN credential in the command line above is a THROWAWAY local test role, not a secret.
- Note: this run was produced in the migration workspace on a locally installed
  disposable PostgreSQL cluster (not CI — GitHub Actions remain disabled per
  owner cost policy). Evidence class: real-PostgreSQL, disposable-instance.

- Aggregate: **642 tests · 0 failures · 0 skipped** across the 66 runs.
