# Environment variables — NAMES ONLY.

Values live in the environment (`.env` locally — gitignored; secret store in
staging/production). Never commit values. Never log values. (AGENTS.md rule 1;
security-policy §1.)

| Name | Used by | Purpose |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose/postgres | dev/staging database credentials |
| `DATABASE_URL` | api, worker, migrations | PostgreSQL connection (roles per `db/roles.sql`) |
| `API_ALLOWED_ORIGINS` | api | same-origin guard allowlist (comma-separated) |
| `METAAPI_WEBHOOK_SECRET` | api (Phase 2) | MetaApi webhook HMAC (name-only here; ADR-008) |
| `JWT_SECRET` | api (Phase 2) | per-environment signing key — never reused from PHP (ADR-005/D-04 §7) |
| `APP_ENV` | api, worker, deploy/parity tooling | explicit environment identity: `development` \| `staging` \| `production`; missing/unknown is invalid — no implicit default (ADR-013) |
| `APP_ORIGIN` | api, link generation, deploy targeting | bare https origin bound to the environment; validated against the canonical origin map (ADR-013; canonical staging origin = owner decision OD-1, pending) |

A template with empty values: `infra/env/.env.example`.
