# VELORA MODERN — MetaAPI Owner Decisions (OD-M1 … OD-M4 + TZ-M1, D-1, D-2, D-4)

## 1. Status

**Status:** OWNER-APPROVED 2026-09-15 (explicit owner directive, this session).
**Amended 2026-09-15 — D-4 RATIFIED (see §2B).** Governance-only: ratifies provider PnL
authority for imported trades on the existing canonical `net_pnl` field. **No second PnL column
is authorized**, no code, no schema, no migration, no API change.
**Amended 2026-09-15 — D-2 RATIFIED (see §2A).** Governance-only amendment: records the owner's
acceptance of **Boundary-Scoped Option B** for credential consumption. It changes no code, no
schema, no migration, no privilege and no ADR. OD-M1, OD-M3, OD-M4 and TZ-M1 are **untouched**.
**Mode:** GOVERNANCE ONLY — decision recording. No implementation.
**Branch:** `reconcile/foundation-first` · **Recorded at HEAD:** `7864e9f25f0b1db9ef0a6eafddaed85fa1d47745`
**Source evidence:** *MetaAPI Integration Readiness Audit* (read-only, 2026-09-15), which
inspected this repository at the same HEAD and the legacy reference tree at `e42379f`.

**Authorized scope of the owner directive:** recording the decisions below **only**.
This record creates no schema, no code, no route, no migration, and no MetaAPI client.
It contacted no MetaAPI, Railway or production system.

**Numbering.** This record uses the distinct `OD-M*` namespace. It does **not** extend,
reopen or renumber `OD-1 … OD-10` in `RECONCILIATION_DECISIONS.md`, which remain frozen.
**No OD-4 is created or redefined here** (see §5).

**Relationship to ADRs.** This is a decision record, not an ADR. Per AGENTS.md rule 11 an
affected decision requires the ADR to be updated *in the same change as the implementation*.
No ADR is amended by this document; §8 lists the amendments that must land **before** the
corresponding implementation phase.

---

## 2. Owner decisions

### OD-M1 — Credential model: **OPTION C — BOTH CREDENTIAL CLASSES EXIST**

1. Velora has **ONE installation/platform-level MetaAPI token**.
2. Each user has their **own broker credentials**: broker/server, MT login,
   investor password, and platform (MT4 or MT5).
3. The platform MetaAPI token is **NOT** a user credential.
4. The platform token **MUST NOT** be stored as a fake user credential (no synthetic
   user row, no sentinel `user_id`, no reserved provider value standing in for "platform").
5. `user_credentials` **remains strictly user-scoped**.
6. User broker credentials **remain protected by the existing AES-256-GCM envelope**
   (ADR-016) — unchanged algorithm, unchanged AAD binding, unchanged key management.
7. **No plaintext secret is exposed over HTTP.**
8. **No generic credential reveal endpoint is created.**

**Explicitly NOT decided here:** where and how the platform token is stored. See §6 (D-1).

### OD-M2 — Execution boundary: **METAAPI SYNC RUNS IN THE WORKER**

Rationale accepted as stated by the owner: historical and incremental sync are
asynchronous; retry/DLQ semantics belong to the worker; API request lifetime must not
contain long-running sync; pg-boss already exists; and the worker must obtain credentials
through an **explicit internal credential-consumption boundary**.

Binding constraints attached to this decision:

- **Broad `SELECT` on `user_credentials` for the worker is NOT granted by this decision.**
- The narrowest safe worker-side consumption mechanism is a **separate design decision**
  (§6, D-2), to be chosen from: **(A)** shared package carrying the credential-consumer
  contract, **(B)** dedicated server-side credential broker, **(C)** narrowly scoped
  database privilege, **(D)** another architecture. **Not chosen silently.**
- **The worker MUST NEVER receive plaintext credentials in job payloads.**

### OD-M3 — Trade ledger actor: **`TRADE_IMPORTED` MUST ALLOW ACTOR `sync`**

- MetaAPI-originated trades are **imports**, not manual creations.
- `TRADE_IMPORTED` must **not** be replaced by `TRADE_CREATED` merely to avoid changing
  the actor matrix.
- Semantics remain explicit: **`TRADE_IMPORTED` = broker/provider-originated trade
  imported by sync.**
- `FINANCIAL_CORRECTED` remains available for subsequent provider-driven financial
  corrections under the existing ownership matrix (it already permits `sync`).

**Current implementation state (VERIFIED by execution during the readiness audit):**
`packages/domain/src/tradeLedger.ts` declares `TRADE_IMPORTED: ["system"]`;
`assertOwnership("TRADE_IMPORTED", "sync")` throws `OwnershipPolicyError`.
**Domain code is NOT modified by this record.**

### OD-M4 — PnL authority: **PROVIDER-REPORTED PROFIT IS AUTHORITATIVE**

- For MetaAPI-imported trades, the **provider-reported profit is the authoritative
  net-PnL input**.
- Modern's calculated PnL **may** be retained as a diagnostic/reconciliation value **if**
  a future schema/design supports it, but it **must not silently replace** the
  provider-reported value.
- **No second PnL column is added now.**
- Divergence causes accepted as rationale: swaps, commissions, currency conversions,
  partial fills, broker-specific calculation, contract-size assumptions.

**Current implementation state (VERIFIED):** `packages/domain/src/pnl.ts` computes
`gross = (exit − entry) × volume × contractSize`, `net = gross − commission − swap`, and
derives `rMultiple` from a stop-loss. This formula is **correct for manual trades and is
not changed by this decision.** OD-M4 governs the **import mapping only**.

### TZ-M1 — MetaAPI timestamp semantics (recorded, not invented)

The readiness audit established that the timezone precedence chain previously attributed
to "OD-4" **does not exist in this repository**: `OD-4` is *"Backup Bootstrap Exception —
NOT APPROVED"* and `OD-5` is timestamp precision. **That OD-4 is not invented or
redefined.** The following verified MetaAPI semantics are recorded instead:

1. MetaAPI's **offset-explicit `time`** (trailing `Z` or ±HH:MM) is parsed
   **deterministically to UTC**.
2. **`brokerTime` is naive and MUST NOT be interpreted using a guessed timezone.**
3. `brokerTime` **may be retained as raw evidence**.
4. **No IANA timezone is inferred** from `brokerTime`.
5. **Manual-trade timezone behaviour from ADR-004 remains unchanged.**
6. The durable storage location for naive `brokerTime` evidence is a **future schema
   decision** (§6, D-5).

---

## 2A. Owner decision — D-2 (ratified 2026-09-15)

### D-2 — Worker credential-consumption mechanism: **BOUNDARY-SCOPED OPTION B**

**STATUS: ACCEPTED.**

The mechanism question posed by OD-M2 (*options A / B / C / D, "not chosen silently"*) is hereby
decided. The owner adopts **Boundary-Scoped Option B**: credential consumption is confined to
API-hosted provisioning, and worker-hosted synchronization is **credential-free**.

**The operative distinction — these are different operations with different security profiles:**

| | **PROVISIONING** | **SYNCHRONIZATION** |
|---|---|---|
| User broker credential | **REQUIRED** | **NOT REQUIRED** |
| Process | **API** | **Worker** |
| Lifetime | Short-lived, user-initiated | Long-running, retryable |
| Provider authentication | Platform token | Platform token |
| Non-secret input | — | `metaapi_account_id` |

**Binding terms of the decision:**

1. User broker credentials are consumed **only** during account provisioning.
2. Provisioning is an **API-hosted, short-lived, user-initiated** operation.
3. The **API is the only process** that currently requires `CREDENTIAL_MASTER_KEY` for user
   credential consumption.
4. The worker **MUST NOT** receive: broker username/password · investor password · plaintext user
   credentials · **encrypted user credential ciphertext** · `CREDENTIAL_MASTER_KEY`.
5. Historical and incremental MetaAPI synchronization runs **entirely in the worker**, consistent
   with OD-M2.
6. MetaAPI sync **does not consume** the user's broker password.
7. Sync authenticates provider requests using the installation-level `METAAPI_PLATFORM_TOKEN`
   plus the **non-secret** MetaAPI account identifier.
8. Worker jobs carry **identifiers and non-secret synchronization metadata only**.
9. Worker job payloads **MUST NOT** contain user credentials or any other secret.
10. The worker's existing prohibition on `user_credentials` access **remains**.
11. The worker's existing prohibition on `audit_log` access **remains**.
12. **`db/roles.sql` MUST NOT be weakened or expanded as a consequence of D-2.**
13. **No credential broker is required** for current MetaAPI synchronization.
14. **No API-hosted long-running MetaAPI synchronization is authorized.** Provider sync I/O
    remains in the worker.

### Security boundary attached to D-2

The worker **may** receive `METAAPI_PLATFORM_TOKEN` as an **environment-supplied platform-level
secret** when the MetaAPI worker implementation is eventually built.

- This does **NOT** constitute access to `user_credentials`.
- The platform token is a **distinct secret class**, governed separately from
  `CREDENTIAL_MASTER_KEY` (ADR-014 / D-19).
- The worker **must never** receive `CREDENTIAL_MASTER_KEY`.
- The worker **must never** receive user broker credentials.

### Consequences (each verified against the tree, not assumed)

| Consequence | State |
|---|---|
| Migration required | **NONE** |
| `db/roles.sql` change | **NONE — unchanged.** `REVOKE ALL ON user_credentials FROM velora_worker` stands |
| Credential broker | **NOT REQUIRED** for current sync |
| **ADR-007 amendment A-4** | **NOT REQUIRED** — D-2 alters no worker DB role and no least-privilege posture |
| ADR-016 | **UNCHANGED** — server-side consumption stays inside the API, preserving the isolation boundary and the no-plaintext-logging rule (Future Work 4 is *not* triggered) |
| ADR-014 | **UNCHANGED and governing** for the platform token |
| Blocker **B2** | **DISSOLVED** rather than solved — the worker needs no credential path at all |

### Evidence basis, and the exact limit of that evidence

Established by the read-only *D-2 Architectural Clarification Audit* (2026-09-15) from the
**legacy** implementation:

- MetaAPI provider requests authenticate with the platform-level `auth-token` header.
- Historical sync requests use `metaapi_account_id` and **do not supply** the user's broker
  password.
- `investorPassword` is read **only** in the provisioning/connect path.
- The stored encrypted broker credential is **not decrypted** by the legacy MetaAPI sync path.
- Legacy sync runs as a **worker** operation using account identifiers.
- Therefore the suspected conflict between OD-M2 and this architecture **is not present** for
  current historical and incremental synchronization.

> **LIMIT OF EVIDENCE — BINDING.** This is proven for the **legacy implementation only**. It does
> **NOT** establish that every possible future MetaAPI operation is credential-free. If an
> operation is discovered that is **both** long-running / worker-owned **AND** requires user
> broker credentials, that operation **requires a new explicit architectural decision**.
> **This decision MUST NOT be silently extended to such an operation.**

---

## 2B. Owner decision — D-4 (ratified 2026-09-15)

### D-4 — PnL authority for imported trades: **PROVIDER-REPORTED PROFIT IS AUTHORITATIVE, ON THE EXISTING CANONICAL FIELD**

**STATUS: ACCEPTED.**

OD-M4 established the *principle* (provider profit is authoritative). D-4 decides the
*representation*: it stays on the field that already exists. **No second PnL column is created.**

**Binding terms:**

1. For MetaAPI-imported trades, **the provider-reported profit is authoritative**.
2. The canonical persisted domain value remains the existing field **`net_pnl`**
   (`trades.net_pnl`, `NUMERIC(20,2)`, migration 0001 — VERIFIED present).
3. API serialization remains **`profitLoss`**. VERIFIED chain, unchanged by this decision:
   `trades.net_pnl` → `TradeRecord.netPnl` → `profitLoss`
   (`pgTradeStore.ts:101`, `tradeService.ts:652`).
4. **MUST NOT** add a second persisted PnL column — specifically **not** `provider_profit`,
   `calculated_profit`, or `broker_profit`. VERIFIED absent from all 12 migrations.
5. **MUST NOT** persist a local-vs-provider PnL comparison at this stage.
6. If a future implementation computes local PnL, it is **diagnostic / reconciliation only**.
7. A local calculation **MUST NOT overwrite or replace** the provider-reported authoritative
   value.
8. For an imported trade, **the provider-reported profit populates the canonical `net_pnl`**.
9. Any future reconciliation mechanism that requires **persisted** diagnostic values is a
   **separate Owner Decision**.
10. **Existing manual-trade PnL behaviour is unchanged.** `computePnl`
    (`packages/domain/src/pnl.ts`) continues to govern manual trades exactly as today.

### Rationale

MetaAPI reports the provider-side financial result — profit, commission and swap — for a trade
it executed. Modern's generic formula diverges from it on swaps, commissions, currency
conversions, partial fills, broker-specific calculations and contract-size assumptions, so for
an imported trade the provider value is the one that matches the user's account statement.

Persisting a second PnL value **now** would create two competing durable representations with
**no approved reconciliation model** — which value wins on read, which is exported, which is
reported. That ambiguity is a correctness risk, and the cheapest time to avoid it is before the
column exists. One canonical field also preserves API compatibility and requires no migration.

### Consequences

| Consequence | State |
|---|---|
| Migration required | **NONE** |
| Schema change | **NONE** — `trades.net_pnl` already exists |
| API contract | **UNCHANGED** — `profitLoss` |
| Second PnL column | **NOT AUTHORIZED** |
| Manual-trade PnL | **UNCHANGED** |
| Immutable ledger / ownership / `TRADE_IMPORTED` actors | **UNCHANGED** |
| **A-5** (ADR-002 PnL amendment) | Still **REQUIRED at implementation** — D-4 fixes the value, A-5 records it in ADR-002 in the same change as the trade-import code (AGENTS.md rule 11) |

### Explicitly NOT decided here

Provider→domain field mapping detail, whether commission/swap are stored separately for
imported trades, any diagnostic-value persistence (item 9), and **D-3** (migration-origin
semantics), which remains open.

---

## 3. Rationale

**OD-M1.** The audit verified from the legacy implementation that MetaAPI authenticates
callers with an **account-level `auth-token` header** sourced from server configuration
(`IntegrationConfigResolver::metaApiToken()`), while the **user** supplies broker
`server` + `mt_login` + `investorPassword`, which Velora forwards to MetaAPI at
provisioning. MetaAPI's public documentation independently confirms the `auth-token`
header and that `createAccount` takes `login`/`password`/`server`/`platform`. Two secret
classes therefore genuinely exist. Option C records reality rather than forcing one
class to masquerade as the other — which is precisely what clause 4 forbids, because a
platform token stored in `user_credentials` would inherit user-ownership semantics that
are meaningless for it and would corrupt the ownership-only authorization rule that
ADR-016 makes structural.

**OD-M2.** ADR-007 already places asynchronous work on pg-boss with lease, retry, DLQ and
backoff semantics, and the worker infrastructure exists. The attached constraints exist
because the audit verified three concrete leak vectors in the current worker path:
`runner.ts` logs `err.message` on failure; `index.ts` logs the whole event object; and
`pgBossAdapter.enqueue` persists the **entire descriptor including `payload`** to a
database table. A secret in a job payload would therefore become a durable plaintext row
that also bypasses the `user_credentials` privilege boundary.

**OD-M3.** The event name must carry the provenance. If sync emitted `TRADE_CREATED`,
"imported from a broker" and "created by sync" would be indistinguishable in the event
type, pushing provenance into `trades.source` alone and weakening the ledger's
self-describing property (ADR-002's stated purpose).

**OD-M4.** MetaAPI reports `profit`, `commission` and `swap` per deal from the broker's
own books. Recomputing from prices asserts that Velora's formula reproduces broker
arithmetic, which the listed divergence causes make false in general. The broker's
number is the one the user reconciles against their statement.

**TZ-M1.** Legacy `MetaApiInstantResolver.php` documents and its tests enforce exactly
these rules, including that a naive `brokerTime` returns `unresolved` with reason
`naive_no_offset` and that no IANA zone is inferred. This is primary evidence about the
provider's data, not a new policy.

---

## 4. ADR compatibility

Verdicts assigned only after reading each document at this HEAD.

| Decision | ADR-002 | ADR-004 | ADR-007 | ADR-009 | ADR-010 | ADR-016 | Verdict |
|---|---|---|---|---|---|---|---|
| OD-M1 | n/a | n/a | n/a | n/a | compatible | **in scope, compatible** | **PASS** |
| OD-M2 | n/a | n/a | **compatible (reinforces)** | n/a | compatible | **compatible (Future Work 4)** | **PASS (with D-2 open)** |
| OD-M3 | **amendment required** | n/a | n/a | n/a | n/a | n/a | **CONDITIONAL** |
| OD-M4 | compatible | n/a | n/a | n/a | n/a | n/a | **CONDITIONAL** |
| TZ-M1 | n/a | **closes OQ3** | n/a | n/a | n/a | n/a | **PASS (amend at implementation)** |

**ADR-009 (SEO & Locale Contract)** was inspected and is **not relevant** to any MetaAPI
decision. **ADR-010** is relevant only through its standing rule that secrets never enter
the repository; every decision here complies. Note this repository contains
**ADR-001…013 + ADR-016** — at the time of that assessment there was no ADR-014 or
ADR-015 here. **Updated 2026-09-15:** `ADR-014-metaapi-platform-token.md` now exists
(D-19) and discharges A-3; ADR-015 remains unused.

**OD-M1 vs ADR-016 — PASS, and specifically in scope.** ADR-016 §Scope governs *"secrets
that Velora stores **on behalf of a user** to authenticate to a third-party system"* and
explicitly does not govern other secret classes. The **user broker credential is squarely
inside** that scope and keeps the existing envelope unchanged (clause 6). The **platform
token is outside** it — so ADR-016 neither authorizes nor forbids a storage mechanism for
it, and no ADR-016 change is required to record OD-M1. ADR-016's *Non-Goals* disclaim
"a specific cloud secret manager", which is consistent with leaving D-1 open. Clauses 7
and 8 restate ADR-016's existing prohibitions verbatim and weaken nothing.

**OD-M2 vs ADR-007 — PASS, reinforcing.** ADR-007 §Security Impact already states:
*"payloads must not contain secrets; worker DB role is separate and least-privilege …
DLQ contents are redacted."* OD-M2's payload prohibition is therefore not new policy but
an existing ADR-007 requirement restated at the point it becomes load-bearing.
**OD-M2 vs ADR-016 — PASS.** Future Work item 4 anticipates *"Authorized server-side
consumption (C-27/C-29) — must preserve the isolation boundary and the
no-plaintext-logging rule."* OD-M2 is that work, and D-2 is the mechanism choice it
requires. Note `db/roles.sql` currently applies `REVOKE ALL ON TABLE user_credentials
FROM velora_worker`, with a comment naming C-29 as the phase that must *"grant exactly
what it requires and justify it"* — consistent with, not contradicted by, OD-M2.

**OD-M3 vs ADR-002 — CONDITIONAL, with a finding the owner should see.** ADR-002's
ownership matrix is labelled **"(proposed)"** and its rows say *Sync (MetaApi): upsert by
`(account_id, external_deal_id)`, fill/close trades* and *System: retention, aggregations,
corrections from migrations*. **ADR-002 never names `TRADE_IMPORTED`** (0 occurrences);
the concrete event vocabulary was introduced in implementation, where
`packages/contracts/src/trades.ts` annotates it *"// migration origin event"*.

Read together, OD-M3 **aligns the code with ADR-002's actual intent** — ADR-002 assigns
importing to Sync and migration-era corrections to System, whereas the code assigns
`TRADE_IMPORTED` to `system` only. The audit therefore records the existing
`["system"]` restriction as an implementation artifact that is **arguably already
inconsistent with ADR-002's matrix**, not as a deliberate ADR-002 constraint OD-M3
overturns. This makes OD-M3 low-risk, but it is still a **change to the enforced actor
matrix** and must be ratified in writing before code changes (§8).

**One consequence the owner should note:** if `TRADE_IMPORTED` becomes the sync import
event, the legacy-data-migration meaning implied by *"migration origin event"* needs an
explicit home — either the same event with actor `system` (both actors permitted), or a
distinct event. The amendment in §8 must state which. This record does **not** decide it
(§5).

**OD-M4 vs ADR-002/ADR-001 — CONDITIONAL.** ADR-002 establishes `SYNC_WINS_FINANCIAL`,
so provider authority over financial fields is already the governing policy; OD-M4 is
consistent with it. It is CONDITIONAL only because the **import mapping does not yet
exist**: `TradeRecord.source` is typed as the literal `"manual"`, and `externalDealId` is
absent from the write model, so no code path can currently persist a provider-reported
PnL. ADR-001 money scales are unaffected — the value's *origin* changes, not its
precision. No PnL recomputation of existing rows is authorized by this record.

**TZ-M1 vs ADR-004 — PASS now; amendment at implementation.** ADR-004 §Decision already
requires that *"broker/MetaApi-reported times are stored as reported, plus captured
source/offset metadata where the provider supplies it"*, and its §Open Questions item 3
is *"MetaApi timestamp semantics in current sync code"*. TZ-M1 supplies exactly that
evidence and **contradicts nothing** in ADR-004. Per the owner's instruction ADR-004 is
**not modified now**; closing OQ3 in ADR-004 is required when the import phase lands
(§8). Manual-trade behaviour (user-profile TZ → canonical instant) is untouched.

---

## 5. Explicit non-decisions

This record does **NOT** decide, and nothing below may be inferred from it:

1. **Where or how the platform MetaAPI token is stored** (env var, secret manager, DB, or
   other). Preferred *direction* only: an externally supplied server-side
   secret/configuration, consistent with ADR-016's externally-supplied philosophy.
2. **That the MetaAPI platform token is the encryption master key.** It is **not** —
   see §7. The similarity is one of *supply philosophy*, nothing more.
3. **The worker credential-consumption mechanism** (A/B/C/D under OD-M2).
4. **Any database privilege change** for `velora_worker`.
5. **The `TRADE_IMPORTED` actor set's final composition** — whether `system` is retained
   alongside `sync` for legacy migration origin.
6. **Whether a diagnostic/reconciliation PnL column will exist**, and its name or scale.
7. **The durable storage location for naive `brokerTime` evidence.**
8. **Any MetaAPI endpoint, client shape, SDK adoption, retry budget or rate-limit policy.**
9. **The `transaction-id` vs `Idempotency-Key` provisioning header question** — unresolved;
   provider docs specify `transaction-id`, legacy sends `Idempotency-Key`.
10. **Webhook ingestion** (ADR-008 remains "Implementation not started").
11. **Credential disclosure auditing** (`CREDENTIAL_USED` or equivalent) — still DEFERRED.
12. **Key rotation** — remains deferred by ADR-016.

---

## 6. Deferred implementation decisions

| ID | Decision required | Blocks | Constraint it must satisfy |
|---|---|---|---|
| **D-1** | ~~Platform MetaAPI token storage mechanism~~ — **RATIFIED 2026-09-15 by ADR-014 (D-19)**: environment-supplied `METAAPI_PLATFORM_TOKEN` + `METAAPI_BASE_URL`, resolver-validated (`MA-001`…`MA-003`), fail-closed capability-absent. | ~~MetaAPI connect~~ | Satisfied by ADR-014 §2–§5. Implementation remains Phase 3 |
| **D-2** | ~~Worker credential-consumption mechanism (A / B / C / D)~~ — **RATIFIED 2026-09-15: Boundary-Scoped Option B** (§2A). Provisioning is API-hosted and credential-consuming; synchronization is worker-hosted and credential-free, using `METAAPI_PLATFORM_TOKEN` + `metaapi_account_id`. | ~~Worker-side sync~~ | Satisfied: no broad `SELECT`, no plaintext in payloads, no ciphertext to the worker, ADR-016 isolation preserved. No broker, no migration, no `roles.sql` change |
| **D-3** | `TRADE_IMPORTED` final actor set (and the home of migration-origin semantics) | Trade import | ADR-002 amendment ratified first |
| **D-4** | ~~Whether a diagnostic PnL value is retained, and where~~ — **RATIFIED 2026-09-15: provider-reported profit is authoritative and populates the existing canonical `net_pnl`** (§2B). No second PnL column; no persisted local-vs-provider comparison; local calculation, if ever performed, is diagnostic only and never overwrites the provider value. | ~~Trade import~~ | Satisfied: one canonical persisted value, `profitLoss` API contract unchanged, manual-trade behaviour unchanged, **no migration**. Persisted diagnostic values remain a separate Owner Decision |
| **D-5** | Durable storage for naive `brokerTime` evidence | Trade import | Evidence only; never parsed; no IANA inference |
| **D-6** | Sync substrate: cursor (`last_synced_at`), operation reservation, fill ledger, `quarantined` column | Sync phases | Migrations, each separately justified |
| **D-7** | Provisioning idempotency header (`transaction-id` vs `Idempotency-Key`) | MetaAPI connect | Resolve from provider docs/support; no live call with user credentials |

---

## 7. Security constraints

### The three distinct secrets — **these are NOT interchangeable**

| Secret | Purpose | Owner / scope | Storage today | Governed by |
|---|---|---|---|---|
| **Velora encryption master key** (`CREDENTIAL_MASTER_KEY`) | Protects Velora's encrypted credential store | Installation; operators only | Environment, externally supplied, never in repo | **ADR-016** |
| **MetaAPI platform token** | Authenticates **Velora** to MetaAPI | Installation; not attributable to any user | Environment (`METAAPI_PLATFORM_TOKEN`) — governed, **not yet implemented** | **ADR-014** |
| **User broker credential** (server + login + investor password) | Authenticates/provisions the **user's** trading account through MetaAPI | Individual user | `user_credentials`, AES-256-GCM | **ADR-016** |

**Different secrets, different purposes, different ownership, different lifecycles.**
Compromise of any one does not imply compromise of the others. Specifically:

- The master key is a **cryptographic key**; the MetaAPI token is a **bearer
  credential for an external API**. Using one as the other would be a category error.
- **Reusing `CREDENTIAL_MASTER_KEY` as the MetaAPI token, or deriving one from the other,
  is prohibited.**
- The platform token authenticates Velora-as-a-customer; the user broker credential
  authenticates a specific person's brokerage account. Conflating them would let a
  platform-level compromise reach user brokerage accounts directly.

### Standing constraints carried into every MetaAPI phase

1. No plaintext credential in the database (AES-256-GCM only).
2. No plaintext credential in `audit_log`.
3. No plaintext credential in any HTTP response.
4. No plaintext credential in application logs, DLQ entries, or error messages.
5. **No plaintext credential in any job payload** (ADR-007 §Security Impact; OD-M2).
6. No credential disclosure to System Owner, admin or super_admin through any
   administrative path — ownership remains the **only** authorization rule (ADR-016).
7. No client-supplied ownership: the owning `userId` is always server-derived.
8. **No generic credential reveal endpoint, ever** (ADR-016).
9. Fail closed when key configuration is unavailable.
10. Provider error bodies are scrubbed before logging or surfacing.

---

## 8. Required ADR amendments before implementation

**None of these is performed by this record.** Each must be ratified **before** the
implementation phase it gates, and — per AGENTS.md rule 11 — landed **in the same change**
as that implementation.

| # | Document | Exact amendment | Gates | Status |
|---|---|---|---|---|
| **A-1** | `docs/adr/ADR-002-trade-ledger.md` — *Ownership matrix* §Decision + *Amendment A-1* | **DONE 2026-09-15.** `TRADE_IMPORTED → ["system", "sync"]` ratified: `sync` is the controlled worker performing MetaAPI imports; `system` retained for migration-origin imports. Matrix row no longer "(proposed)". Limits recorded: no ownership bypass, no impersonation, no other actor set broadened, no credential access. **No migration required.** | OD-M3, trade import | **SATISFIED** |
| **A-2** | `docs/adr/ADR-004-time-model.md` — §Open Questions item 3 | Close *"MetaApi timestamp semantics in current sync code"* with TZ-M1: offset-explicit `time` → deterministic UTC; naive `brokerTime` never interpreted; no IANA inference; `source_timezone` NULL with provenance for MetaAPI rows. **Manual-trade behaviour unchanged.** | TZ-M1, trade import | **REQUIRED at implementation** |
| **A-3** | `docs/adr/ADR-014-metaapi-platform-token.md` | **DONE 2026-09-15 (D-19).** Governs the platform token as a distinct secret class: external supply, prohibitions (no `user_credentials`, no synthetic user, no derivation from `CREDENTIAL_MASTER_KEY`), fail-closed resolver, independent rotation, no mandated secret manager. **ADR-016 unchanged.** | OD-M1, MetaAPI connect | **SATISFIED** |
| **A-4** | `docs/adr/ADR-007-job-semantics.md` | **NOT REQUIRED — condition resolved 2026-09-15.** D-2 selected Boundary-Scoped Option B, which alters no worker DB role and no least-privilege posture, so the stated "no amendment is needed" branch applies. **ADR-007 remains unchanged** unless an actual worker-role or job-semantics change is later introduced. | OD-M2, worker sync | **NOT REQUIRED** |
| **A-5** | `docs/adr/ADR-002-trade-ledger.md` | Record that provider-reported profit is the authoritative net-PnL input for imported trades under `SYNC_WINS_FINANCIAL`. **D-4 is now RATIFIED (§2B)**, so the disposition is settled: the provider value populates the existing canonical `net_pnl`, and **no second PnL column and no persisted diagnostic value are authorized**. A-5 records this in ADR-002 in the same change as the trade-import implementation. | OD-M4, D-4, trade import | **REQUIRED at implementation** |

`db/roles.sql` is **not** an ADR but carries a standing obligation: its `user_credentials`
block states that a future worker phase *"must grant exactly what it requires and justify
it."* **D-2 discharges that obligation with the narrowest possible answer: the worker requires
nothing, so nothing is granted and `db/roles.sql` is unchanged.**

**B11 preserved (unchanged by D-2).** `db/roles.sql` still contains broad `ALTER DEFAULT
PRIVILEGES` for `velora_worker`, which would auto-grant DML on **future** tables. That remains a
**future D-6 concern**, and **D-2 does NOT authorize changing those privileges**.

---

## 9. Implementation gates unlocked

**Unlocked for DESIGN work only** (no code, no schema, by this record):

- **G-1 — Internal credential-consumer design.** OD-M1 fixes what a consumer consumes.
  Requires **no migration** and **no change to `CredentialStore.reveal(id, userId)`**,
  which the audit verified is already owner-scoped and correctly shaped.
- **G-2 — Worker execution design.** OD-M2 fixes *where* sync runs; **D-2 (ratified) fixes that
  it reaches no credentials at all** — sync is credential-free, authenticating with
  `METAAPI_PLATFORM_TOKEN` and `metaapi_account_id`. Design may proceed on that basis.
- **G-3 — Log/payload hardening design.** Unblocked and **recommended first**: the three
  verified leak vectors should be closed before any plaintext egress exists.
- **G-4 — Trade-import mapping design.** OD-M3 + OD-M4 + TZ-M1 fix event, PnL authority
  and timestamp semantics; implementation still gated on A-1/A-2/A-5 and D-3…D-6.

**NOT unlocked — implementation remains blocked:**

MetaAPI client · provider routing · connect/provisioning route · account discovery ·
historical or incremental sync · webhooks · credential reveal in any form ·
`CREDENTIAL_REVEALED`/`CREDENTIAL_USED` audit events · any migration · any privilege change.

---

## 10. Remaining blockers

| ID | Blocker | Cleared by | State |
|---|---|---|---|
| **B1** | Credential model contradiction (platform vs user secret) | **OD-M1** | **RESOLVED at decision level**; storage mechanism open (D-1) |
| **B2** | Worker cannot reach credentials — no tsconfig reference, no dependency, no barrel export, and `velora_worker` holds `REVOKE ALL` on `user_credentials` | **D-2 (ratified 2026-09-15)** | **CLOSED — DISSOLVED.** Sync is credential-free, so no credential path is needed. The `REVOKE ALL` is correct and stays. A-4 not required |
| **B3** | `TRADE_IMPORTED` forbids actor `sync` (verified by executing `assertOwnership`) | **OD-M3 + A-1 (ratified 2026-09-15)** | **CLOSED (governance).** The domain still encodes `["system"]`; the one-line change is now AUTHORIZED and lands with the trade-import implementation (AGENTS.md rule 11). **No migration.** D-3 (final disposition of migration-origin semantics) remains open |
| **B4** | No sync substrate: no `last_synced_at`, no operation reservation, no fill ledger, no `quarantined` column | **D-6** migrations | **OPEN** |
| **B5** | Three verified log/payload leak vectors (`runner.ts` `err.message`; `index.ts` event log; pg-boss persists payloads) | G-3 hardening | **OPEN — must close before plaintext egress** |
| **B6** | Provisioning idempotency header mismatch (`transaction-id` vs `Idempotency-Key`) | **D-7** | **OPEN / NOT PROVEN** |
| **B7** | pg-boss never integration-tested; `pgBossAdapter.claim()` hardcodes `attempts: 0` | Worker phase | **OPEN / NOT PROVEN** |
| **B8** | Import write model cannot represent provider data — `TradeRecord.source` typed `"manual"`; `externalDealId` absent from the write model | G-4 / trade-import phase | **OPEN** |
| **B9** | Platform token has no governed storage | **D-1 + A-3** | **CLOSED (governance) 2026-09-15 — ADR-014 ratified.** Implementation pending Phase 3 |

**MetaAPI implementation is NOT unlocked.** Four decisions of principle are recorded
(OD-M1…OD-M4 + TZ-M1), clearing B1 at the decision level. **D-1 (ADR-014) and D-2
(§2A) are now RATIFIED, and A-3 is satisfied**, which closes **B1, B9 and B2** at the
governance level.

**Still outstanding before the first line of MetaAPI implementation code:** the
substrate/mapping decisions **D-3…D-7**, plus the operational blockers below.
**A-1 was ratified 2026-09-15** (ADR-002 *Amendment A-1*), closing B3 at the governance
level; **A-2 and A-5 remain REQUIRED** at their respective implementation phases.

**B10 — the async pipeline is inert (VERIFIED 2026-09-15).** D-2 settles *how* the worker
obtains credentials (it does not need any), but **no worker is deployed**: `railway.json`
defines a single API service, **nothing in the repository calls `enqueue()`**, and the
worker's handler map is empty. OD-M2 is therefore currently aspirational, and closing B10
requires a **deployment decision** that is outside implementation authority. See
`VELORA-B10-ASYNC-PIPELINE-INERT-FINDING.md`.

---

## Audit trail

- **Source evidence:** *MetaAPI Integration Readiness Audit* (2026-09-15), read-only,
  repository HEAD `7864e9f`, legacy reference `e42379f`. Classifications in that audit
  were re-verified against the ADRs before assigning the §4 verdicts.
- **Documents inspected for this record:** ADR-002, ADR-004, ADR-007, ADR-009, ADR-010,
  ADR-016, `RECONCILIATION_DECISIONS.md` (OD-1…OD-10), `AGENTS.md`, `db/roles.sql`,
  `packages/domain/src/tradeLedger.ts`, `packages/domain/src/pnl.ts`,
  `packages/contracts/src/trades.ts`.
- **Owner authorization:** owner directive, 2026-09-15 (this session) — decisions quoted
  in §2 are the owner's, recorded verbatim in substance.
- **D-4 ratification (2026-09-15), recorded at HEAD `0390ab5`:** provider PnL authority fixed to
  the existing canonical `net_pnl` (§2B). Claims verified before recording: `trades.net_pnl`
  present in migration 0001; `provider_profit`/`calculated_profit`/`broker_profit` absent from
  all 12 migrations; serialization chain `net_pnl` → `netPnl` → `profitLoss` confirmed in
  `pgTradeStore.ts:101` and `tradeService.ts:652`. **Governance only: no code, no schema, no
  migration, no API change.**
- **A-1 amendment (2026-09-15), recorded at HEAD `b31975d`:** ADR-002 amended to ratify
  `TRADE_IMPORTED → ["system", "sync"]` (dated Status amendment + *Amendment A-1* section +
  ownership-matrix rows), following the ADR-010 amendment precedent. Mismatch re-proven by
  executing `assertOwnership("TRADE_IMPORTED", "sync")` → `OwnershipPolicyError` before the
  edit. **Governance only: no code, no schema, no migration, no privilege change.**
- **D-2 amendment (2026-09-15), recorded at HEAD `51688e3`:** owner ratified
  **Boundary-Scoped Option B** (§2A) on the evidence of the read-only *D-2 Architectural
  Clarification Audit* (`VELORA-D2-ARCHITECTURAL-CLARIFICATION-AUDIT.md`), which inspected
  the legacy implementation (`MetaApiService.php` `providerRequest`/`fetchHistoricalTrades`/
  `runNextSyncJob`, `AccountRepository.php`) and this repository's `railway.json`,
  `db/roles.sql`, ADR-007, ADR-014 and ADR-016. **That amendment changed this document
  only** — no ADR, no code, no schema, no migration, no privilege.
- **This record changes no ADR, no schema, no code.** Where it differs from any
  recommendation in the readiness audit, **this record is authoritative**; audit
  recommendations were not converted into decisions unless the owner approved them above.
