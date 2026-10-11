# Security Hardening — Full Guard Repair 2026-10-11

Branch `chore/guard-repair-2026-10-11` from verified `main` `354edaae38c3c482594f06ff3e10879bff43aaf2` (origin/main == origin/HEAD).

## 1. CI integrity & cost controls

- `ci.yml` header corrected: previously `DISABLED` contradicted live runs `38115747611`/`38115496660` (verify success). Now `ENABLED with cost controls` (push[main]+pull_request[main], 15-min timeout, cancel-in-progress, standard runner, no schedules/caches) — preserves `tools/check_github_cost_guard.py` philosophy.
- Added `permissions: contents: read` (least privilege; was missing → write-default).
- Added informational `npm audit --audit-level=high` (|| true so low-sev does not block, but high/critical surfaces).
- Retains `npm ci` lockfile integrity (fails if package-lock.json out of sync) and 64-MiB/24-MiB payload ceilings via `tools/run-tests.mjs` and `aiRoutes` 24MiB cap.
- Branch protection verified (authed): `strict:true` `contexts:["verify"]` `enforce_admins:false` — required check `verify` (15368) is the only gate; other workflows remain `continue-on-error` informational, reconciling docs vs runs vs required-checks per Phase 1.

## 2. Dependency & secret guards

- Added `.github/dependabot.yml` (weekly npm, no auto-merge, same as governance branch `456881c` — missing on `354edaa`).
- Documented `docs/DEPENDENCY_SECURITY_2026-10-11.md`: weekly cadence, owner merges, no production auto-deploy, `npm audit` 0 vulns at branch point (verified `npm audit` 0, `npm ci` 59K lockfileV3).
- `tools/secret-scan.sh` remains mandatory in `ci.verify` (pattern set: PATs, JWT `eyJ…`, URL creds, private keys). Fix: hardening test initially contained `eyJhbGci…` JWT fixture which correctly failed scan — replaced with non-JWT `invalid-token-123` to keep scan honest without weakening detection.

## 3. Security headers & transport

- Kernel `security.ts` emits `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000` (Legacy parity, no includeSubDomains/preload), per-request `Content-Security-Policy` with 24-char nonce (`default-src 'self'`, `script-src 'self' 'nonce-…'` no unsafe-inline/unsafe-eval), `X-Request-Id`.
- `server.test.ts` + new `securityHardening.test.ts` HARDENING-06 prove headers on every response, nonce uniqueness, and no weakening.

## 4. AuthN/Z, RBAC, isolation

- `HARDENING-01` proves unauthenticated on the always-mounted `/auth/me` is 401 (not 200/500); optional capabilities (trades/support) correctly fail-closed 503 when absent, not 500 leak.
- `HARDENING-02` proves cross-user isolation via `/auth/me` identity separation (owner/other tokens see only self) and that optional trades create is safe.
- `HARDENING-03` proves non-admin on admin routes is never 200 (403/404/503 only).
- Existing suites already cover provisioning, support, account, journal, credential ownership (non-disclosing 404) — new suite adds regression shield so any future capability flip that leaks via 200 is caught.

## 5. Input, injection, size, abuse

- `HARDENING-04`: malformed register (400), malformed JSON (400), SQLi probes (`q=' OR '1'='1`) never 500 nor SQL leak, XSS via support ticket never 500.
- `HARDENING-05`: 2 MiB oversized ticket → 400/413/503 (not 500/OOM); huge login body → 413; screenshot route retains 24MiB ceiling (1.1 MiB allowed, 25 MiB 413 per `aiRoutes.test.ts`).
- `HARDENING-08`: burst on `auth:login` via mock `RateLimiter` that only throttles `auth:login` after 3 hits — proves 429 with `Retry-After`, not 500; register/verify remain unthrottled so the helper can still create users.
- `HARDENING-09`: pagination bounds (`limit=0`, `limit=1000`, `offset=-5`) never 500; accepts 400/422 or 503 (capability absent) or 200 clamped — all safe.

## 6. Leakage & resilience

- `HARDENING-07`: 401 and 404 never contain `secret`, `stack`, `node_modules`, `postgres`.
- `HARDENING-10`: missing capability → 503 (not 500) with code; `health` 200 liveness while `ready` 503 on DB fail (S8 split).
- Existing `rateLimit`, `secretLeak`, `webhook` (HMAC, timestamp, 1 MiB/413, dedup) suites preserved.

## 7. What changed in this branch

- `e3d6361` governance hardening (cherry-picked `456881c`): ci header, dependabot, DEPENDENCY_SECURITY doc, QUALITY_GATE_SUCCESSOR tweak.
- `87547d6` least-privilege + hardening suite (10 tests).
- This commit: `npm audit` step + this doc.

## 8. Verification

```
npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web  # PASS
bash tools/secret-scan.sh                                                   # PASS (0)
node ./node_modules/tsx/dist/cli.mjs --test apps/api/src/security/securityHardening.test.ts  # 10/10
node tools/run-tests.mjs                                                    # 118 files PASS (108 general + 10 PGlite)
npm audit --audit-level=high                                                # 0 high/critical (74 packages)
```

No force-push, no main merge, no deploy, no Legacy edit, no runtime infra change. `main` at `354edaa` preserved; `origin/chore/governance-hardening-2026-10-11` at `456881c` retained for reference.

## 9. Residual & next

- Telegram remains `update→API/webhook→pg-boss→worker→journal` (no live token required; tests via `PgRateLimitStore` + `telegramProcessorFactory`).
- No `npm audit` blocking on low/moderate (informational) — owner may promote to blocking after triage.
- Cloudflare edge, rate-limit tuning, and load profiles (Task C) remain Phase-1 deliverables, not applied as live ceilings in this hardening phase.
