# METAAPI PROVISIONING IMPLEMENTATION REPORT

Brief 38 — implementation of the authorized MetaAPI provisioning, account-binding
and disconnect capability.

Status legend used throughout: **VERIFIED** = executed on this machine with the
output observed; **NOT PROVEN** = not demonstrated by execution.

---

## 1. Commit

| Item | Value |
|---|---|
| Commit | `6d9fd95` (implementation) |
| Report commit | `a475b0d` (this document) |
| Message | `feat(metaapi): add user-scoped provisioning and account binding` |
| Branch | `reconcile/foundation-first` |
| Parent | `029a97690b893178b0d96632c1988f238a583418` |
| Files | 27 changed, ~3800 insertions, 43 deletions |
| Working tree | CLEAN after commit (VERIFIED) |
| `main` | `99e024c829db1a9be0980d8eaf8272927aa0d25d` — **unchanged** (VERIFIED) |
| `backup/main-before-migration-promotion-99e024c8` | present at `99e024c8` (VERIFIED) |
| Remotes | none configured — **push was not possible and was not attempted** |

Single commit, as required. No force-push, no history rewrite, no merge.

## 2. Governance traceability

The commit **includes** the two governance amendments that authorized this work
(Phase 20), so code and authorization land together and neither can be read
without the other:

- `docs/adr/ADR-016-credential-encryption-key-management.md` (+113)
- `docs/reconciliation/METAAPI_OWNER_DECISIONS.md` (+313)

Implementation is traceable to **OD-MP-1** (credential boundary), **OD-MP-2**
(audit vocabulary) and **OD-MP-3** (disconnect semantics). No OD decision was
reopened, reinterpreted or re-approved, and no new ADR was invented.

## 3. API contract

Two routes, both user-scoped. Route count 38 → 43 (the helper adds guarded
branches).

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/api/v1/accounts/{id}/metaapi/connect` | Binds an existing user-owned account to a MetaAPI account |
| `POST` | `/api/v1/accounts/{id}/metaapi/disconnect` | Unbinds; optional opt-in provider delete |

- The user id is taken **only** from `claims.sub`. No route accepts a `userId`
  from a client; a body-supplied `userId` is ignored (test-proven).
- Unauthenticated → 401; capability absent → 503; non-owner → **404**
  (non-disclosing, so account existence does not leak).
- No response returns a secret, ciphertext, token or provider body.

## 4. Credential boundary

`apps/api/src/metaapi/provisioningService.ts` is the **first and only**
production consumer of `CredentialStore.reveal(id, userId)`. VERIFIED by
grep: the only other `.reveal(` in production is the unrelated
`platformToken.reveal()` in `server-main.ts:315`.

- `reveal(id, userId)` signature **unchanged**; no `revealAny`, `adminReveal`,
  `listAll`, `findAny` or `getAllCredentials` was added.
- Plaintext is memory-only: never persisted, logged, audited, queued, returned,
  or made visible to the worker.
- An admin/System Owner cannot use another user's credential (test-proven);
  a foreign credential on one's own account is refused and recorded as
  `CREDENTIAL_USED` / `denied`.

## 5. MetaAPI integration

- `POST /users/current/accounts`, headers `auth-token`, `transaction-id`
  (32-char crypto-random), `accept`, `content-type`.
- **`Idempotency-Key` is never sent** — it is documented nowhere by MetaAPI, so
  the legacy PHP usage is a defect and was not copied. Asserted on create,
  reconcile and delete.
- Account id is read from `response.id` and shape-validated; a malformed body
  is a typed error, not a crash.
- Documented **202** flow: `Retry-After` / `metadata.recommendedRetryTime` is
  captured, polling runs under a bounded policy, and **no database transaction
  is held across any HTTP call**.
- Provider-side deduplication is **not** assumed.

### 5.1 202 resolution — DOCUMENTED DEVIATION from the vendor's replay wording (AUD-05)

The vendor documents one retry semantic for `POST /users/current/accounts`:
*"If your request has returned 202 status code, please reuse the same
transaction id value to poll the result."* The six statements below record
exactly what this implementation does instead, and why.

1. **What the provider documents.** 202 (`AcceptedError`) means accepted but
   not yet complete, carrying `metadata.recommendedRetryTime`; the documented
   way to learn the outcome is to **replay the create request with the same
   `transaction-id`**.
2. **What this implementation actually does.** On 202 it does **not** replay
   the POST. It sleeps (`Retry-After` → `recommendedRetryTime` → default
   2000 ms, capped at 30 s) and then polls
   **`GET /users/current/accounts?query=<marker>`**, matching the deterministic
   secret-free marker `velora-<32 hex>` exactly on `name`
   (`provisioningService.ts:415-421`, `provisioningClient.ts:305-325`). The
   read carries `auth-token` only — **no `transaction-id` header**, asserted at
   `provisioningClient.test.ts:222`.
3. **Why.** Replaying a *create* to discover a result requires trusting
   undocumented provider deduplication: if the transaction id is not honoured
   as a dedup key, the replay creates a **second billable account**. OD-MP-1
   forbids assuming provider dedup. The marker search asks a read-only question
   the documented read endpoint can answer, so the worst case of a lost
   response is a redundant read, never a duplicate account.
4. **The mandatory part of the contract is still satisfied.** `transaction-id`
   is documented as **Required on account creation**, and it is always sent on
   POST (`provisioningClient.ts:246`), always 32 crypto-random hex characters,
   and **persisted** on the operation row. When a later attempt genuinely
   re-POSTs (a retry of an unresolved operation, not a 202 poll), it reuses the
   **stored** id — `operation.transactionId ?? newTransactionId()`
   (`provisioningService.ts:291`) — so the documented replay identity is
   preserved where a replay actually occurs. **No mandatory provider contract
   is violated**; the deviation is confined to the *optional* choice of how to
   resolve a 202, so no STOP condition is triggered.
5. **What this costs.** The documented 202 resolution path is **not the one
   exercised**. If MetaAPI's marker search were eventually consistent, a poll
   could miss a just-created account; the budget (5 attempts) would then be
   exhausted and the outcome deliberately classified `PROVIDER_UNAVAILABLE`
   **ambiguous — never "failed"** — leaving the operation row recoverable by
   marker instead of retried blindly.
6. **Proof status: NOT PROVEN against the real provider.** No real 202 has ever
   been observed. The 202 branch, the retry-hint precedence, the bounded budget
   and the ambiguity classification are proven only against a stubbed `fetch`
   (`provisioningClient.test.ts`, `provisioningService.test.ts`). Real 202
   timing, and whether `?query=` is read-your-write consistent, remain
   unverified and are listed in §10.
- Provider response bodies never reach logs, error messages or stacks: a 400
  surfaces literally as `"status 400"` (test-proven).
- Provisioning host is distinct from the client/history host and is settable
  via `METAAPI_PROVISIONING_BASE_URL` (absolute `https:` only; otherwise a
  structured `MA-004` warning and fallback to the default). Added to
  `infra/env/.env.example` as a **name only**.

## 6. Binding

- Written only through the explicit `bindMetaApiAccount(...)` store method — no
  raw SQL in routes.
- Keeps the existing **GLOBAL** partial unique constraint on
  `trading_accounts.metaapi_account_id`; `external_account_id` is not reused and
  no second column was added.
- Phase 8 decision: **bind an existing user-owned account**; the service never
  silently creates or duplicates. Conflicts raise `DUPLICATE_BINDING` (409).
- A compare-and-set refuses a silent rebind of an already-bound account.
- Transaction boundary (Phase 9): short txn (reserve operation + lock) →
  **commit** → `reveal()` → HTTP/poll → short txn (bind + operation state +
  audit).

> **ACCURACY CORRECTION (AUD-03).** As originally written for `6d9fd95`, the
> final bullet above was **an overstatement**: the bind, the terminal operation
> state and the audit append each ran on their own connection, so a crash or an
> audit failure between them could commit a binding with no audit row. The
> audit caught this. It became true only with the remediation commit, which
> runs all three inside one `withTransaction` block and proves the rollback on
> real PostgreSQL with a verified negative control. `markStatus(ACCEPTED)`
> remains deliberately **outside** that transaction: it is the record that
> makes a provider-side account recoverable, so it must survive a rollback.

## 7. Audit

- Exactly two new actions: **`CREDENTIAL_USED`** (`success`/`denied`) and
  **`ACCOUNT_BINDING_CHANGED`** (direction via `before_state`/`after_state`).
- **`CREDENTIAL_REVEALED` was not added** and the database still rejects it
  (23514, test-proven).
- Ordering is `CREDENTIAL_USED` → `ACCOUNT_BINDING_CHANGED`.
- Phase 11: `audit_log.trading_account_id`, one nullable `BIGINT`, **no FK**.
  Justification is written into the migration: `CASCADE` would erase binding
  history, `RESTRICT` would let the audit trail block account deletion, and
  `SET NULL` is an UPDATE against a table whose UPDATE privilege is revoked from
  every runtime role. It is a historical identifier, so the trail **outlives**
  the account — proven against real PostgreSQL by hard-deleting the account and
  re-reading the row.
- Append-only posture unchanged; `audit_log` still has no UPDATE/DELETE/TRUNCATE
  for `app_readwrite` and no privileges at all for `velora_worker` (VERIFIED).

## 8. Security

- **Worker remains credential-free**: no credential import, no
  `CREDENTIAL_MASTER_KEY`, no provisioning import; `MetaApiSyncPayload` is still
  flat scalars (`accountId`, `metaapiAccountId`, `from`, `to`).
- `db/roles.sql` now REVOKEs **all** privileges on `provisioning_operations`
  from `velora_worker` and `velora_readonly`, discharging the standing **B11**
  obligation created by `ALTER DEFAULT PRIVILEGES`. `app_readwrite` keeps
  SELECT/INSERT/UPDATE (an operation is a state machine, not a ledger) but
  **cannot TRUNCATE** the evidence.
- **Negative control executed**: deleting only the two new REVOKE lines makes
  exactly 2 tests fail, then `db/roles.sql` was restored byte-identical
  (`diff` ⇒ IDENTICAL). The REVOKE is load-bearing, not decorative.
- Phase 15 complete: the `as never` at `metaApiSyncHandler.ts:107` is gone, with
  **no** `as any`, `as unknown as`, `@ts-ignore` or `@ts-expect-error`
  replacement.
- **Self-correction during the Phase 21 checklist.** A widened sweep (the
  earlier one was scoped to `apps/` only) found two `as unknown as OperationRow`
  double casts in the new `pgProvisioningStore.ts`. They copied the house
  pattern used by every pre-existing `pg*Store`, but `as unknown as` is on the
  brief's prohibited list and these were **new**, so matching precedent was not
  a defence. Both were **eliminated** rather than relocated: `mapOperation` now
  takes the driver's `Record<string, unknown>` directly and narrows each column
  through explicit converters, and `status` is **validated** against the 0014
  CHECK vocabulary instead of asserted — so a future migration that widens the
  constraint fails loudly here rather than leaking an invalid value into the
  domain. The provisioning stack now contains **zero** unsafe casts, and the fix
  was folded into the implementation commit (both commits were local-only and
  unpushed) so that commit does not itself carry a hard-stop violation.
  Re-verified afterwards: 678/678, 19/19 on real PostgreSQL, typecheck 0.
  The ~36 pre-existing casts in older `pg*Store` files are untouched: they
  predate this brief and are out of scope.
- `provisioning_operations` has no secret-bearing column; `operation_key` and
  `provider_marker` are derived identifiers and DB-constrained to hex/marker
  shapes, `last_error_code` is constrained to `^[A-Z_]{1,40}$` so a provider
  message cannot be stored in it.
- Migration 0014 is **additive only** — no DROP TABLE/COLUMN, no TRUNCATE, no
  DELETE, no UPDATE of existing rows.

## 9. Tests — actual results only

Every figure below was executed on this machine and observed.

| Suite | Result |
|---|---|
| `npm test` (full battery, 60 files) | **678 / 678 pass**, 0 fail, **0 skipped** — `ALL TEST FILES PASSED`, reproduced twice |
| Real PostgreSQL 17.10 — 18 `*.pg.test.ts` batteries | **178 / 178 pass**, 0 fail, 0 skipped |
| `db/tests/metaapiProvisioning.pg.test.ts` (new) | **19 / 19 pass** on a **freshly created** database |
| `db/tests/migrations.test.ts` | **19 / 19 pass** (was 16 — three 0014 tests added) |
| `db/tests/pgRoles.pg.test.ts` | **22 / 22 pass** (was 18 — four privilege tests added) |
| `provisioningClient.test.ts` (new) | **25 / 25 pass** |
| `provisioningService.test.ts` (new) | **26 / 26 pass** |
| `npm run build` | exit **0** |
| `npm run typecheck` | exit **0** |
| `npm run secret-scan` | **PASS (0 findings)** |

Brief coverage A–H: **A** credential boundary · **B** provider HTTP · **C** real
PostgreSQL · **D** concurrency on real PG with **two separate `Pool`s** (exactly
one winner for both `bindMetaApiAccount` and `reserve`) · **E** failure recovery
(503 ⇒ `AMBIGUOUS`, retry **reconciles instead of re-creating**) · **F**
secret-leak regression · **G** disconnect matrix · **H** existing suite not
weakened.

**Nothing was weakened to make anything pass.** Three existing assertions were
touched and each was *tightened or de-rotted*, never relaxed:
- `auditCredentialContract.test.ts` / `.pg.test.ts` — closed-world column/key
  sets extended 11 → 12 for the new non-secret identifier; the forbidden-field
  loops are untouched and the exact-count assertions remain exact, so any future
  column must still justify itself.
- `auditTrail.test.ts` — a **test fake** was brought up to the contract; the
  production type was not loosened.
- `migrateCli.pg.test.ts` — replaced a hardcoded `0010_user_credentials.sql`
  head literal with the disk-derived `expectedHead()` the same file already
  uses. This test was **already failing at baseline**: proven by running it from
  a clean clone of `029a9769`, which produced the identical 3 pass / 3 fail.

## 10. Remaining blockers / NOT PROVEN

- **Deployment is unproven and out of scope.** `railway.json` still starts the
  API only; there is no worker service (B10-a remains unauthorized), so the
  scheduled credential-free worker leg of the target flow is **NOT PROVEN in a
  deployed environment**.
- **No live MetaAPI call was ever made.** All provider behaviour is proven
  against stubs at the `fetch` boundary plus the vendor documentation. Real
  provider acceptance, real 202 timing and real reconciliation latency are
  **NOT PROVEN**.
- `db/roles.sql` is applied by `db/provision.ts` / the evidence workflow, not by
  the Railway start command; the privilege grid is proven **in test**, not in
  production hosting.
- PGlite remains dev/test evidence, not production hosting evidence.
- The commit exists **locally only**. `origin/reconcile/foundation-first` is
  still `ba5a5422`, so none of this is on GitHub.
- Transient: the sandbox `/tmp` is a ~1 GB RAM-backed tmpfs shared with
  PostgreSQL. Accumulated test databases exhausted it mid-session and caused
  SIGKILL flakes in the PGlite suites; after dropping them the full battery
  passed twice. This is an environment property, not a code defect.

## 11. NOT DEPLOYED

No deployment was performed or attempted. No Railway deployment was triggered,
no production or staging variable was read or written, no production database
was contacted, and no custom domain was touched. Implementation ≠ deployment.

## 12. NOT PUSHED

No push was performed or attempted. The repository has **no remotes
configured**, so a push was impossible by construction. `main` remains at
`99e024c8`, the backup branch is intact, and no remote configuration was
modified.
