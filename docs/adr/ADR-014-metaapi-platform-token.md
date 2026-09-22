# ADR-014 — MetaAPI Platform Token as a Distinct Secret Class

## Status

**Accepted — owner decision D-19 (2026-09-15), via the MetaAPI master execution
directive (Phase 1 — Governance).**

This ADR is **governance-only**: it defines how the MetaAPI **platform** token is
supplied, held and failed-closed. It introduces **no** schema change, **no**
migration, **no** HTTP route and **no** MetaAPI behaviour. It ratifies the
storage decision **D-1** left open by
`docs/reconciliation/METAAPI_OWNER_DECISIONS.md` (OD-M1 clause 4 and §6 D-1).

It exists because the MetaAPI platform token is a **third secret class** with no
governing document. OD-M1 forbids storing it as a user credential, and ADR-016
deliberately does not govern it — its scope is *"secrets that Velora stores on
behalf of a user"*. Without this ADR the token would have no written contract to
violate, which is exactly the gap ADR-016 was created to close for C-22.

**Scope.** The single installation-level credential that authenticates **Velora
itself** to MetaAPI. It does **not** govern user broker credentials (ADR-016),
the credential encryption master key (ADR-016), user passwords (ADR-005),
session/refresh tokens, or webhook signing secrets (ADR-008).

**Numbering note.** `ADR-014` was an unused gap in this repository (VERIFIED:
only `ADR-001…013` and `ADR-016` exist here). A file named
`ADR-014-census-probe-transport.md` exists **only in the legacy repository** and
governs an unrelated concern; it is not superseded, amended or referenced by
this ADR.

## Context

Velora must authenticate to MetaAPI to provision and read trading accounts on
behalf of users. Evidence gathered by the read-only MetaAPI readiness and
security audits at HEAD `7864e9f`:

- **VERIFIED (provider docs):** MetaAPI authenticates callers with an
  `auth-token` HTTP header; the token is obtained from the MetaAPI web
  application. It is an account-level API token, long-lived, with no refresh
  flow.
- **VERIFIED (legacy implementation):** the legacy PHP system reads **one
  platform token** from server configuration
  (`IntegrationConfigResolver::metaApiToken()`), not from any per-user record.
  The **user** separately supplies broker `server` + `mt_login` +
  `investorPassword`, which Velora forwards to MetaAPI at provisioning time.
- **VERIFIED (this repository):** no `METAAPI_*` variable name exists in
  `infra/env/.env.example`; no MetaAPI value is read by any code; there is no
  MetaAPI client and no `metaapi` dependency in `package-lock.json`.
- **VERIFIED (this repository):** a directly applicable precedent already
  exists for a platform-level third-party token —
  `apps/api/src/mail/resendMailProvider.ts` consumes `RESEND_API_KEY` from the
  environment, exposes a `configured` boolean that never reveals the key, uses
  an injectable `HttpTransport` so tests need no network, fails closed with
  `{ ok: false, reason: "not-configured" }`, and never surfaces provider error
  bodies (`reason: "rejected"`).
- **VERIFIED (this repository):** a fail-closed configuration idiom already
  exists — `apps/api/src/credentials/credentialConfig.ts` (`CR-001`…`CR-003`)
  and `packages/contracts/src/securityConfig.ts` (`SC-001`…`SC-009`) are pure
  functions over an env record returning **coded findings whose messages never
  embed the configured value**.
- **VERIFIED (this repository):** there is currently **no conflation** of secret
  classes. `CREDENTIAL_MASTER_KEY` appears outside `apps/api/src/credentials/`
  only inside two explanatory comments.

The risk this ADR addresses is therefore not a present defect but a foreseeable
one: without a written contract, the cheapest implementation path would be to
reuse an existing secret or an existing table, and either choice would silently
merge two secret classes that must stay apart.

## Decision

### 1. Three distinct secret classes

| Secret | Purpose | Scope | Supply | Governed by |
|---|---|---|---|---|
| `CREDENTIAL_MASTER_KEY` | Encrypts/decrypts the credential store **at rest** | Installation | Environment | **ADR-016** |
| **MetaAPI platform token** | Authenticates **Velora** to MetaAPI | Installation | Environment | **This ADR** |
| User broker credential | Authenticates/provisions the **user's** trading account through MetaAPI | Individual user | User-supplied over HTTPS, encrypted at rest | **ADR-016** |

These are **not interchangeable**. Compromise of one does not imply compromise
of the others, and each has a different owner, lifecycle and blast radius.

### 2. External supply only

The platform token is supplied **externally through the environment** as
`METAAPI_PLATFORM_TOKEN`. The non-secret endpoint base is supplied as
`METAAPI_BASE_URL`.

**Mandatory properties** (deliberately the same *properties* ADR-016 requires of
the master key, for the same reasons):

1. **Externally supplied.** The application consumes it; it never mints it.
2. **Never auto-generated.** There is no generated fallback and no default value.
3. **Never committed.** `infra/env/.env.example` carries the variable **names
   with empty values** only.
4. **Never logged.** Startup may log a **configured boolean or provider name
   only** — never the value, never a prefix, suffix, length or hash of it.
5. **Fail closed** when missing, empty or malformed — see *Failure Semantics*.

### 3. Prohibitions (binding)

1. **MUST NOT** be stored in `user_credentials`, in any form, encrypted or not.
2. **MUST NOT** be represented by a synthetic user, sentinel `user_id`, reserved
   provider value, or any other record that makes a platform secret look
   user-scoped.
3. **MUST NOT** be reused as, or derived from, `CREDENTIAL_MASTER_KEY` — and the
   master key MUST NOT be derived from it. No shared key material, no KDF
   relationship, no "one env var for both".
4. **MUST NOT** be returned in any HTTP response, audit record, job payload,
   queue message, DLQ entry, log line, error message, or exception.
5. **MUST NOT** be committed to the repository in any file, including tests and
   fixtures.

### 4. Configuration resolver

Resolution is performed by a dedicated pure function in the API application,
mirroring `credentialConfig.ts`. It returns **coded findings**, never the value:

| Code | Condition | Severity |
|---|---|---|
| `MA-001` | `METAAPI_PLATFORM_TOKEN` missing or empty | capability unavailable |
| `MA-002` | `METAAPI_PLATFORM_TOKEN` malformed (e.g. contains whitespace/control characters) | capability unavailable |
| `MA-003` | `METAAPI_BASE_URL` present but not an absolute `https://` URL | capability unavailable |

Finding **messages are fixed text** and MUST NOT embed the configured value.
The resolver performs **no I/O** and holds **no default token**.

### 5. Failure semantics — fail closed, capability-absent

When the token does not resolve, the MetaAPI capability is **absent**: it is not
constructed, and any dependent surface reports "not configured" rather than
degrading to an unauthenticated or partially configured client.

**The API process MUST NOT crash at boot because the MetaAPI token is absent.**
This is deliberate and follows existing repository behaviour: a missing
`RESEND_API_KEY` degrades to `LogMailProvider`, and a missing
`CREDENTIAL_MASTER_KEY` simply omits the credential capability
(`apps/api/src/server-main.ts`). MetaAPI is an **integration**, not a core boot
requirement; hard-exiting on its absence would be a behavioural regression and
would let a third-party configuration gap take down authentication and trades.

`METAAPI_BASE_URL` has **no default in production configuration**. If a default
is used anywhere it must be an explicit, reviewed constant in code — never a
silently guessed host.

### 6. Readiness

MetaAPI configuration **MUST NOT** be added to `/ready`. `/ready` reports
whether this instance can serve traffic; making a third-party integration a
readiness condition would allow an external dependency to remove the API from
rotation. A dedicated integration-health surface may be introduced later under
its own decision.

### 7. Rotation — operationally independent of ADR-016

Rotating the platform token is **"provision the new value and restart"**: it
protects no data at rest, so there is no re-encryption, no dual-key window and
no per-row version. This is **materially different** from ADR-016 key rotation,
which is deferred precisely because a master-key rotation requires a dual-key
decrypt window the runtime does not provide.

**Do not infer that MetaAPI token rotation is blocked by ADR-016's deferred
rotation.** They are unrelated operations on unrelated secrets.

### 8. No mandatory external secret manager

This ADR **does not** mandate a specific secret manager, exactly as ADR-016 does
not. The requirement is the *properties* in §2; the mechanism is an operational
choice, constrained by ADR-010's standing rule that secrets never enter the
repository. Adopting a secret manager later satisfies this ADR without amending
it, provided the properties hold.

### 9. Testability without real secrets

Any MetaAPI client governed by this ADR MUST accept an **injectable HTTP
transport**, following `ResendMailProvider`'s `HttpTransport` precedent, so the
full unit and contract suites run with a dummy token and **no network access**.
No test may contain a real token, and no test may require one to pass.

### 10. Provider error handling

Provider response bodies can echo request material. They MUST NOT be logged or
surfaced; failures are reported as **classified codes**. This restates the
behaviour already implemented for Resend and makes it binding for MetaAPI.

## Consequences

**Accepted:**

- The platform token's availability is an operational responsibility; if it is
  absent, MetaAPI features are unavailable **and that is the correct, loud
  outcome** rather than a silent degraded mode.
- Two installation-level secrets must now be provisioned per environment
  (`CREDENTIAL_MASTER_KEY`, `METAAPI_PLATFORM_TOKEN`). The operational cost of
  keeping them separate is accepted in exchange for independent blast radius.

**Negative:**

- Operators must understand that these two variables are not interchangeable.
  §1 exists to make that explicit in writing rather than in tribal knowledge.

## Non-Goals

This ADR does **not** authorize or describe as existing:

- a MetaAPI client, provider abstraction or SDK adoption
- MetaAPI connection, provisioning, account discovery or trade sync
- webhook ingestion (ADR-008)
- any migration, table, column or privilege change
- any HTTP route
- a credential reveal capability of any kind
- a specific cloud secret manager
- any change to ADR-016's scope, model or key management

## Security Impact

Introduces the governance for the **first credential that authenticates Velora
itself** to an external financial-data provider. The dominant risk is
conflation: reusing the master key, or storing the platform token in the
user-scoped table, would convert an installation-level compromise into a
user-credential compromise. §3 prohibits both explicitly.

This ADR does **not** weaken ADR-016: user broker credentials keep the AES-256-GCM
envelope, ownership remains the only authorization rule for user credential
plaintext, and no reveal path is created.

## Verification / Implementation Mapping

Status at ratification, verified at HEAD `7864e9f25f0b1db9ef0a6eafddaed85fa1d47745`:

| Governance clause | Implementation | Status |
|---|---|---|
| Three distinct secret classes (§1) | — | **GOVERNANCE ONLY** |
| `METAAPI_PLATFORM_TOKEN` / `METAAPI_BASE_URL` names (§2) | `infra/env/.env.example` | **NOT IMPLEMENTED** (Phase 3) |
| `MA-001`…`MA-003` resolver (§4) | `apps/api/src/metaapi/metaApiConfig.ts` | **NOT IMPLEMENTED** (Phase 3) |
| Fail-closed, capability-absent (§5) | `apps/api/src/server-main.ts` | **NOT IMPLEMENTED** (Phase 3) |
| Injectable transport (§9) | — | **NOT IMPLEMENTED** (Phase 5) |
| Classified provider errors (§10) | precedent: `apps/api/src/mail/resendMailProvider.ts` | **PRECEDENT EXISTS** |
| No storage in `user_credentials` (§3) | `db/migrations/0010_user_credentials.sql` unchanged | **HOLDS** (no change made) |

## Audit trail

- **Owner decision:** D-19 (2026-09-15), MetaAPI master execution directive,
  Phase 1 — Governance.
- **Ratifies:** D-1 in `docs/reconciliation/METAAPI_OWNER_DECISIONS.md` §6, and
  implements OD-M1 clauses 3–5 at the governance level.
- **Evidence:** MetaAPI Integration Readiness Audit (2026-09-15) and MetaAPI
  Security/Design Audit (2026-09-15), both read-only at HEAD `7864e9f`.
- **Supersedes:** nothing. **Amends:** nothing. ADR-016 is unchanged.
