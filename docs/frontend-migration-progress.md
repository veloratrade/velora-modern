# Frontend Migration — Progress (machine-readable resume state)

**Updated:** 2026-09-24 (Asia/Tehran)
**Branch:** `feat/web-full-frontend`
**Status:** FINAL — all phases W0..W5 executed; report: `docs/FRONTEND_MIGRATION_FINAL_REPORT.md`

## Phase completion

| Phase | Status | Commit |
|---|---|---|
| W0 landing protection | DONE (byte-identical to `cf35479`) | `ebb5ebe` merge baseline |
| W1 auth | DONE | `49f9e62` |
| W2 accounts/MetaApi/trades + app shell | DONE | `c74a801` |
| W3 dashboard/analytics | DONE (capability gap documented) | `60e40ec` |
| W4 remaining pages | DONE (GAP shells honest) | `0c9fc49` |
| W4b EN group fix + titles | DONE | `dda0f4f` |
| W5 Dockerfile.web + compose + docs | DONE | `2a0b142` |
| Refresh-efficiency hardening | DONE | `8e66bbd` |

## Tests / gates (last run)

- `npm exec tsc -- -p apps/web/tsconfig.json --noEmit` → 0
- `npm exec tsc -- -p apps/api/tsconfig.json --noEmit` → 0
- `npm run build --workspace=@velora/web` → 0 (35 ƒ routes)
- `node tools/run-tests.mjs` → 804/804 ALL TEST FILES PASSED
- `bash tools/secret-scan.sh` → PASS (0 findings)
- Playwright final audit (definitive, post-`8e66bbd`) → 0 CSP violations; anon/protected redirects correct; all fa/en titles+shell correct; lang/dir correct; no overflow @1440/1024/820/390/375; localStorage = marker only; refresh_token HttpOnly Lax; 1×refresh per authed load

## Live processes (dev evidence environment)

- Web: `npm run start --workspace=@velora/web -- --port 3102` with `VELORA_API_ORIGIN=http://127.0.0.1:8080`
- API: `APP_ENV=development PERSISTENCE=memory JWT_SECRET=… PORT=8080 npx tsx apps/api/src/server-main.ts`
- E2E login (dev): `owner@velora.example` / `a-strong-password-123` (created via dev-gated `POST /api/v1/debug/create-verified-user`)

## Known environment quirks (not bugs)

1. Dev memory rate limiter C-14: `login 8/5min`, `refresh 30/5min` shared per-IP. Mitigated by `8e66bbd` (anonymous boots no longer call refresh at all; authenticated loads = exactly 1 call). R2 wiring remains the owner-gated production fix.
2. `/analytics/*`, credentials, metaapi answer 503 capabilityAbsent in dev (no PG / no secrets) — UI renders localized honest states.
3. Full page loads cost one `auth:refresh` (memory-only access token by design); Sidebar uses client-side `<Link>` (no refresh cost).

## Unresolved owner decisions

R1 (login password policy), R2 (trustedProxyCidrs), R8 (markets/news/support public vs protected), R9 (winRate semantics), OD-1 (staging origin), GAP-SUP, GAP-NL, GAP-AI-BE.

## Resume commands

```bash
git checkout feat/web-full-frontend
npm ci
npm exec tsc -- -p apps/web/tsconfig.json --noEmit
npm run build --workspace=@velora/web
node tools/run-tests.mjs
bash tools/secret-scan.sh
# local demo:
APP_ENV=development PERSISTENCE=memory JWT_SECRET=dev-local-jwt-secret-32chars-long-1234 PORT=8080 npx tsx apps/api/src/server-main.ts &
VELORA_API_ORIGIN=http://127.0.0.1:8080 npm run start --workspace=@velora/web -- --port 3102 &
```

## Git safety recap

No push, no PR, no merge to main, no history rewrite, no branch deletion, no DB migration, no deploy. All work local on `feat/web-full-frontend`.
