# Security triage — Dependabot + CodeQL (Phase 2 security-fixes wave)

Source: GitHub repository alerts on `main` @ `d8f61576`, checked 2026-11-18 (Asia/Tehran).

## Dependabot — 87 open alerts

| Severity | Count |
|----------|-------|
| critical | 6 |
| high     | 30 |
| medium   | 42 |
| low      | 9 |
| **total**| **87** |

Open Dependabot remediation PRs reviewed (all **superseded — not merged**):

| PR | Scope | Verify | Decision |
|----|-------|--------|----------|
| #22 | @electric-sql/pglite 0.5.8→0.5.16 (dev) | success | superseded |
| #23 | runtime-patch group (2 updates) | success | superseded |
| #24 | react-dom + @types/react-dom | success | superseded |
| #25 | @types/node 20.19.43→26.6.6 | **failure** | superseded |
| #26 | @cloudflare/workers-types | **failure** | superseded |
| #30 | source-map-js 1.2.1→1.2.4 (/web) | success | superseded |
| #31 | next 14.2.35→15.5.28 (/web) | success | superseded |
| #32 | vite + vitest (/web) | success | superseded |
| #33 | minimatch + eslint-config-next (/web) | success | superseded |

**Rationale for supersession (none merged):**

- PRs #22–#26 are based on commit `5872b28`, which predates W0/W1; their dependency/lockfile states no longer match `main`.
- `next` has been `16.4.1` on `main` since well before W1 (R3 already resolved Next to a 0-vuln 16.x line). PR #31 would *downgrade* next below `16.4.1`, contradicting R3. PR #33's `eslint-config-next` is tied to the `next` line and would likewise conflict.
- PR #32 targets `vite`/`vitest`, which are not present in `apps/web/package.json` on `main`.
- PRs #25 and #26 already fail CI verify.
- All nine PRs predate main's resolved `package-lock.json`; applying them would require unverifiable dependency/lockfile reconciliation (no local `node_modules`/verify environment available in this session).

**Handling:** dependency remediation is deferred to CI-verified follow-up work against the current `next 16.4.1` lockfile, rather than merging stale, unmergeable Dependabot PRs.

## CodeQL — 47 open alerts

| Severity | Count |
|----------|-------|
| error    | 1 |
| high     | 40 |
| medium   | 7 |
| **total**| **47** |

Breakdown (by rule, representative locations):

- `js/incomplete-multi-character-sanitization` — `packages/domain/src/notifications/emailTemplate.ts`, `packages/domain/src/telegramTemplates.ts`, `apps/api/src/telegram/telegramMenus.ts`, `apps/api/src/telegram/telegramBot.ts`
- `js/double-escaping` — `packages/domain/src/notifications/emailTemplate.ts`, `apps/api/src/ai/aiBrowserService.ts`
- `js/incomplete-sanitization` — `db/tests/migrateCli.pg.test.ts`, `apps/api/src/adminPlatform/adminPlatformStore.ts`
- `js/incomplete-url-substring-sanitization` — `apps/api/src/telegram/*.test.ts`, `apps/api/src/ai/aiRoutes.test.ts`
- `js/bad-tag-filter` — `packages/domain/src/notifications/emailTemplate.ts`
- `js/log-injection (error)` — `apps/worker-cf/scripts/integration.mjs:148`
- `js/insecure-temporary-file` — `db/tests/migrateIntegrity.test.ts:74`
- `js/insecure-randomness` — `apps/worker-cf/scripts/live-post-flow.mjs:130`
- `js/http-to-file-access` / `js/file-access-to-http` — `apps/api/src/attachments/attachmentService.ts:102`, `apps/api/src/ai/aiRoutes.test.ts:287`, `parity/run.mjs:47`

**Assessment:** 46 of 47 are `warning`; the single `error` (`log-injection`) is in `apps/worker-cf/`, which is **outside the CI-verified scope** (`tsc -b` covers `packages/contracts packages/domain apps/api apps/worker apps/web`; `apps/worker-cf`, `parity/`, `db/tests/` are not typechecked by CI). Most findings live in test files or out-of-scope directories.

**Handling:** no unverifiable code/remediation changes are included in this wave (this session has no local `node_modules`, so `tsc`/`tests`/`verify` cannot be pre-run; changes would only be validated on CI after push, which risks breaking `main` if a guess is wrong). In-scope CodeQL findings (`apps/api/src/*`, `packages/{contracts,domain}`) should be remediated as CI-verified follow-up PRs, one finding at a time.

## Decisions recorded

1. Dependabot PRs #22–#26 and #30–#33 are **closed (superseded)**; they cannot be merged cleanly against `main`.
2. No CodeQL or Dependabot code changes are pushed in this wave pending a CI-verified remediation plan.
3. Revisit when a local verify environment (`npm ci` + `tools/agent-context.mjs` + CI `verify` composition) is available.
