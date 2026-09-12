# Phase B Security Record — S1–S8 Hardening & Verification (2026-09-12)

**Owner authorization:** Phase B ONLY — audit, fix, and prove closure of security
findings S1–S8 on branch `reconcile/foundation-first`. No promotion to `main`;
no Phase C+; no production systems touched. Execution locus confirmed by owner:
harden the **Local foundation** (the tagged Remote snapshot stays frozen; findings
close against the target architecture that Phase C will port onto).

**Result:** PHASE B: PASS WITH OPEN ITEMS — S1, S2, S3, S4, S6, S7, S8 CLOSED
(unit/contract-level evidence); S5 CLOSED at the authorized local boundary with
a labeled limitation (real user-store persistence is Phase C/D). No deployment
exists or is claimed; all evidence is unit/contract-level, not runtime/PG.

## Execution locus (owner-confirmed)

The S1–S8 findings cite Remote files (`src/modules/auth/jwt.ts`,
`src/config/env.ts`, `src/app.ts`, `password.ts`) that exist only inside the
frozen tag `remote-snapshot-99e024c829db`. They were hardened **in the Local
foundation**, which already carried the target primitives (exact-Argon2id
hasher, PHP `$2y$` proof vector, CSP-nonce middleware, fail-closed origin
contract). Nothing from the Remote tree was copied in; no duplicate application
tree exists.

## Finding dispositions

| ID | Finding | Disposition | Evidence |
|---|---|---|---|
| S1 | Hardcoded JWT secret fallback (Remote `jwt.ts:14`) | **CLOSED** (target architecture) | `apps/api/src/auth/jwt.ts`: no fallback, no env reads, construction throws without a secret; `packages/contracts/src/securityConfig.ts` SC-001/SC-002: production/staging boot fails without a ≥32-char secret. Tests: jwt.test.ts (construction gate, source audit), securityConfig.test.ts, boot.test.ts |
| S2 | Fail-open environment fallback (Remote `env.ts:33-43`) | **CLOSED** (target architecture) | `kernel/boot.ts` fail-closed boot: APP_ENV/APP_ORIGIN explicit (EO-001/002, ADR-013), API_ALLOWED_ORIGINS explicit in prod/staging (SC-007), invalid PORT blocks (BOOT-001), deterministic exit 1 in `server-main.ts`. Audit of ALL env defaults: only PORT (8080) and dev loopback allowlist remain — both dev-only, non-security-sensitive |
| S3 | Argon2id parameters not pinned (Remote `password.ts:46`) | **CLOSED** (already implemented; proof extended) | `apps/api/src/auth/hashing.ts` pins m=19456/t=2/p=1 (ADR-005/D-04); NEW proof test decodes the actual generated hash's parameter segment and asserts 19456/2/1 exactly + constants pinned + verify/reject |
| S4 | Synthetic-only `$2y$` vector (Remote) | **CLOSED** | Local proof gate uses the canonical PHP `password_hash()` example vector (independently generated PHP artifact, public, no credentials): verifies + rejects wrong password + `$2y$`≡`$2b$` flavor equivalence. No PHP runtime exists in the sandbox to generate a fresh vector — provenance documented in `proof.test.ts` header |
| S5 | Missing rehash-on-login | **CLOSED at authorized local boundary** | `packages/domain/src/passwords.ts` `verifyAndRehash` (verify-first; rehash only on successful login of non-compliant hash; exact D-04 params). Policy tests (scripted hasher) + real-crypto tests (`rehash.test.ts`: `$2y$`→Argon2id persisted via in-memory store double; compliant hash NOT rehashed; wrong password rejected; plaintext never stored). **LIMITATION:** real user-store persistence = Phase C/D |
| S6 | `Math.random()` JWT jti (Remote `jwt.ts:23`) | **CLOSED** (target architecture) | `jwt.ts` uses `crypto.randomUUID()` (OS CSPRNG); jti uniqueness + v4-format asserted per token; entropy NOT injectable (clock only, TestClock pattern). Repository `Math.random` audit: only injectable retry-jitter RNGs in queue semantics — not security paths |
| S7 | CSP without nonce (Remote `app.ts:34-36`) | **CLOSED** (already implemented; proofs extended) | `kernel/security.ts`: per-request 16-byte CSPRNG nonce, strict CSP. NEW tests: exact directive policy (`script-src 'self' 'nonce-…'` only — no hosts/wildcards/unsafe-*), full header set, nonce rotation, honest readiness |
| S8 | Production memory persistence fallback | **CLOSED** (boundary established) | `securityConfig.ts` SC-004/005/006 + `boot.ts`: `APP_ENV=production`+`PERSISTENCE=memory` = deterministic startup failure (exit 1); prod/staging require explicit `PERSISTENCE=postgres` + `DATABASE_URL`. Runtime: no code path can substitute memory in prod/staging; DB loss → lazy-reconnect probe → readiness red (`/ready`, `/health` 503) while the process stays up — never fabricated "ok". **pg runtime dependency is Phase D;** until then a configured DATABASE_URL without pg yields red readiness (honest failure) |

## Structural guarantees (source-audit evidence)

- `grep -rn "process.env" apps packages` → only `server-main.ts` (boot wiring,
  validated), `worker/index.ts` (DATABASE_URL or explicit no-op — no fallback),
  `db/migrate.ts` (dev tool). No security module reads the environment.
- No literal secret anywhere; test secrets are prose-like test-only strings;
  the cross-implementation JWT vector is generated at test time by Python's
  stdlib so no JWT literal is committed (secret-scan pattern by design).
- Test DATABASE_URLs are credential-less (`postgresql://127.0.0.1:5432/…`).

## Verification battery (executed 2026-09-12, this branch)

- `npm run typecheck` — 0 errors (script repaired first: dead `packages/config`
  reference removed — pre-existing defect since b6228ef; `@velora/config` stub
  remains untouched pending owner decision)
- `npm test` — **154/154 pass** (89 baseline + 65 new security tests)
- `npm run test:migrations` — 5/5 pass (unchanged)
- `npx tsx tools/parity-smoke.ts` — 6/6 pass (kernel contracts unchanged)
- `bash tools/secret-scan.sh` — PASS, 0 findings

## Boundaries and honest limitations

- All evidence is **unit/contract-level**. No real PostgreSQL, no runtime
  deployment, no production system was used or claimed (test honesty rule).
- `server-main.ts` is a thin shell over the fully-tested pure `assertBootable`;
  it is structurally reviewed, not separately unit-tested.
- Dev invocation is now explicit (fail-closed): `APP_ENV=development
  APP_ORIGIN=http://127.0.0.1:8080 PERSISTENCE=memory JWT_SECRET=<32+ chars>`.
- Production boot additionally requires owner-declared
  `CANONICAL_PRODUCTION_ORIGINS` — production cannot boot until the owner
  declares the canonical origin set (intentional; Gate 3B is BLOCKED).
- Worker queue boot policy is Phase F; the worker has no memory fallback today
  (without DATABASE_URL it does nothing, loudly).
