# Provisioning Runbook — Environments, Secrets, Variables

Owner-gated procedures (no automation touches these by design). PHP equivalent:
`setup-staging-private.yml` / `setup-production-resend.yml` responsibilities,
replaced by Railway + GitHub environment procedures. Secret VALUES are handled
only by the owner in the respective UIs; this runbook names NAMES only.

## 1. Railway service configuration (owner, Railway dashboard)

Current state: project `Velora` exists; both envs exist with 0 deploys and
UNCONFIGURED build/start commands (see `railway-baseline.md`).

- [ ] P1. Confirm service `velora-modern` in envs `staging` + `production`.
- [ ] P2. Set build command: `npm ci && npx prisma generate && npm run build`
      (mirrors `railway.toml`; dashboard value wins if they ever disagree —
      keep them in sync).
- [ ] P3. Set start command: `npm start`. Healthcheck path: `/health`.
- [ ] P4. Attach Postgres ONLY in the final database phase (not now).
- [ ] P5. Set runtime variables per env (names; values by owner):
      `NODE_ENV` (`staging`/`production`), `PORT` (Railway injects; do not
      hardcode), `LOG_LEVEL`, plus phase-bound secrets as integrations land
      (`JWT_SECRET`, `RESEND_API_KEY`, `GEMINI_API_KEY`, …).
- [ ] P6. Record the public domains; they become `STAGING_APP_URL` / `PROD_APP_URL`.

## 2. GitHub Environments (owner, repo settings)

- [ ] G1. Create environments `staging` and `production`.
- [ ] G2. `production`: required reviewers (owner), no bypass actors.
- [ ] G3. Environment secrets: `RAILWAY_TOKEN` (distinct per-env values,
      least-privilege project tokens).
- [ ] G4. Environment variables (non-secret): `STAGING_APP_URL`,
      `PROD_APP_URL`, `STAGING_FRONTEND_URL`
      (`https://staging-modern.veloratrade.ir`).
- [ ] G5. Branch rulesets per `docs/governance/MERGE_REVIEW_POLICY.md` §5.

## 3. Verification (agent-safe, read-only)

- [ ] V1. `npm run ops:status` shows expected workflows + green cost guard.
- [ ] V2. Dispatch `Deploy Staging` with `dry_run: true` (exercises gates
      without deploying; fails closed on missing vars/secrets).
- [ ] V3. Dispatch `Health Check (staging)` only after the first real deploy.

## 4. Rotation rule

Any suspected exposure of `RAILWAY_TOKEN` (or any phase secret): owner rotates
at the provider, updates the single environment secret, re-runs V2. Tokens are
never stored anywhere else.
