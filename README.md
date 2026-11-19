# velora-modern

Modern TypeScript implementation of Velora (trading journal platform).

**Monorepo:** `apps/api` (Node API) · `apps/web` (Next.js) · `apps/worker`
(pg-boss) · `packages/{contracts,domain}` · PostgreSQL 16 via direct `pg`
(no ORM — ADR-010 / OD-6) · forward-only migrations `db/migrations/0001…0022`.

**Status: MIGRATION NOT CLOSED** — 2026-09-25 two-repository audit verdict:
*NOT CLOSED — PARTIAL MIGRATION WITH MATERIAL BEHAVIOURAL DIVERGENCE AND
BLOCKING OPERATIONAL GAPS* (closure gates 0 PASS / 1 PARTIAL / 14 FAIL).

- Canonical current project state: `docs/state/CURRENT_STATE.md` (machine
  twin `docs/state/current-state.json`), validated at session start by
  `node tools/agent-context.mjs` (ADR-017).
- Immutable historical baseline:
  `docs/audits/2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md`.
- The production system remains the PHP repository
  (`veloratrade/veloratrade`) during modernization; sync is one-way
  PHP → Modern (capability registry model).
- Entry points: `AGENTS.md` (governance + session protocol) →
  `docs/state/CURRENT_STATE.md` (current state) → `docs/adr/`
  (ADR-001…014, 016, 017 — ADR-015 intentionally unassigned, see
  `docs/adr/README.md`).

## Codespaces / local test environment

A one-click dev/test environment is provided under `.devcontainer/`:

- `.devcontainer/devcontainer.json` — Codespaces configuration; forwards ports
  3000 (web), 8080 (api), 5432 (Postgres).
- `.devcontainer/docker-compose.yml` — `dev` (interactive Node container,
  workspace mounted), `postgres` (PostgreSQL 16), `migrate`, `api`, `worker`,
  `web`.
- `.devcontainer/Dockerfile` — Node 22 + `postgresql-client`/`git`/`curl`.
- `tools/seed-demo.ts` — idempotent demo users/accounts/trades (test data
  only, no real credentials).

**Usage:** open this repo in GitHub Codespaces, or run
`docker compose -f .devcontainer/docker-compose.yml up --build` locally.

On first Codespaces start, `postCreateCommand` runs `npm ci`, applies the
forward-only migrations (`db/migrate.ts`), and seeds demo data
(`tools/seed-demo.ts`). The dev container then stays running; open a terminal
and run `npm run dev` (web), `npm run start:worker` (worker), `npm test`,
or `npm run typecheck`.

⚠️ All environment values in the compose file are **development placeholders**
— no real secrets, no production credentials, never production.
