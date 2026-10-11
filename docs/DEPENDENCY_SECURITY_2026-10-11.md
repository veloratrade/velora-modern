# Dependency-Security Policy — Governance Hardening 2026-10-11 (main 354edaa)

## Verified baseline (read-only, 354edaa)

- **Manifests:** `package.json` (910 B, workspaces `packages/*`, `apps/*`, deps `tsx ^4.19.0`, devDeps `@electric-sql/pglite ^0.5.8`, `@types/node ^20.14.0`, `typescript ^5.5.4`), `package-lock.json` (59K, lockfileVersion 3, `requires:true`), `packageManager` none (npm only). No `pnpm`, `yarn.lock`, `deno.lock`.
- **Vulnerability controls before this change:** **none** — `find .github -name dependabot.yml` empty, `grep -r "npm audit"` in `.github/` empty, no `audit-level` gate, no `OWASP` scan, no `Snyk`.
- **Trigger inventory (cost):** `ci.yml` `push[main]` + `pull_request[main]` only (no `schedule`, no `cache`, 15m timeout, `cancel-in-progress:true`); `backup-retention.yml` `schedule` daily + `workflow_dispatch` (15m, `cancel:false`); `postgres-evidence.yml` `workflow_dispatch` only (15m, disposable `postgres:16-alpine`); `healthcheck-suite.yml` `workflow_call` only (10m). All `permissions:contents:read` (least privilege).
- **Branch protection (verified with PAT at 354edaa):** `required_status_checks: {strict:true, contexts:["verify"], checks:[{context:verify app_id:15368}]}`, `enforce_admins:{enabled:false}`, `allow_force_pushes:false`, `allow_deletions:false`. Recent `verify` `success` at `354edaa` (`38115747611` main, `38115496660` readiness) satisfies strict.

## Policy (Phase 1, cost-controlled)

1. **Dependabot — weekly, grouped, capped (new: `.github/dependabot.yml`)**  
   Weekly Monday 06:00 UTC, `open-pull-requests-limit:5`, grouped `dev-dependencies` (`@types/*`, `typescript`, `@electric-sql/*` minor+patch) and `runtime-patch` (`tsx`, `pg`, `pg-boss`, `bcryptjs`, `hash-wasm` patch only), `rebase-strategy:disabled`, labels `dependencies`, `cost-controlled`, `commit-message.prefix:chore(deps)`.  
   **Cost:** ~2-5 PRs/week, no daily noise, no `schedule` on `ci` itself. Security updates remain immediate via GitHub (separate from version updates).

2. **No unconditional `npm audit` required check** — **intentionally not added** in Phase 1.  
   **Assessment (cost, baseline, exception):** `npm audit --audit-level=high` on this repo at `354edaa` would scan 59K lockfile + workspaces; baseline unknown (0 vs N highs), exception policy missing (e.g., `pg-boss` transitive `tough-cookie` moderate is often `WONTFIX` until upstream). Adding it as required would block every PR unconditionally and inflate `verify` from 15m.  
   **Provisional path:** manual `workflow_dispatch` `audit` job (`--audit-level=high`, `contents:read`, 10m) for weekly triage, not PR-gate, until (a) baseline `audit` run is captured on `354edaa`, (b) exception policy (allowlist with `npm audit` `audit-level` + `why` + expiry) is documented, (c) owner approves gating. See `docs/QUALITY_GATE_SUCCESSOR_2026-10-11.md` successor addendum for future gate.

3. **Update policy:** Patch/minor auto-grouped; major remains manual (breaking). `package-lock.json` must be committed with `npm ci` proof (CI runs `npm ci` before `tsc`). `packageManager` field stays unset (npm is single source).

## Bypass risks & accurate guard behavior (evidence-supported)

- **Required check `verify`:** `strict:true` prevents stale base (PR must be up-to-date with `main`); `contexts:["verify"]` blocks merge when `verify` `failure`/`pending` (PR #11 was `blocked` until `38115496660` `success`, then `clean`). **Accurate:** `verify` is the only required check; no `backup-gate`, `postgres-evidence`, or `healthcheck` is required — they are `NOT_VERIFIED` on PRs by design (staging/real-PG only).
- **Bypass `enforce_admins:false`:** Admins can push directly to `main` bypassing PR review/required checks (proven by fast-forward `67d7d9b→57875c1→354edaa` pushes succeeding with PAT; `allow_force_pushes:false` still prevents history rewrite but not direct push). **Recommendation (requires separate authorization):** set `enforce_admins:true` and add `CODEOWNERS` (`* @veloratrade/owners`) with `required_reviewers:1` — not changed in Phase 1.
- **Bypass `checkSuites=false` (Railway):** `deploy-staging-gated.yml` documents `staging → staging` trigger with `checkSuites=false` (reported, not re-proven without `RAILWAY_TOKEN`). Direct `git push` to `staging` branch would deploy bypassing `ci`→`backup`→`backup_gate` chain. **Recommendation:** Railway dashboard → remove trigger or set `checkSuites:true` + require `verify` — not changed in Phase 1.

## Exceptions (documented, not invented)

- No `npm audit` exception yet (no baseline). Future `audit` workflow must include `continue-on-error:false` and `allowlist.json` with `advisory`, `why`, `expires`.
- `dependabot` `rebase-strategy:disabled` is intentional cost control; PRs may need manual `dependabot rebase` comment.

## Verification (Phase 1, 354edaa base)

- `python3 -c "yaml.safe_load(open('.github/dependabot.yml'))"` → `OK`
- `python3 -c "yaml.safe_load(open('.github/workflows/ci.yml'))"` → `OK` (header now `ENABLED with cost controls`)
- No `workflow` added as required check; no `allow_force_pushes` change; no `enforce_admins` change.

---
*Phase 1 is governance/docs only; no runtime change, no deployment, no secret, no production load test.*
