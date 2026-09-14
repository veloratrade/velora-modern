# ADR-016 — Credential Encryption and Key Management

## Status

**Accepted — owner decision D-18 (2026-09-15), via post-audit governance-alignment directive.**

This ADR is **governance-only**: it ratifies the security model already
implemented by capability C-22 (commit `a361847`, migration `0010`) and binds
all future work on stored third-party credentials. It introduces **no** schema
change, **no** production code change, and **no** new capability.

It exists because C-22 shipped a complete cryptographic design with **no ADR
governing it** — a gap recorded in the C-22 implementation report and confirmed
by the Program Baseline Audit. Before that gap is closed, any subsequent change
to credential handling would have had no written contract to violate.

Scope: secrets that Velora stores **on behalf of a user** to authenticate to a
third-party system. It does **not** govern user passwords (ADR-005), session or
refresh tokens, email verification or reset tokens, or webhook signature
secrets.

## Context

Velora must hold broker/integration credentials so that future server-side
capabilities (C-27 MetaAPI connect, C-29 trade sync) can authenticate as the
user. Such a secret is **recoverable material, not a verifier**: unlike a
password it cannot be one-way hashed, because the integration needs the
original value. That single fact drives every decision below — the protection
available is encryption at rest plus a hard authorization boundary, not hashing.

Verified state of the repository at the time of writing (HEAD
`4a14fb24ac2b36e2c48bd77495f15f335dda6be7`):

- `user_credentials` (migration `0010`) stores an AES-256-GCM envelope and
  **no plaintext column** — verified: the migration deliberately carries no
  prefix, suffix or length-derived column either.
- No ADR governs credential encryption. ADR-010 mentions encryption only for
  **backups** ("PITR + nightly dumps → encrypted, offsite object storage") and
  otherwise covers repository posture, delivery and DB role separation.
- ADR-014 and ADR-015 **do not exist in this repository** — the numbering has a
  gap. `ADR-014-census-probe-transport.md` exists only in the *legacy*
  repository and governs an unrelated concern.
- The credential capability has **no HTTP surface**: `credentialStore` is
  constructed in `server-main.ts` and deliberately never passed to `createApp`.

## Decision

Stored third-party credentials are protected by **authenticated encryption at
rest under an externally supplied master key**, combined with **ownership-scoped
access** as the only authorization rule. Both properties are mandatory; neither
substitutes for the other.

Encryption protects the data **at rest** (a database dump, a backup, a stolen
volume). It does **not** protect against an authorized caller, which is why the
isolation rule in *Credential Isolation* is a peer requirement rather than a
nice-to-have.

## Cryptographic Contract

**Algorithm — AES-256-GCM. Canonical and sole.**

| Parameter | Value | Rationale |
|---|---|---|
| Key size | **32 bytes (256-bit)** | AES-256 |
| Nonce/IV | **12 bytes**, fresh CSPRNG per operation | The GCM-native size; avoids the extra GHASH derivation step other lengths require |
| Auth tag | **16 bytes**, full length | Truncation weakens forgery resistance |
| Mode | AEAD (authenticated encryption) | Confidentiality **and** integrity in one primitive |

**No fallback cipher is permitted.** There is no negotiation, no "legacy
algorithm" branch, and no downgrade path. Introducing another algorithm
requires a superseding ADR *and* a new `enc_version`.

**Nonce discipline.** A fresh nonce is generated on every encryption, so
encrypting identical plaintext twice yields different ciphertext. Nonce reuse
under one key is catastrophic for GCM — it leaks the XOR of plaintexts and can
enable tag forgery — so this is additionally enforced at the database layer by
`UNIQUE (key_version, iv)`, globally across all users, not merely per account.
Defence in depth: the application must not reuse a nonce, and the database will
not let it.

### Envelope metadata

A credential record is a **cryptographic envelope**. These fields are part of
the security contract, not incidental bookkeeping:

| Field | Meaning |
|---|---|
| `enc_version` | Envelope format version (currently `1`) |
| `key_version` | Which master key generation encrypted this row |
| `algorithm` | Pinned to `aes-256-gcm` |
| `iv` | The 12-byte nonce for this row |
| `auth_tag` | The 16-byte GCM tag |
| `secret_ciphertext` | The ciphertext itself |

**These values must never be silently reinterpreted.** They may not be
rewritten, defaulted, back-filled, inferred, or "repaired" by application code
or by an operator convenience script. A row whose metadata does not match its
ciphertext is a **failed decryption**, never a best-effort recovery.

### AAD

Additional Authenticated Data is constructed as:

```
v<enc_version>:k<key_version>:aes-256-gcm
```

AAD is **authenticated but not encrypted**: it is not secret and is not
recoverable from the ciphertext. Its purpose is *binding* — the envelope
metadata is cryptographically tied to the ciphertext, so editing
`enc_version`, `key_version` or `algorithm` in the database causes decryption
to **fail** rather than silently produce a different interpretation of the same
bytes.

**The AAD format is part of the on-disk contract.** Changing it invalidates
every existing row. Any change requires an explicit compatibility decision in a
superseding ADR, carried by an `enc_version` increment — never an in-place
format edit.

## Key Management

The master key is supplied **externally**, through the environment, as
`CREDENTIAL_MASTER_KEY` (base64, decoding to exactly 32 bytes), with an optional
`CREDENTIAL_MASTER_KEY_VERSION` (integer ≥ 1, default `1`).

**Mandatory properties:**

1. **Externally supplied.** The application consumes it; it never mints it.
2. **Never auto-generated.** A generated key is worse than no key: it would
   appear to work while making every existing row permanently undecryptable.
3. **Never committed.** `infra/env/.env.example` carries the variable **names
   with empty values** only.
4. **Never logged.** Startup logs the **key version only**. `MasterKey`
   overrides `toJSON()` → `"[redacted]"` and `toString()` →
   `"[redacted MasterKey]"`, so accidental interpolation or structured-logging
   of the object cannot leak material.
5. **Fail closed** when missing, empty, malformed, wrongly sized, or
   all-zero — see *Failure Semantics*.

**Deployment-provider neutral by design.** This ADR deliberately does **not**
mandate a specific secret manager. The repository has no such dependency today,
and inventing one here would be an infrastructure decision disguised as a
security decision. The requirement is the *properties* above; the mechanism is
an operational choice, constrained by ADR-010's standing rule that secrets never
enter the repository.

**Custody expectations (governed, operational):** the key is provisioned per
environment; staging and production must not share a key; access to it is
limited to the platform secret store and the operators who administer it.

### Key versioning

`key_version` is persisted **per row** and bound into the AAD.

- **Current version: `1`.**
- The runtime holds **exactly one active key**. A row whose `key_version` does
  not match the active key's version is **rejected** — `decryptCredential`
  checks this before attempting any cryptographic operation.
- An **unknown or mismatched key version fails closed**: uniform decryption
  failure. The system never searches for another key, never guesses, and never
  treats the row as corrupt-and-discardable.

This is the correct behaviour for a single-key deployment and is the honest
reason operational rotation is deferred: a rotation requires a **dual-key
decrypt window**, which the current single-active-key runtime does not provide.

## Credential Isolation

**Ownership is the only authorization rule for credential plaintext.**

Every `CredentialStore` method takes the owning `userId` and scopes on it.
There is deliberately **no by-id-without-owner accessor** — no `findByIdAsAdmin`,
`revealAny`, `listAll`, `adminReveal` or `findAny`. The protection is
*structural*, not a policy check that could be forgotten at a call site: the
operation an administrator would need does not exist in the interface.

### Application authority does not imply secret disclosure authority

This is the governing principle, and it is deliberately narrower than RBAC.

The **System Owner** holds the highest installation authority and satisfies
every permission in the RBAC model. **That authority does not extend to reading
another user's credential plaintext.** Likewise `admin` and `super_admin` may
manage accounts — role, status, sessions — according to RBAC, and **none of that
becomes a credential extraction capability.**

The distinction is between *managing an account* and *impersonating its owner to
a third party*. A broker credential is the latter: disclosing it would let the
holder act as that user against an external financial system, outside anything
Velora can audit or reverse.

Any future capability that needs a credential must consume it **server-side, on
behalf of the owning user**, and must not introduce an operator-facing reveal
path. A support or debugging workflow that requires plaintext is **not**
approved by this ADR and requires a superseding decision.

At the database layer the same boundary is enforced independently
(`db/roles.sql`): `velora_worker` and `velora_readonly` hold **no privileges at
all** on `user_credentials`; only `app_readwrite` may read or write it. This is
operator-applied, so it holds wherever the file has been applied.

## Lifecycle

Conceptual lifecycle. **No endpoint, UI, or integration is authorized by this
ADR.**

```
CREATE      accept plaintext from the owning user
ENCRYPT     AES-256-GCM, fresh nonce, AAD-bound
STORE       envelope only; never the plaintext
RETRIEVE    owner-scoped; metadata-only reads by default
DECRYPT     in memory, only for an authorized server-side integration use
NEVER LOG   plaintext must not reach logs, errors, audit payloads or telemetry
REVOKE      hard delete of the row (current semantics)
```

**Current revocation = hard delete.** There is no soft-delete or tombstone, so a
revoked credential leaves no trace — which also means no record that revocation
occurred. That is an accepted consequence today and a direct input to the
deferred audit-event work.

`ON DELETE RESTRICT` on `user_credentials.user_id` prevents deleting a user who
still holds stored credentials, so secret material cannot be orphaned by a
cascade.

## Failure Semantics

**Cryptographic and configuration errors are security failures, not
recoverable conditions. The system FAILS CLOSED.**

| Condition | Behaviour |
|---|---|
| `CREDENTIAL_MASTER_KEY` missing/empty | `CR-001` — capability **absent** |
| Malformed base64 / wrong length / all-zero | `CR-002` — capability **absent** |
| Invalid `CREDENTIAL_MASTER_KEY_VERSION` | `CR-003` — capability **absent** |
| Unsupported `enc_version` | Uniform decryption failure |
| Mismatched `key_version` | Uniform decryption failure |
| Wrong key / tag mismatch / tampered ciphertext | Uniform decryption failure |

**Absolute prohibitions:**

- **Do not** silently try another key.
- **Do not** silently generate a replacement key.
- **Do not** fall back to plaintext storage.
- **Do not** fall back to another algorithm.
- **Do not** degrade the capability into a partially-working state.

When the key is unusable the credential capability is **absent** rather than
degraded — a misconfigured deployment cannot silently store secrets
unencrypted.

**No decryption oracle.** All decryption failures raise one uniform message
("Credential could not be decrypted.") with **no cause attached**, so wrong-key,
tampered-ciphertext and wrong-metadata are indistinguishable to a caller.
Error messages, logs and telemetry must never echo ciphertext, key material,
nonces, or the configured value of any credential variable.

## Rotation Policy

**Key rotation is supported by the data model but operational rotation is
DEFERRED.**

The data model is ready: `key_version` is stored per row and bound into the AAD,
so rows encrypted under different generations are distinguishable and
non-interchangeable. **No rotation tooling exists**, and the runtime holds a
single active key, so rotating today would strand every existing row as
undecryptable.

Before the **first** production rotation, a separate implementation — governed
by its own decision — must define all of:

1. new key introduction
2. a **dual-key decrypt window** (old key readable while the new key writes)
3. the re-encryption process
4. atomicity and idempotency (safely resumable, no partial/mixed state)
5. failure recovery
6. old-key retirement
7. rollback
8. verification that every row was re-encrypted
9. audit events for the rotation itself

**None of these are implemented, and none are authorized by this ADR.**

## Provider Boundary

Current provider scope: **`METAAPI` only**, enforced by a database CHECK.

Adding a provider is a deliberate, migration-bearing act — not a configuration
toggle. **Provider-specific credential formats must not bypass the canonical
encryption boundary**: whatever the shape of a provider's secret (token, key
pair, structured blob), it is serialized and passed through the *same*
AES-256-GCM envelope. No provider gets a "simpler" path, a side table, a
plaintext field, or its own cipher.

`UNIQUE (user_id, provider)` makes replacing a credential an explicit operation
rather than an accidental accumulation of stale secrets.

## Non-Goals

This ADR does **not** authorize or describe as existing:

- credential HTTP routes or any client-facing API
- a credential management UI
- MetaAPI connection logic (C-27) or trade sync (C-29)
- provider routing or a multi-provider abstraction (C-19/C-20)
- operational key rotation tooling
- credential audit events (see *Future Work*)
- a specific cloud secret manager
- any administrative or support plaintext-reveal capability

## Consequences

**Accepted:**

- Loss of the master key means **permanent loss of all stored credentials**.
  This is the intended trade-off: there is no recovery backdoor, because a
  recovery backdoor is an attack path.
- The credential capability is **absent** when misconfigured. Operators see a
  missing capability rather than a silent plaintext fallback.
- Support cannot inspect a user's credential. Diagnosis must rely on metadata
  and integration-level errors.
- Credential lifecycle is currently **unauditable** (no events, and revocation
  is a hard delete).
- The single-active-key model means rotation is a genuine project, not a
  config change.

**Gained:** ciphertext-only at rest, metadata tamper-evidence via AAD binding,
no plaintext in logs or errors, structural (not procedural) protection against
administrative disclosure, and database-layer least privilege.

## Future Work

Each item requires its own decision; **none is approved here**:

1. **Credential audit events** — blocked today because migration `0009`
   constrains `audit_log.action` to exactly `OWNERSHIP_CLAIMED`,
   `USER_ROLE_CHANGED`, `USER_STATUS_CHANGED`. Recording credential
   create/reveal/revoke requires widening that frozen CHECK and the
   `AuditAction` union. Events must describe the **lifecycle operation only** —
   never the secret value, nonce, tag or ciphertext.
2. **Rotation implementation** — the nine requirements above.
3. **Additional providers** — migration + CHECK widening, same envelope.
4. **Authorized server-side consumption** (C-27/C-29) — must preserve the
   isolation boundary and the no-plaintext-logging rule.
5. **Revocation semantics** — whether hard delete remains correct once audit
   events exist.

## Verification / Implementation Mapping

Every file below was verified to exist at HEAD
`4a14fb24ac2b36e2c48bd77495f15f335dda6be7`.

| Governance clause | Implementation | Status |
|---|---|---|
| AES-256-GCM, 12-byte nonce, 16-byte tag, AAD binding | `apps/api/src/credentials/credentialCrypto.ts` | **IMPLEMENTED** |
| Key validation, `CR-001`/`CR-002`/`CR-003`, no auto-generation | `apps/api/src/credentials/credentialConfig.ts` | **IMPLEMENTED** |
| Key redaction (`toJSON`/`toString`) | `apps/api/src/credentials/credentialCrypto.ts` (`MasterKey`) | **IMPLEMENTED** |
| Ownership-only access; no admin reveal method | `apps/api/src/credentials/credentialStore.ts` (port) | **IMPLEMENTED** |
| Envelope persistence, owner-scoped SQL, hard-delete revocation | `apps/api/src/credentials/pgCredentialStore.ts` | **IMPLEMENTED** |
| Same contract for tests, real encryption in memory | `apps/api/src/credentials/memoryCredentialStore.ts` | **IMPLEMENTED** |
| Envelope schema, CHECKs, nonce uniqueness, `ON DELETE RESTRICT` | `db/migrations/0010_user_credentials.sql` | **IMPLEMENTED** |
| DB least privilege (worker/readonly denied) | `db/roles.sql` | **IMPLEMENTED** (operator-applied) |
| Fail-closed startup; **no HTTP surface** | `apps/api/src/server-main.ts` | **IMPLEMENTED** |
| Variable **names only**, empty values | `infra/env/.env.example` | **IMPLEMENTED** |
| Unit coverage (19 tests) | `apps/api/src/credentials/credentialStore.test.ts` | **IMPLEMENTED** |
| Real-PostgreSQL coverage (8 tests) | `db/tests/credentialStore.pg.test.ts` | **IMPLEMENTED** |
| Schema-constraint regression (2 cases) | `db/tests/migrations.test.ts` | **IMPLEMENTED** |
| Credential audit events | — | **NOT IMPLEMENTED** (blocked by `0009` CHECK) |
| Key rotation tooling | — | **NOT IMPLEMENTED / DEFERRED** |
| Dual-key decrypt window | — | **NOT IMPLEMENTED / DEFERRED** |
| Additional providers | — | **NOT IMPLEMENTED** (out of scope) |
| Authorized server-side consumption (C-27/C-29) | — | **NOT IMPLEMENTED** (gated) |

## Audit trail

- Capability C-22 implemented in commit `a361847`, migration `0010`.
- Governance gap identified in the C-22 implementation report and confirmed by
  the Program Baseline Audit (gate A).
- This ADR ratifies the shipped design. It changes no code and no schema.
- Supersedes nothing. Superseded by nothing.
