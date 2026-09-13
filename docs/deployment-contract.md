# Deployment Contract — database identities at deploy time

Status: **Active** (2026-09-14). Implements the five-role model ratified in the
ADR-010 amendment (2026-09-13). This document records *when* each database
identity is used during a deployment. It introduces no new roles and changes no
privileges.

## The three identities

Two different questions must not be conflated:

- **Available to the deployment process** — the variable is present in the
  service/deployment environment, so a command run during deployment (such as
  `db/migrate.ts`) can read it.
- **Consumed by the long-running application process** — the variable is read by
  `apps/api/src/server-main.ts` (or the worker) and used by the process that
  keeps serving traffic after deployment finishes.

| Variable | Role | Consumed by | Available to the deployment process? | Consumed by long-running app runtime? |
|---|---|---|---|---|
| `DATABASE_URL` | `app_readwrite` | `apps/api/src/server-main.ts` (API/worker runtime) | Yes | **Yes** |
| `MIGRATION_DATABASE_URL` | `velora_migrator`, with `?options=-c%20role%3Dvelora_owner` | `db/migrate.ts` only | Yes | **No** |
| `ADMIN_DATABASE_URL` | bootstrap/superuser | `db/provision.ts` only | **No — never supplied** | **No — never** |

- **`DATABASE_URL` — runtime credential.** The only database credential the
  long-running API/worker process reads.
- **`MIGRATION_DATABASE_URL` — deployment/migration credential.** Present in the
  service configuration so that `db/migrate.ts` can run as the first step of the
  start command, but **not consumed by `server-main.ts`** and therefore not an
  application runtime credential. VERIFIED: the only reference to it in this
  repository is the CLI block of `db/migrate.ts`.
- **`ADMIN_DATABASE_URL` — privileged operator credential.** Used only by
  `db/provision.ts`, run out of band by an operator. It must never be supplied to
  the application service at all.

`velora_owner` is `NOLOGIN`: it is an ownership identity, never a connection
identity. It is reached only through `SET ROLE`.

## Start command

`railway.json`:

```
npx tsx db/migrate.ts && npx tsx apps/api/src/server-main.ts
```

- `db/migrate.ts` prefers `MIGRATION_DATABASE_URL`, so the schema is evolved by
  `velora_migrator`, which owns nothing and holds no runtime DML. The
  `options=-c role=velora_owner` parameter is scoped to that one connection
  string, so the API/worker runtime cannot inherit it.
- `apps/api/src/server-main.ts` reads `DATABASE_URL` (`app_readwrite`).
- Migrations are forward-only (ADR-010) and the runner is a no-op
  (`up to date`) when `schema_migrations` is already current, so a redeploy of
  an unchanged schema performs no DDL.

### Why `db/provision.ts` is not in the start command

`db/provision.ts` requires `ADMIN_DATABASE_URL`, a bootstrap/superuser
connection. Chaining it into `startCommand` would place that privileged
credential in the environment of every running application instance — the exact
separation the five-role model exists to create, and which `db/provision.ts`
itself documents ("the application runtime never holds the privileged
credential"). Privilege provisioning is therefore an **operator step**, not a
runtime step.

This also matches the pre-existing contract recorded in
`docs/evidence/PHASE-D-D5-ROLES.md` §7, which notes that `startCommand` ran
`db/migrate.ts` only and that changing it is a deployment-behaviour decision.
This document *is* that decision, and it resolves open item 4 of that section:
`roles-bootstrap.sql`/`roles.sql` are applied by `db/provision.ts`, out of band.

## Operator procedure (once per environment, and after every restore)

Run from a trusted operator context — never from the application service:

```
ADMIN_DATABASE_URL=...  ADMIN_DATABASE_ROLE=<bootstrap-role> \
  npx tsx db/provision.ts --phase pre-migration

MIGRATION_DATABASE_URL=... \
  npx tsx db/migrate.ts

ADMIN_DATABASE_URL=...  ADMIN_DATABASE_ROLE=<bootstrap-role> \
  npx tsx db/provision.ts --phase post-migration
```

`--phase post-migration` re-applies `db/roles.sql`, sets default privileges,
revokes the migrator's `CREATE`, and then verifies the 8-check privilege grid,
exiting non-zero if any check regresses.

**After a restore this is mandatory.** `infra/backup/` dumps with
`--no-owner --no-privileges`, so a restored database has no grants at all until
provisioning is re-run (VERIFIED — `docs/evidence/PHASE-D-D5-ROLES.md`).

## Credentials

Login passwords are generated out-of-band with a CSPRNG and stored only in the
platform secret store. They are never committed, printed, or logged. Passwords
containing URI-reserved characters (`+`, `/`, `=`) **must** be percent-encoded
inside connection strings.
