# VELORA MODERN — MetaAPI Owner Decisions (OD-M1 … OD-M4 + TZ-M1, D-1, D-2, D-3, D-4, D-5, D-7, OD-MP-1, OD-MP-2, OD-MP-3)

## 1. Status

**Status:** OWNER-APPROVED 2026-09-15 (explicit owner directive, this session).
**Amended 2026-09-16 — OD-MP-1, OD-MP-2, OD-MP-3 RATIFIED (see §2F).** Governance-only.
These three decisions move API-side MetaAPI provisioning, the audit vocabulary for authorized
credential use, and disconnect/revocation semantics from **NOT AUTHORIZED** to **AUTHORIZED FOR
FUTURE IMPLEMENTATION**. **Nothing is implemented by this amendment**: no route, no provisioning
client, no credential-consumption call site, no binding service, no disconnect behaviour, no
migration, no schema change, no privilege change, no worker change, no deployment change. The
prior audit classification (`BLOCKED — OWNER DECISION REQUIRED`) is superseded **at the
governance level only**; the implementation remains a separate, future change.
**Amended 2026-09-15 — D-7 RATIFIED IN PART (see §2E).** Governance-only, from **official MetaAPI
documentation only** (no authenticated call, no provider mutation). The header-identity question
is **settled**: the documented mechanism is **`transaction-id`**, and **`Idempotency-Key` is NOT a
documented MetaAPI mechanism** — the legacy PHP system sends a header MetaAPI does not document.
The **historical-sync path Velora plans has no request-level idempotency mechanism and needs
none.** A residual sub-question (general deduplication/retention semantics) is recorded as
**NOT PROVEN**. No code, no schema, no migration.
**Amended 2026-09-15 — D-5 RATIFIED (see §2D).** Governance-only: fixes how a naive MetaAPI
`brokerTime` is preserved as evidence without inventing a timezone. A **dedicated
`broker_time_text` field is REQUIRED** but is **deliberately NOT created here** — it lands with
the trade-import implementation. No code, no schema, no migration.
**Amended 2026-09-15 — D-3 RATIFIED (see §2C).** Governance-only: fixes the final
`TRADE_IMPORTED` actor set as **`["system", "sync"]`** and assigns each actor a distinct
provenance meaning. **No new actor is introduced**, no actor is removed, no other event's actor
set changes, and `TRADE_CREATED` keeps its meaning. No code, no schema, no migration.
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
imported trades, and any diagnostic-value persistence (item 9). **D-3 (migration-origin
semantics) is now RATIFIED — see §2C.**

---

## 2C. Owner decision — D-3 (ratified 2026-09-15)

### D-3 — Migration-origin semantics: **`system` AND `sync` ARE DISTINCT PROVENANCE VALUES ON ONE EVENT**

**Owner decision, ratified 2026-09-15.** The final actor set for `TRADE_IMPORTED` is
**`["system", "sync"]`** — exactly the set A-1 established. D-3 settles *why* both actors
exist and fixes their meanings so the pair cannot later drift or be collapsed.

**Binding terms.**

1. **`system` is PRESERVED** as an allowed actor for `TRADE_IMPORTED`.
2. **`system` = migration-origin / system-origin provenance** — an import performed by an
   explicitly authorized migration or system process, whose origin is *not* a live provider
   synchronization cycle.
3. **`sync` = provider-synchronization provenance** — the controlled background worker
   performing provider-originated MetaAPI imports (OD-M2, A-1).
4. **`system` is NOT collapsed into `sync`.** The two provenance classes stay separately
   representable.
5. **`system` is NOT removed** from the `TRADE_IMPORTED` actor set.
6. **No migration-specific actor is introduced.** `migration`, `importer`, `legacy` and
   `backfill` are all **forbidden**; `MutationActor` stays exactly
   `user | sync | webhook | admin | system`.
7. **No other event's actor set changes.** The ownership matrix is otherwise untouched.
8. **`TRADE_CREATED` keeps its meaning** — manual creation. It is not repurposed for imports.

**Security boundary — binding.**

- **The actor is an internal attribution/provenance value, not an authorization grant.**
- **`system` is NOT client-selectable.** No request body, header, query parameter, job payload
  or other external input may select `actor = system`.
- **`sync` likewise stays server-controlled**, asserted only by the synchronization path that
  has already established the account context (A-1 already binds this).
- Both actors are asserted by trusted server-side code **after** ownership is established.

**This decision does NOT authorize:** ownership bypass · user impersonation · arbitrary event
creation · client-selected actors · worker access to `user_credentials` ·
`CREDENTIAL_MASTER_KEY` access · MetaAPI credential exposure · deployment · webhook
implementation.

### Rationale — two materially different provenance classes

| Class | Actor | What it represents |
|---|---|---|
| **A — migration/system origin** | `system` | A controlled internal migration or system operation. Provenance is *not* a live provider sync cycle |
| **B — provider synchronization** | `sync` | The long-running controlled worker importing provider-originated trades from MetaAPI |

Both are **imports**, so both correctly use `TRADE_IMPORTED`; the event type answers *what
happened*, the actor answers *what originated it*. Folding them into one value would destroy a
provenance distinction the ledger exists to preserve, and inventing a third actor would add a
vocabulary term with no behaviour behind it. Keeping `TRADE_IMPORTED` single-typed also means
every existing reader, projection and CHECK constraint continues to work untouched.

### Repository evidence (verified before ratifying, not assumed)

| Claim | Evidence |
|---|---|
| The DB already accepts both actors on this event | `db/migrations/0001_core.sql:117` — `actor TEXT NOT NULL CHECK (actor IN ('user','sync','webhook','admin','system'))`; the `type` CHECK (`:114-116`, widened by `0005`) contains `TRADE_IMPORTED`. Both combinations are already legal, and D-6's `syncSubstrate.pg.test.ts` inserted `('TRADE_IMPORTED','sync')` successfully |
| `system` has a documented migration-origin meaning | `packages/contracts/src/trades.ts:54` annotates `TRADE_IMPORTED` as `// migration origin event`; ADR-002 *Migration Impact* states *"Existing trades import into the ledger as `IMPORT` origin events"* |
| The actor vocabulary is already closed and sufficient | `packages/contracts/src/trades.ts:44` — `MutationActor = "user" \| "sync" \| "webhook" \| "admin" \| "system"`. No new term is needed |
| `system` is load-bearing beyond this event | `packages/domain/src/tradeLedger.ts:85` — `QUARANTINE_RAISED: ["sync","webhook","system","admin"]`. Removing `system` from the vocabulary would have reached further than imports |
| Current code state | `packages/domain/src/tradeLedger.ts:77` still encodes `TRADE_IMPORTED: ["system"]`. **No production code emits `TRADE_IMPORTED`** — the identifier appears only in type declarations, the actor matrix, `applyEvent`, and tests |

### Consequences

| Area | Effect |
|---|---|
| Actor vocabulary | **Unchanged** — no term added, none removed |
| `TRADE_IMPORTED` actor set | **`["system", "sync"]`** — identical to A-1; D-3 adds meaning, not members |
| Other event actor sets | **Unchanged** |
| `TRADE_CREATED` | **Unchanged** — manual creation |
| Database | **No migration.** The `0001` CHECK already permits both actors; restating a valid constraint in a new migration is explicitly **not** done |
| Domain code | Still `["system"]` at `tradeLedger.ts:77`. The one-line widening remains **authorized but unapplied**, landing with the trade-import implementation (AGENTS.md rule 11) |
| A-1 | **Preserved in full.** D-3 adds the provenance reading; it supersedes nothing |

### Explicitly NOT decided here

Which concrete migration or system process may assert `system` (none exists today); how the
sync worker establishes account context; the provider→domain field mapping; **D-7** (external
idempotency mechanism); and **A-2** (ADR-004 timestamp amendment), all of which remain open.

---

## 2D. Owner decision — D-5 (ratified 2026-09-15)

### D-5 — Naive `brokerTime` evidence: **PRESERVED VERBATIM IN A DEDICATED FIELD, NEVER INTERPRETED**

**Owner decision, ratified 2026-09-15.** A naive MetaAPI `brokerTime` is **evidence, not an
instant**. It is stored verbatim, never parsed, never converted, and never allowed to influence
any UTC value. Because the provider supplies `time` and `brokerTime` as **two distinct fields in
the same deal**, the existing `sync_fills.raw_time_text` column **cannot** serve as the canonical
home for both: a **dedicated `broker_time_text` field is required**, and is deferred to the
trade-import implementation phase (AGENTS.md rule 11).

**Binding terms.**

1. **Explicit timestamp.** If the provider timestamp carries `Z` or an explicit UTC offset, it is
   parsed **deterministically** to UTC, persisted in `occurred_at_utc`, with `time_status =
   'resolved_utc'`, and the original provider string preserved verbatim in `raw_time_text`.
2. **Naive `brokerTime`.** If the provider supplies a naive `brokerTime` with no offset, the
   **exact provider string is preserved verbatim as evidence**. No timezone is assigned, no UTC
   conversion is performed, and no IANA zone is inferred.
3. **Forbidden inference sources — exhaustive and binding.** A naive `brokerTime` must NEVER be
   interpreted using a guessed timezone, broker country, broker/server location, account
   location, machine/host timezone, IANA inference, a default application timezone, or any other
   heuristic.
4. **`occurred_at_utc` MUST remain NULL** for a fill whose only timestamp evidence is naive,
   unless **independently deterministic** evidence exists. `time_status` stays `'unresolved'`,
   which migration `0012`'s `sync_fills_time_consistency` CHECK already enforces at the database
   level.
5. **Analytics and ordering.** An unresolved naive timestamp **MUST NOT** be treated as if it
   were UTC, **MUST NOT** silently participate in time-based analytics, and **MUST NOT** be used
   for deterministic chronological ordering where timezone interpretation is required.
   Unresolved rows are excluded from such computations rather than approximated.
6. **Future reconciliation.** If authoritative deterministic timezone evidence is later obtained,
   reconciliation **may be designed separately**. Historical raw evidence remains **immutable**,
   and the system **must never overwrite the original provider evidence with a derived or
   guessed value**. Any such reconciliation is a **separate Owner Decision**.
7. **Storage.** `raw_time_text` keeps its existing meaning — verbatim copy of the **absolute,
   offset-explicit `time`**. A **dedicated `broker_time_text`** field carries the naive
   `brokerTime`. **`raw_time_text` is not overloaded, not redefined, and not altered.**
8. **No schema change is authorized by D-5.** The `broker_time_text` column is **authorized in
   principle but NOT created**; it lands in the same change as the trade-import implementation.

### Traceability — the five questions answered before ratifying

**1. What `raw_time_text` currently means.** Introduced by migration `0012`
(`db/migrations/0012_metaapi_sync_substrate.sql:134`) as a nullable, **unconstrained** `TEXT`
column on `sync_fills`. Its documented meaning (`:125-132`) is narrow: `occurred_at_utc` is set
**only** from an offset-explicit provider `time`, and *"`raw_time_text` keeps **that value**
verbatim as evidence."* It is the verbatim copy of the **absolute** timestamp — the same role as
legacy `metaapi_fills.raw_time_text`, commented *"verbatim absolute `time`"*. **No CHECK
constraint references it**, so the database would not reject a naive value — the restriction is
semantic, not enforced.

**2. Whether it can safely represent naive `brokerTime`.** **No.** The provider returns `time`
and `brokerTime` as **two distinct fields in the same deal**, so they must both be retainable
**simultaneously** for one fill. Verified in the legacy implementation:
`MetaApiService.php:206-209` extracts `time_raw ← $deal['time']` and, separately,
`broker_time ← $deal['brokerTime']`; `MetaApiFillRepository.php:44-48,77-78` binds `:raw_time`
and `:broker_time` as **separate parameters in the same INSERT**; and the history-deal fixture
(`MetaApiService.php:898-917`) shows every deal carrying **both** an offset-explicit `time` and a
naive `brokerTime`. Overloading one column would therefore be **lossy** — it could store one or
the other, not both — and would additionally make the column's contents ambiguous: a reader could
no longer tell whether a stored string is an absolute instant or an uninterpretable wall-clock
value, which is precisely the confusion this governance exists to prevent.

**3. Whether a dedicated `broker_time_text` field is actually necessary.** **Yes — REQUIRED.**
This is not an invention: it mirrors the **verified** legacy column
`metaapi_fills.broker_time_text VARCHAR(64) NULL -- naive brokerTime, evidence only`
(`api/database/migrations/v1.1_metaapi_fill_ledger.sql:42`), whose repository documentation states
*"brokerTime is stored as evidence only (broker_time_text) and NEVER used"* (`:16`). D-6
explicitly deferred exactly this column to D-5 (`0012:130-132`), and TZ-M1 item 6 assigns its
durable storage to D-5. **The column is NOT created by this decision.**

**4. Exactly what D-5 authorizes.** Recording the semantics above, and authorizing **in
principle** a single additive, nullable `broker_time_text` evidence field on the fill ledger —
to be created **only** as part of the trade-import implementation, with its own migration and
tests, under the existing migration rules.

**5. Exactly what D-5 does NOT authorize.** No migration and no schema change now · no
modification of `raw_time_text`, `occurred_at_utc`, `time_status`, or any `0012` object · no
runtime/TypeScript/PHP code · no MetaAPI client, worker, sync or webhook · no parsing,
normalization or conversion of `brokerTime` · no IANA inference of any kind · no
timezone-reconciliation mechanism · no change to manual-trade timezone behaviour · no ADR
amendment · no deployment · no provider contact.

### Rationale

Two timestamps, two meanings, two columns. `time` is an **absolute instant** and reduces
deterministically to UTC; `brokerTime` is a **wall-clock reading in an unknown zone** and reduces
to nothing without evidence Velora does not possess. Keeping them in separate fields makes the
distinction structural rather than conventional: no reader has to guess which kind of value it
holds, and no future code can accidentally promote a wall-clock string to an instant. Discarding
`brokerTime` instead was rejected — it is the only record of what the broker itself displayed,
which is what a user recognises when reconciling a trade, and it is the raw material any future
timezone determination would need. Storing it **without** interpreting it is the only option that
loses no evidence and fabricates no fact.

### Relationship to ADR-004

**Consistent; no amendment made here.** ADR-004 §Decision item 1 mandates UTC-only `timestamptz`
storage — honoured, because a naive value never becomes a `timestamptz` at all; it stays TEXT with
`occurred_at_utc` NULL. Item 2 mandates that broker/MetaApi times are *"stored as reported, plus
captured source/offset metadata **where the provider supplies it**"* — D-5 is the precise
application of that clause to the case where the provider supplies **no** offset. The ADR's own
rejection of naive storage in PG (*"every consumer must guess"*) is respected: nothing is stored
in a form that invites interpretation. Manual-trade timezone behaviour is **unchanged**.

**A-2 remains the deferred ADR-004 amendment** (§8) and is **NOT performed here**: ADR-004
§Open Questions item 3 (*"MetaApi timestamp semantics in current sync code"*) is closed by TZ-M1
together with D-5, but per AGENTS.md rule 11 that amendment lands **with the trade-import
implementation**. D-5 adds the `broker_time_text` disposition to A-2's required content.

### Relationship to D-6

**Additive; nothing in `0012` changes.** D-6 built the evidence substrate and deliberately stopped
at this boundary, stating that no naive `brokerTime` column is added because *"TZ-M1 item 6
assigns its durable storage to D-5, which is NOT authorized by D-6"* (`0012:130-132`). D-5
supplies that missing decision and nothing else: `occurred_at_utc`, `raw_time_text`,
`time_status` and the `sync_fills_time_consistency` CHECK are **untouched**. That CHECK already
enforces term 4 in the database — `time_status='unresolved'` requires `occurred_at_utc IS NULL`,
proven by executed test in `db/tests/syncSubstrate.pg.test.ts`. D-5 adds **no** new constraint
and **no** new state to `time_status`.

### Implementation status

**GOVERNANCE ONLY — nothing implemented.** No migration was created, no schema object was
altered, no runtime code was changed, and migration count remains **12**. The `broker_time_text`
column is **authorized but NOT created**. Deferred to the trade-import implementation phase:
(a) the additive migration creating a nullable `broker_time_text` on `sync_fills`; (b) the
population logic writing it verbatim from the provider payload; (c) the A-2 ADR-004 amendment;
(d) tests proving a naive `brokerTime` yields `occurred_at_utc IS NULL` and
`time_status='unresolved'`. None of these is authorized now.

---

## 2E. Owner decision — D-7 (ratified in part 2026-09-15)

### D-7 — External idempotency contract: **`transaction-id` ON PROVISIONING WRITES; NO REQUEST-LEVEL MECHANISM ON THE SYNC READ PATH**

**Status:** **RATIFIED IN PART, 2026-09-15.** The question D-7 was created to answer —
`transaction-id` vs `Idempotency-Key` — is **resolved from authoritative provider documentation**.
One narrower sub-question (general deduplication and retention semantics) is **NOT PROVEN** and is
recorded as such rather than guessed.

**Date:** 2026-09-15 · **Evidence class:** official MetaAPI documentation, fetched in full (not
search snippets). **No authenticated MetaAPI call was made; no provider-side state was created,
modified or deleted.**

### External evidence sources (all fetched directly)

| # | Source | Established |
|---|---|---|
| E-1 | `https://metaapi.cloud/docs/provisioning/api/account/createAccount/` | `POST /users/current/accounts` header table lists **`transaction-id`, string, Required: Yes** |
| E-2 | `https://metaapi.cloud/docs/provisioning/api/accountReplica/createAccountReplica/` | `POST /users/current/accounts/:accountId/replicas` header table lists **`transaction-id`, Required: Yes**, identical description |
| E-3 | `https://metaapi.cloud/docs/client/restApi/api/retrieveHistoricalData/readDealsByTimeRange/` | `GET /users/current/accounts/:accountId/history-deals/time/:startTime/:endTime` header table lists **only `auth-token`** — **no `transaction-id`, no idempotency header** |
| E-4 | `https://metaapi.cloud/docs/provisioning/api/account/deployAccount/` | `POST .../deploy` header table lists **only `auth-token`**; doc states *"This request will be ignored if the account is already deployed"* |
| E-5 | `https://metaapi.cloud/docs/provisioning/api/account/deleteAccount/` | `DELETE /users/current/accounts/:accountId` header table lists **only `auth-token`** |
| E-6 | `https://metaapi.cloud/docs/provisioning/api/account/updateAccount/` | `PUT /users/current/accounts/:accountId` header table lists **only `auth-token`** |
| E-7 | `https://metaapi.cloud/docs/provisioning/models/acceptedError/` | `AcceptedError` (202) carries `metadata.recommendedRetryTime`; the HTTP response carries `Retry-After` |

**Negative finding (searched, not found):** **no MetaAPI documentation page documents an
`Idempotency-Key` header.** Results for that term resolve to the IETF draft and unrelated
third-party APIs (Adyen, Yandex), which are **not authoritative for MetaAPI** and are **not**
relied on here.

### Exact documented mechanism

Verbatim from E-1/E-2:

> `transaction-id` — *"Transaction id is used to identify a unique transaction. For the new request
> please generate a random 32-character transaction id. If your request has returned 202 status
> code, please reuse the same transaction id value to poll the result of the request you've sent
> earlier."*

1. **Mechanism:** an HTTP **request header** named **`transaction-id`** (not a body field, not a
   query parameter).
2. **Value:** a **random 32-character** value, client-generated, **per new request**.
3. **Operation scope — VERIFIED:** **required** on `POST /users/current/accounts` (E-1) and
   `POST /users/current/accounts/:accountId/replicas` (E-2). **Absent** from the documented header
   tables of deploy (E-4), delete (E-5), update (E-6) and the historical-deals read (E-3).
4. **Retry semantics — documented only for the 202 case:** when a request returns **202**, the
   client **reuses the same `transaction-id` to poll the result of the earlier request** instead of
   starting a new one. `Retry-After` / `recommendedRetryTime` indicate when (E-7). For account
   creation this is the real-world case: broker-settings detection returns 202, and polling with
   the same value avoids creating a second account.
5. **Duplicate semantics outside the 202 flow — NOT DOCUMENTED.**
6. **Retention / lifetime — NOT DOCUMENTED.**
7. **Protection class:** the documentation describes a mechanism that **identifies a transaction
   and allows polling an in-flight one**. It does **not** state that MetaAPI stores a response and
   replays it for arbitrary duplicate submissions, and it does **not** state that reuse prevents
   duplicate provider-side execution in the general case. **Velora must not assume exactly-once
   provider-side execution from this header.**

### Answers to the D-7 question set

| # | Question | Answer | Basis |
|---|---|---|---|
| 1 | Exact mechanism | `transaction-id` request header | E-1, E-2 |
| 2 | Header or other field | **Header** | E-1, E-2 |
| 3 | `transaction-id` / `Idempotency-Key` / other / none | **`transaction-id`**; `Idempotency-Key` is **not documented by MetaAPI** | E-1, E-2 + negative search |
| 4 | Which operations | Create account; create account replica. **Not** deploy/delete/update; **not** history-deals | E-1…E-6 |
| 5 | Deduplication scope | **NOT DOCUMENTED** beyond 202-polling | — |
| 6 | Same value resubmitted | Documented **only** for 202 → polls the earlier request. Otherwise **NOT DOCUMENTED** | E-1 |
| 7 | Documented safe for retries | **Yes, for the 202 polling flow specifically** | E-1, E-7 |
| 8 | Retention / lifetime | **NOT DOCUMENTED** | — |
| 9 | Applies to Velora's historical sync | **No — the endpoint documents no such header** | E-3 |
| 10 | Prevents duplicate execution, or merely identifies? | Documentation establishes **identification + polling**; duplicate-execution prevention is **NOT PROVEN** | E-1 |
| 11 | Documented limitations / must-not-use | Not documented as forbidden anywhere; it is simply **absent** from the read path and from deploy/delete/update | E-3…E-6 |

### Velora integration implication

**The sync path needs no external idempotency mechanism, and none exists.** Velora's planned
historical/incremental sync reads `GET .../history-deals/time/{from}/{to}` (E-3) — a **safe,
idempotent read** that creates no provider-side state. Re-issuing it cannot duplicate anything at
the provider. Duplicate protection for imported fills is therefore **entirely Velora's
responsibility**, which the D-6 substrate already discharges.

**The `Idempotency-Key`/`transaction-id` mismatch is resolved as a legacy defect.** The legacy PHP
system sends `Idempotency-Key` on three **provisioning** calls — account create, deploy and delete
(`MetaApiService.php:809`, `:828`, `:870`). Against current documentation: the header name is wrong
on all three, and on deploy/delete **no** such header is documented at all. Any future Velora
provisioning implementation must send **`transaction-id`** on account creation, **not**
`Idempotency-Key`. **No legacy code is modified by this decision** (legacy is out of scope).

**Deferred implementation note — value format.** The documentation specifies a **random
32-character** value. Legacy derives a deterministic SHA-256-based value and prefixes it
(`'velora-' . $operationKey`), which is neither 32 characters nor random. A future provisioning
implementation must satisfy the documented format; whether a deterministic value may be reused
across retries outside the 202 flow is **NOT PROVEN** and must not be assumed.

**Safe design consequence.** Because general dedup semantics are unproven, a future provisioning
implementation must **reconcile provider state before retrying** rather than trusting the header to
deduplicate — the approach legacy already documents (*"Provision once or reconcile before reusing
the stable provider idempotency key"*, `MetaApiService.php:303`). This is recorded as a
**constraint on future implementation**, not as authorization to build it.

### Velora-internal vs MetaAPI-external idempotency — NOT the same thing

| | **A. Velora database idempotency** | **B. MetaAPI request-level idempotency** |
|---|---|---|
| Mechanism | `UNIQUE (account_id, external_deal_id)` on `sync_fills`; `trades_extdeal_unique`; `trade_events_uid_unique` | `transaction-id` header |
| Enforced by | **Velora's PostgreSQL**, proven by executed test (D-6, 23505 on replay) | **MetaAPI**, semantics only partly documented |
| Failure mode solved | A provider deal imported twice becomes **one** domain row | A provisioning **write** retried after an ambiguous response |
| Applies to the sync read path | **Yes** | **No** (E-3) |

**These are not substitutes.** Velora's constraint is a **VERIFIED internal guarantee** and is
**never** to be presented as a MetaAPI provider-level guarantee. Conversely, `transaction-id`
offers **no** protection against duplicate *domain* records — only Velora's constraints do.

### Explicit non-goals

This decision authorizes **no** implementation. Not authorized: MetaAPI client, provisioning
route, connect flow, historical or incremental sync, webhook ingestion, retry/rate-limit policy,
SDK adoption, any migration or schema change, any runtime code, any deployment, any authenticated
provider call, and any modification of legacy PHP. **No ADR is amended** (rule 11).

### Confidence / evidence level

| Claim | Level |
|---|---|
| Header is named `transaction-id` and is Required on account + replica creation | **VERIFIED** (E-1, E-2 fetched) |
| `Idempotency-Key` is not a documented MetaAPI mechanism | **VERIFIED** (absent from official docs; searched) |
| History-deals read documents no idempotency header | **VERIFIED** (E-3 fetched) |
| Deploy / delete / update document no `transaction-id` | **VERIFIED** (E-4, E-5, E-6 fetched) |
| Reusing the value after 202 polls the earlier request | **VERIFIED** (E-1 verbatim) |
| General duplicate-submission behaviour outside 202 | **NOT PROVEN** |
| Retention / lifetime of a transaction id | **NOT PROVEN** |
| Exactly-once provider-side execution guarantee | **NOT PROVEN — must not be assumed** |

**Residual open fact.** Whether resubmitting a completed (`201`) request with the same
`transaction-id` is deduplicated, and for how long such state is retained, is **not established by
current documentation**. It is **not required** for the sync path (E-3) and therefore **blocks
nothing that is currently authorized**. It must be resolved — by provider support or by the owner —
**before** any provisioning/connect implementation relies on provider-side deduplication.

---

## 2F. Owner decisions — OD-MP-1, OD-MP-2, OD-MP-3 (ratified 2026-09-16)

**Scope of this section: AUTHORIZATION ONLY.** Each decision below changes the *permission
state* of a future change. None of them is implemented, and this amendment implements none of
them. Where a prior section of this record said these things were "NOT unlocked" or "Still NOT
authorized", **this section supersedes that text** and the superseded statements have been
corrected in place (§5, §6, §7, §9, §10) so the document carries no contradiction.

**Evidence basis (read-only audit, 2026-09-16, HEAD `029a9769`):** `CredentialStore.reveal(id,
userId)` is declared at `apps/api/src/credentials/credentialStore.ts:116` and implemented at
`apps/api/src/credentials/pgCredentialStore.ts:143-152`, and has **zero production callers** —
verified by `git grep "\.reveal(" -- apps/**` excluding tests. `CREDENTIAL_MASTER_KEY` is read
only under `apps/api/src/credentials/`; in `apps/worker/**` it appears solely inside prohibition
comments. `trading_accounts.metaapi_account_id` (migration `0013:45-73`) has **no production
writer**. The audit-log action vocabulary is closed at five values
(`0011_audit_log_credential_events.sql:60-68`).

---

### OD-MP-1 — API-side MetaAPI provisioning authorization

**Previous status:** NOT AUTHORIZED (§9 "connect/provisioning route", "credential reveal in any
form"). **New status: AUTHORIZED FOR FUTURE IMPLEMENTATION.**

An authenticated, **user-scoped** Modern API flow **may** consume the requesting user's broker
credentials through the existing encrypted credential boundary, **for the sole purpose of
MetaAPI account provisioning and account binding**.

Binding rules — all thirteen are conditions of the authorization, not guidance:

1. The operation **MUST** always be scoped to `claims.sub`.
2. The client **MUST NOT** supply an arbitrary user ID.
3. Admin and System Owner privileges **MUST NOT** create a generic credential-reveal or
   credential-consumption capability for another user.
4. `CredentialStore.reveal(id, userId)` **remains owner-scoped** and its signature is unchanged.
5. The API may consume the credential **only inside the future provisioning application
   service** — nowhere else.
6. Plaintext credentials **MUST NEVER** be: persisted · logged · written into audit rows ·
   placed on `QueuePort` · placed in pg-boss payloads · placed in DLQ payloads · exposed in an
   HTTP response · made available to the Worker.
7. The Worker remains **credential-free**.
8. The Worker **MUST** continue to use only `METAAPI_PLATFORM_TOKEN`, `metaapi_account_id`, and
   other non-secret sync identifiers.
9. The future provisioning flow may persist **only** the resulting `metaapi_account_id` and
   other explicitly approved **non-secret** account metadata.
10. This authorization does **NOT** authorize any generic `revealAny`, `adminReveal`, or System
    Owner credential-access API.
11. This authorization does **NOT** authorize credential disclosure to administrators.
12. The provisioning route must be **user-scoped and ownership-based**.
13. This authorization applies to **MetaAPI provisioning only**. It does not authorize unrelated
    providers or any other credential-consumption path.

**Authorized architecture (unchanged from the audited design):**

```
API:     claims.sub → user-scoped account → CredentialStore.reveal(credentialId, userId)
           → MetaAPI provisioning → metaapi_account_id → short DB transaction → binding
Worker:  METAAPI_PLATFORM_TOKEN + metaapi_account_id → historical sync
```

**Explicitly still forbidden by OD-MP-1:** moving provisioning into the Worker · introducing a
credential broker · introducing Redis · introducing a new queue for provisioning (absent a
future Owner Decision) · holding a database transaction open across a MetaAPI HTTP request.

**What OD-MP-1 does NOT do:** it creates no route, no client, no service, no call site. D-2
(§2A) is untouched and still governs the worker boundary: provisioning is API-hosted and
credential-consuming, synchronization is worker-hosted and credential-free.

---

### OD-MP-2 — Audit vocabulary for authorized credential consumption and binding

**Previous status:** NOT AUTHORIZED (§5 non-decision 11; §9 "`CREDENTIAL_REVEALED` /
`CREDENTIAL_USED` audit events"; ADR-016 Future Work 1). **New status: AUTHORIZED FOR FUTURE
IMPLEMENTATION.**

Widening the append-only audit vocabulary is authorized **so that the future provisioning
implementation can record security-relevant lifecycle events**.

**Existing vocabulary (verified, `0011:60-68` and `apps/api/src/auth/auditStore.ts:41-50`):**
`OWNERSHIP_CLAIMED` · `USER_ROLE_CHANGED` · `USER_STATUS_CHANGED` · `CREDENTIAL_CREATED` ·
`CREDENTIAL_DELETED`, with `outcome IN ('success','denied')`.

**Authorized future action vocabulary — exactly two new names:**

| Action | Records | Why it is necessary |
|---|---|---|
| **`CREDENTIAL_USED`** | An authorized, owner-scoped consumption of a stored credential by the provisioning service. `outcome='success'` = the credential was used; `outcome='denied'` = the attempt was refused. | The security event is *use of the secret to act against an external system on the owner's behalf*, which is the event ADR-016 §"Application authority does not imply secret disclosure authority" cares about. |
| **`ACCOUNT_BINDING_CHANGED`** | Establishment or removal of the Velora ↔ MetaAPI binding (`before_state`/`after_state` carry the binding state, never a secret). | Binding and unbinding change which external account a Velora account is attached to. The existing `before_state`/`after_state` columns already express exactly this shape, as they do for `USER_ROLE_CHANGED`. |

**Rationale for `CREDENTIAL_USED` over `CREDENTIAL_REVEALED` — required by the owner directive.**
`CREDENTIAL_REVEALED` is rejected. Three reasons, each grounded in existing repository text:
(a) `0011:58-59` and `auditStore.ts:46-48` state that name was *deliberately* omitted because
"reveal has no production consumer, and an action nothing can emit is dead contract surface" —
the omission was about *disclosure*, and OD-MP-1 does not authorize disclosure; (b) "revealed"
describes a secret being **shown to somebody**, which OD-MP-1 explicitly forbids (rules 6, 10,
11), whereas what is authorized is **server-side use** with no human recipient — the action name
must not imply a disclosure capability the system does not have; (c) the existing vocabulary is
verb-past-tense on the object acted upon (`CREDENTIAL_CREATED`, `CREDENTIAL_DELETED`), so
`CREDENTIAL_USED` is the consistent construction.

**Deliberately NOT authorized — no redundant names.** Separate actions for
provisioning-succeeded, provisioning-failed, disconnect, and revocation are **rejected as
redundant**: `outcome` already distinguishes `success` from `denied`, `CREDENTIAL_DELETED`
already covers credential revocation, and `ACCOUNT_BINDING_CHANGED` covers both directions of
binding via `before_state`/`after_state`. The five required distinctions in the owner directive
are satisfied by **two new actions plus the existing `outcome` column**:

| Required distinction | Representation |
|---|---|
| Successful credential use for provisioning | `CREDENTIAL_USED` + `outcome='success'` |
| Refused/denied credential use | `CREDENTIAL_USED` + `outcome='denied'` |
| Successful MetaAPI account binding | `ACCOUNT_BINDING_CHANGED`, `after_state` = bound |
| Security-relevant failed provisioning/binding | `CREDENTIAL_USED` + `outcome='denied'` |
| Disconnect / revocation (per OD-MP-3) | `ACCOUNT_BINDING_CHANGED`, `after_state` = unbound; credential revocation stays `CREDENTIAL_DELETED` |

Requirements binding the future implementation:

1. Audit rows carry **metadata only**.
2. Plaintext passwords, investor passwords, credential ciphertext, access tokens, auth tokens
   and provider secrets **MUST NEVER** be stored in an audit row.
3. The audit record **MUST NOT** become a credential-disclosure mechanism.
4. Existing **append-only** semantics are unchanged.
5. Existing **actor/ownership** semantics are unchanged — `actor_user_id` stays server-derived.
6. The current frozen audit guarantees are preserved; widening is **additive only**.
7. Any migration widening `audit_log.action` must be **additive and migration-safe**, following
   the `0011` pattern (`DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT` with the full value list;
   existing rows remain valid).
8. Per AGENTS.md rule 11, ADR-016 and this document are amended **in the same change as the
   implementation** of the audit widening. ADR-016 is amended by the present change to record
   the authorization itself; the *implementation* amendment lands with the code.

> **MIGRATION REQUIRED IN THE IMPLEMENTATION COMMIT.** The schema is **deliberately unchanged**
> here. Widening the `audit_log.action` CHECK and the `AuditAction` union is an **implementation
> concern**, not a governance artifact: this record's own convention (D-3, D-5, A-1 — "no
> migration now; it lands with the implementation under rule 11") applies unchanged. No
> migration file is created or modified by this amendment.

---

### OD-MP-3 — Disconnect / revocation semantics

**Previous status:** UNDECIDED — the 2026-09-16 audit recorded disconnect semantics as
`NOT VERIFIED — no governance decision found`. **New status: AUTHORIZED FOR FUTURE
IMPLEMENTATION.**

**A. User-facing disconnect means:** remove the Velora ↔ MetaAPI account binding; prevent future
synchronization for that Velora account; and revoke/delete the provider-side MetaAPI account
**only if** the future implementation explicitly performs provider deletion as part of the
approved disconnect operation.

**B. Imported trades survive disconnect.** Historical Velora trades already imported from MetaAPI
**MUST NOT** be physically deleted as a side effect of disconnect.

**C.** Existing immutable trade/event semantics (ADR-002 D-01: immutable ledger, correction
events, tombstone deletion, append-only events) remain **authoritative and unchanged**.

**D.** Disconnect **MUST NOT** silently rewrite historical P/L, timestamps, provenance, or trade
events.

**E.** `metaapi_account_id` may be cleared **only** through the future authorized disconnect
operation, and **only after** its exact provider-side behaviour has been determined.

**F. Three separate lifecycle operations — MUST NOT be conflated:**

| Operation | Effect | Not implied by the others |
|---|---|---|
| **Local unbinding** | Clears the Velora ↔ MetaAPI binding; stops future sync | Does not delete the provider account, does not delete the credential |
| **Provider deletion** | Deletes the MetaAPI-side account | Does not by itself unbind locally, does not delete the credential |
| **Credential deletion / revocation** | Removes the stored `user_credentials` row (existing hard delete, `CREDENTIAL_DELETED`) | Does not unbind, does not delete the provider account |

**G.** If provider deletion is performed, **404 / not-found handling must be explicitly defined
by the implementation and tested.**

**H.** Disconnect remains **user-owned**: it must never allow an admin or System Owner to use
another user's credentials.

**I.** **No automatic physical deletion of imported trades is authorized.**

**What OD-MP-3 does NOT do:** it implements no `DELETE` behaviour, no disconnect route, no
provider-deletion call, and no clearing of `metaapi_account_id`. ADR-002 is **not amended** — its
immutability guarantees already produce the required outcome, and OD-MP-3 adds no exception to
them.

---

### Status summary for OD-MP-1 … OD-MP-3

| Decision | Previous state | New state | Implemented? |
|---|---|---|---|
| **OD-MP-1** API-side provisioning + owner-scoped credential consumption | NOT AUTHORIZED | **AUTHORIZED FOR FUTURE IMPLEMENTATION** | **NO** |
| **OD-MP-2** `CREDENTIAL_USED` + `ACCOUNT_BINDING_CHANGED` audit vocabulary | NOT AUTHORIZED | **AUTHORIZED FOR FUTURE IMPLEMENTATION** | **NO — migration deferred to the implementation commit** |
| **OD-MP-3** Disconnect / revocation semantics | UNDECIDED | **AUTHORIZED FOR FUTURE IMPLEMENTATION** | **NO** |

**No code, no route, no client, no service, no schema, no migration, no privilege change, no
worker change, no Railway change, and no deployment is produced by this amendment.**

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
9. ~~**The `transaction-id` vs `Idempotency-Key` provisioning header question**~~ — **RESOLVED
   2026-09-15 (§2E)**: official documentation requires **`transaction-id`** on account/replica
   creation; **`Idempotency-Key` is not a documented MetaAPI mechanism**, so the legacy header is a
   legacy defect. Still **not decided here**: general duplicate/retention semantics (**NOT
   PROVEN**), and any provisioning implementation.
10. **Webhook ingestion** (ADR-008 remains "Implementation not started").
11. ~~**Credential disclosure auditing** (`CREDENTIAL_USED` or equivalent) — still DEFERRED.~~
    **SUPERSEDED 2026-09-16 by OD-MP-2 (§2F).** Audit vocabulary for *authorized credential use*
    (`CREDENTIAL_USED`) and for *binding changes* (`ACCOUNT_BINDING_CHANGED`) is now **authorized
    for future implementation**. Note the corrected framing: the authorized event is credential
    **use**, not credential **disclosure** — disclosure remains forbidden (OD-MP-1 rules 10-11).
    The migration is deferred to the implementation commit; **no schema change here**.
12. **Key rotation** — remains deferred by ADR-016.

---

## 6. Deferred implementation decisions

| ID | Decision required | Blocks | Constraint it must satisfy |
|---|---|---|---|
| **D-1** | ~~Platform MetaAPI token storage mechanism~~ — **RATIFIED 2026-09-15 by ADR-014 (D-19)**: environment-supplied `METAAPI_PLATFORM_TOKEN` + `METAAPI_BASE_URL`, resolver-validated (`MA-001`…`MA-003`), fail-closed capability-absent. | ~~MetaAPI connect~~ | Satisfied by ADR-014 §2–§5. Implementation remains Phase 3 |
| **D-2** | ~~Worker credential-consumption mechanism (A / B / C / D)~~ — **RATIFIED 2026-09-15: Boundary-Scoped Option B** (§2A). Provisioning is API-hosted and credential-consuming; synchronization is worker-hosted and credential-free, using `METAAPI_PLATFORM_TOKEN` + `metaapi_account_id`. | ~~Worker-side sync~~ | Satisfied: no broad `SELECT`, no plaintext in payloads, no ciphertext to the worker, ADR-016 isolation preserved. No broker, no migration, no `roles.sql` change |
| **D-3** | ~~`TRADE_IMPORTED` final actor set (and the home of migration-origin semantics)~~ — **RATIFIED 2026-09-15: final set is `["system", "sync"]`** (§2C). `system` = migration/system-origin provenance; `sync` = provider-synchronization provenance. Not collapsed, `system` not removed, **no new actor** (`migration`/`importer`/`legacy`/`backfill` forbidden), no other actor set changed, `TRADE_CREATED` unchanged. | ~~Trade import~~ | Satisfied: A-1 already ratified the set; the `0001` actor CHECK already permits both, so **no migration**. Domain widening still lands with the trade-import code (rule 11) |
| **D-4** | ~~Whether a diagnostic PnL value is retained, and where~~ — **RATIFIED 2026-09-15: provider-reported profit is authoritative and populates the existing canonical `net_pnl`** (§2B). No second PnL column; no persisted local-vs-provider comparison; local calculation, if ever performed, is diagnostic only and never overwrites the provider value. | ~~Trade import~~ | Satisfied: one canonical persisted value, `profitLoss` API contract unchanged, manual-trade behaviour unchanged, **no migration**. Persisted diagnostic values remain a separate Owner Decision |
| **D-5** | ~~Durable storage for naive `brokerTime` evidence~~ — **RATIFIED 2026-09-15: preserved verbatim in a DEDICATED `broker_time_text` field, never interpreted** (§2D). `raw_time_text` keeps its existing meaning (verbatim absolute `time`) and is **not overloaded**: the provider returns `time` and `brokerTime` as two distinct fields in the same deal, so one column cannot hold both. | ~~Trade import~~ | Satisfied at decision level: evidence only, never parsed, no IANA inference, `occurred_at_utc` stays NULL. **No migration now** — the column is authorized in principle and lands with the trade-import implementation (rule 11) |
| **D-6** | Sync substrate: cursor (`last_synced_at`), operation reservation, fill ledger, `quarantined` column | Sync phases | Migrations, each separately justified |
| **D-7** | ~~Provisioning idempotency header (`transaction-id` vs `Idempotency-Key`)~~ — **RATIFIED IN PART 2026-09-15: the documented header is `transaction-id`** (§2E); `Idempotency-Key` is **not** a documented MetaAPI mechanism. The historical-sync read path documents **no** idempotency header and needs none. | ~~MetaAPI connect~~ (sync path unaffected) | Resolved from official docs, **no live call made**. **Residual NOT PROVEN:** duplicate/retention semantics outside the 202-polling flow — required only before a provisioning implementation relies on provider-side dedup |

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

**Unchanged by OD-MP-1 (§2F).** All ten constraints above survive the provisioning
authorization verbatim. OD-MP-1 authorizes **owner-scoped, server-side consumption inside one
application service** — it does **not** relax constraint 6 (no disclosure to System Owner, admin
or super_admin), constraint 7 (server-derived ownership), or constraint 8 (no generic credential
reveal endpoint, ever). Constraints 1-5 and 9-10 bind the future provisioning implementation as
written, and OD-MP-1 rule 6 restates them at the plaintext-lifetime level.

---

## 8. Required ADR amendments before implementation

**None of these is performed by this record.** Each must be ratified **before** the
implementation phase it gates, and — per AGENTS.md rule 11 — landed **in the same change**
as that implementation.

| # | Document | Exact amendment | Gates | Status |
|---|---|---|---|---|
| **A-1** | `docs/adr/ADR-002-trade-ledger.md` — *Ownership matrix* §Decision + *Amendment A-1* | **DONE 2026-09-15.** `TRADE_IMPORTED → ["system", "sync"]` ratified: `sync` is the controlled worker performing MetaAPI imports; `system` retained for migration-origin imports. Matrix row no longer "(proposed)". Limits recorded: no ownership bypass, no impersonation, no other actor set broadened, no credential access. **No migration required.** | OD-M3, trade import | **SATISFIED** |
| **A-2** | `docs/adr/ADR-004-time-model.md` — §Open Questions item 3 | Close *"MetaApi timestamp semantics in current sync code"* with TZ-M1: offset-explicit `time` → deterministic UTC; naive `brokerTime` never interpreted; no IANA inference; `source_timezone` NULL with provenance for MetaAPI rows. **Manual-trade behaviour unchanged.** **D-5 (§2D) adds the `broker_time_text` disposition to this amendment's required content.** | TZ-M1, D-5, trade import | **REQUIRED at implementation** |
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
  and timestamp semantics; **A-1, D-3, D-4, D-5 and D-6 are ratified**, and **D-7 is ratified in
  part** — the sync read path is confirmed to need no external idempotency mechanism. Remaining
  governance gates: **A-2/A-5** (at implementation, rule 11). **Implementation itself is still not
  authorized**, and the worker deployment decision (B10-a) is unchanged.

**NOT unlocked — implementation remains blocked** *(as written 2026-09-15; amended twice — see
§9.1 for Phase 2 and §9.2 for OD-MP-1…OD-MP-3)*:

MetaAPI client · provider routing · connect/provisioning route · account discovery ·
historical or incremental sync · webhooks · credential reveal in any form ·
`CREDENTIAL_REVEALED`/`CREDENTIAL_USED` audit events · any migration · any privilege change.

> **AMENDED 2026-09-16 (§9.2).** Three items in the list above are superseded by OD-MP-1 and
> OD-MP-2: the **connect/provisioning route**, **owner-scoped credential consumption** (never
> "reveal in any form" — disclosure stays forbidden), and the **`CREDENTIAL_USED` /
> `ACCOUNT_BINDING_CHANGED` audit vocabulary**. They are now **AUTHORIZED FOR FUTURE
> IMPLEMENTATION** and **remain unimplemented**. Every other item in the list is unchanged and
> still blocked.

### 9.1 Owner authorization — Phase 2 implementation (2026-09-16)

The owner **explicitly authorized implementation** of the historical-sync path,
superseding the "implementation remains blocked" list above **for the three
items named here and nothing else**:

| # | Decision | Effect |
| --- | --- | --- |
| 1 | **Scheduled producer is the production path** | Sync is triggered by a background schedule. **No user-facing manual-sync HTTP route** was added, and no endpoint was invented. A long MetaAPI call never runs inside an HTTP request. |
| 2 | **Dedicated `trading_accounts.metaapi_account_id`** | A new nullable column. `external_account_id` is **not** reused or overloaded and keeps its exact prior semantics. *This reverses the earlier audit conclusion that `external_account_id` was the mapping.* |
| 3 | **B8 write-model extension authorized** | `source='metaapi'`, `externalDealId` on the import path, provider P/L as authoritative `net_pnl`, `TRADE_IMPORTED` with actor `sync` — preserving ownership, idempotency, CAS, tombstone and ledger invariants. |

**Implemented under this authorization:** migration `0013`, the MetaAPI
history-deals client, deal normalizer, `sync_fills` → `trades` import path, the
pg-boss-scheduled producer, the `velora_worker` pg-boss grant model, and the
rule-11 amendments **A-2** (ADR-004) and **A-5** (ADR-002).

**Still NOT authorized** *(as written 2026-09-16 under Phase 2; partially superseded the same day
by §9.2)*: incremental/webhook sync, the connect /
provisioning route, account discovery, credential reveal in any form,
`CREDENTIAL_REVEALED` / `CREDENTIAL_USED` audit events, and **deployment of a
worker service (B10-a)**.

> **SUPERSEDED IN PART by OD-MP-1 / OD-MP-2 (§2F, §9.2).** The **connect/provisioning route**,
> **owner-scoped API-side credential consumption**, and the **`CREDENTIAL_USED` /
> `ACCOUNT_BINDING_CHANGED`** audit vocabulary are now **AUTHORIZED FOR FUTURE IMPLEMENTATION**
> and are **not implemented**. `CREDENTIAL_REVEALED` specifically remains **rejected** (see the
> OD-MP-2 rationale). **Still NOT authorized, unchanged:** incremental sync, webhook sync,
> account discovery, generic credential reveal/disclosure, and **worker-service deployment
> (B10-a)**.

**Scheduling mechanism — no new architecture was invented.** ADR-007 already
adopted pg-boss, and pg-boss 10.4.2 **ships a native cron scheduler**
(`boss.schedule(name, cron, data)`, persisted in `pgboss.schedule`, driven by
its internal `__pgboss__send-it` queue with `singletonSeconds: 60`). The
producer uses that. No second service, no host cron, and **no new npm
dependency** were introduced. `cron-parser` is already vendored as a pg-boss
dependency.

---

### 9.2 Owner authorization — MetaAPI provisioning governance (2026-09-16)

The owner **explicitly authorized** OD-MP-1, OD-MP-2 and OD-MP-3 (§2F), superseding the "NOT
unlocked" list above **for the items named here and nothing else**:

| # | Now authorized | Limit |
|---|---|---|
| 1 | **Connect / provisioning route**, authenticated and user-scoped to `claims.sub` | MetaAPI only; ownership-based; no client-supplied user ID |
| 2 | **API-side, owner-scoped credential consumption** inside the future provisioning application service | Not disclosure; no `revealAny`/`adminReveal`; no admin or System Owner access to another user's credential |
| 3 | **Audit vocabulary** `CREDENTIAL_USED` + `ACCOUNT_BINDING_CHANGED` | Metadata only; additive migration deferred to the implementation commit |
| 4 | **Disconnect / revocation semantics** (OD-MP-3) | Imported trades never physically deleted; unbinding, provider deletion and credential revocation stay separate |

**Unlocked for IMPLEMENTATION in a SEPARATE, FUTURE change — nothing here is implemented.**
This amendment adds no route, no client, no service, no call site, no migration and no test.

**Still NOT authorized** (unchanged by §9.2): incremental sync · webhook sync · account
discovery · any generic credential-reveal or admin-disclosure capability · moving provisioning
into the Worker · a credential broker · Redis · a new provisioning queue · holding a DB
transaction open across a MetaAPI HTTP call · **worker-service deployment (B10-a)**.

**Rule 11 disposition.** AGENTS.md rule 11 requires "ADR updates in the same change when a
decision is affected". This change affects ADR-016 (credential consumption + audit events), so
ADR-016 is amended in **this same change**. ADR-002, ADR-007, ADR-010 and ADR-014 are **not**
amended: no decision of theirs is altered — ADR-002's immutability guarantees already deliver
OD-MP-3 B/C/D, ADR-007 gains no job class, ADR-010's DB-identity model is untouched, and
ADR-014's platform-token separation is unchanged. The *schema* widening authorized by OD-MP-2
lands with its implementation, under the same rule 11 convention already used by D-3, D-5 and
A-1.

---

## 10. Remaining blockers

| ID | Blocker | Cleared by | State |
|---|---|---|---|
| **B1** | Credential model contradiction (platform vs user secret) | **OD-M1** | **RESOLVED at decision level**; storage mechanism open (D-1) |
| **B2** | Worker cannot reach credentials — no tsconfig reference, no dependency, no barrel export, and `velora_worker` holds `REVOKE ALL` on `user_credentials` | **D-2 (ratified 2026-09-15)** | **CLOSED — DISSOLVED.** Sync is credential-free, so no credential path is needed. The `REVOKE ALL` is correct and stays. A-4 not required |
| **B3** | `TRADE_IMPORTED` forbids actor `sync` (verified by executing `assertOwnership`) | **OD-M3 + A-1 (ratified 2026-09-15)** | **CLOSED (governance).** The domain still encodes `["system"]`; the one-line change is now AUTHORIZED and lands with the trade-import implementation (AGENTS.md rule 11). **No migration.** **D-3 is now RATIFIED (§2C)**: the final set is `["system", "sync"]`, with `system` = migration/system-origin and `sync` = provider-synchronization provenance |
| **B4** | No sync substrate: no `last_synced_at`, no operation reservation, no fill ledger, no `quarantined` column | **D-6** migrations | **OPEN** |
| **B5** | Three verified log/payload leak vectors (`runner.ts` `err.message`; `index.ts` event log; pg-boss persists payloads) | G-3 hardening | **OPEN — must close before plaintext egress** |
| **B6** | Provisioning idempotency header mismatch (`transaction-id` vs `Idempotency-Key`) | **D-7 (§2E, 2026-09-15)** | **CLOSED (governance) — mismatch resolved.** Official docs require **`transaction-id`**; `Idempotency-Key` is undocumented, so legacy is wrong. **Sync path unaffected** (no such header documented). Residual dedup/retention semantics remain **NOT PROVEN** and gate only a future provisioning implementation |
| **B7** | pg-boss never integration-tested; `pgBossAdapter.claim()` hardcodes `attempts: 0` | Worker phase | **OPEN / NOT PROVEN** |
| **B8** | Import write model cannot represent provider data — `TradeRecord.source` typed `"manual"`; `externalDealId` absent from the write model | G-4 / trade-import phase | **OPEN** |
| **B9** | Platform token has no governed storage | **D-1 + A-3** | **CLOSED (governance) 2026-09-15 — ADR-014 ratified.** Implementation pending Phase 3 |
| **B12** | No authorization for API-side credential consumption; `CredentialStore.reveal()` has **zero production callers** and `trading_accounts.metaapi_account_id` has **no production writer** (verified 2026-09-16 at HEAD `029a9769`) | **OD-MP-1 (§2F)** | **CLOSED (governance) 2026-09-16.** Owner-scoped API-side consumption for MetaAPI provisioning is authorized. **Implementation NOT started** — the route, client, service and binding write remain absent |
| **B13** | Audit vocabulary cannot express authorized credential use or binding changes (`0011:60-68` closes `action` at five values) | **OD-MP-2 (§2F)** | **CLOSED (governance) 2026-09-16.** `CREDENTIAL_USED` + `ACCOUNT_BINDING_CHANGED` authorized; `CREDENTIAL_REVEALED` rejected. **Migration deliberately deferred to the implementation commit** — schema unchanged here |
| **B14** | Disconnect/revocation semantics undecided (audit 2026-09-16: `NOT VERIFIED — no governance decision found`) | **OD-MP-3 (§2F)** | **CLOSED (governance) 2026-09-16.** Imported trades survive; unbinding / provider deletion / credential revocation are distinct. **No `DELETE` behaviour implemented** |

**MetaAPI implementation is NOT unlocked** *(as written 2026-09-15; amended — see below)*. Four
decisions of principle are recorded
(OD-M1…OD-M4 + TZ-M1), clearing B1 at the decision level. **D-1 (ADR-014) and D-2
(§2A) are now RATIFIED, and A-3 is satisfied**, which closes **B1, B9 and B2** at the
governance level.

> **AMENDED 2026-09-16 (OD-MP-1…OD-MP-3, §2F/§9.2).** The **provisioning and account-binding
> path is now unlocked at the governance level** — authorized for a **separate, future**
> implementation change. It is **NOT implemented**: no route, no provisioning client, no
> credential-consumption call site, no binding service, no disconnect behaviour and no migration
> exist at this HEAD. Sync-path implementation was separately authorized by §9.1. Everything
> else in this paragraph stands, and **B10-a (worker deployment) remains an unresolved Owner
> Decision**, so no MetaAPI capability is operational.

**Still outstanding before the first line of MetaAPI implementation code:** the operational
blockers below, plus **A-2/A-5** at their implementation phase. **D-3, D-4, D-5 and D-6 are
ratified** (§2C, §2B, §2D, migration `0012`), and **D-7 is ratified in part** (§2E) from official
documentation — the header question is settled and the sync read path needs no external
idempotency mechanism. **B10-a (worker deployment) remains an unresolved Owner Decision, so
MetaAPI implementation is still NOT unlocked.**
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
- **D-7 partial ratification (2026-09-15), recorded at HEAD `9504d4f`:** external idempotency
  contract established from **official MetaAPI documentation only** — no authenticated call, no
  provider-side mutation, no use of Velora credentials. Seven documentation pages were fetched in
  full (not search snippets): account create, replica create, history-deals read, deploy, delete,
  update, and the `AcceptedError` model. Findings: **`transaction-id` is a Required header on
  account and replica creation**; it is **absent** from deploy/delete/update and from the
  history-deals read; **`Idempotency-Key` is documented nowhere by MetaAPI**, so the legacy PHP
  header (`MetaApiService.php:809`, `:828`, `:870`) is a legacy defect. The **202-polling** retry
  semantics are documented verbatim; **general duplicate and retention semantics are NOT PROVEN**
  and are explicitly recorded as such. Velora's `(account_id, external_deal_id)` uniqueness is
  recorded as an **internal** guarantee and is **not** presented as a provider guarantee.
  **Governance only: no code, no schema, no migration, no ADR amendment, no legacy modification.**
- **D-5 ratification (2026-09-15), recorded at HEAD `9d739fa`:** naive `brokerTime` evidence
  semantics settled (§2D). Claims verified before recording: `raw_time_text` is a nullable,
  **unconstrained** TEXT column at `0012:134` documented at `0012:125-132` as the verbatim copy of
  the **offset-explicit** `time`; **no CHECK references it**; the provider supplies `time` and
  `brokerTime` as two distinct fields in the same deal, proven by
  `MetaApiService.php:206-209` (separate extraction), `MetaApiFillRepository.php:44-48,77-78`
  (separate bind parameters, same INSERT) and the history-deal fixture at
  `MetaApiService.php:898-917` (both present per deal); the legacy schema carries a dedicated
  `broker_time_text` column (`v1.1_metaapi_fill_ledger.sql:42`) commented *"naive brokerTime,
  evidence only"*; and `0012:130-132` explicitly deferred this column to D-5. Conclusion:
  `raw_time_text` is **semantically insufficient**, so a dedicated `broker_time_text` is
  **REQUIRED but NOT created here**. **Governance only: no code, no schema, no migration, no ADR
  amendment. ADR-004 unchanged; A-2 remains deferred under rule 11.**
- **D-3 ratification (2026-09-15), recorded at HEAD `94adf60`:** migration-origin semantics
  settled (§2C). Final actor set `TRADE_IMPORTED → ["system", "sync"]` — unchanged from A-1;
  D-3 fixes the *meaning* of each actor rather than the membership. Claims verified before
  recording: the `0001_core.sql:117` actor CHECK already permits all five actors and the
  `type` CHECK already contains `TRADE_IMPORTED`, so **no migration was created to restate a
  valid constraint**; `packages/contracts/src/trades.ts:54` documents `TRADE_IMPORTED` as a
  *"migration origin event"*, which is the repository evidence for retaining `system`;
  `tradeLedger.ts:85` shows `system` is also load-bearing for `QUARANTINE_RAISED`; and no
  production code emits `TRADE_IMPORTED` today. **Governance only: no code, no schema, no
  migration, no privilege change. D-4, D-7 and A-2 untouched.**
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
- **OD-MP-1 / OD-MP-2 / OD-MP-3 ratification (2026-09-16), recorded at HEAD `029a9769`:**
  API-side MetaAPI provisioning authorization, the audit vocabulary for authorized credential
  use and binding changes, and disconnect/revocation semantics (§2F, §9.2). These decisions
  **supersede** the prior "NOT authorized" statements in §5 (non-decision 11), §9 and §9.1, and
  supersede the read-only audit's `BLOCKED — OWNER DECISION REQUIRED` classification **at the
  governance level only**. Claims verified before recording, by read-only inspection at this
  HEAD: `CredentialStore.reveal(id, userId)` declared at `credentialStore.ts:116`, implemented
  at `pgCredentialStore.ts:143-152`, with **zero production callers**; `CREDENTIAL_MASTER_KEY`
  read only under `apps/api/src/credentials/` and present in `apps/worker/**` only as
  prohibition comments; `trading_accounts.metaapi_account_id` (`0013:45-73`, nullable, CHECK
  `^[A-Za-z0-9._:-]{1,64}$`, global partial UNIQUE) with **no production writer** — both
  `pgAccountStore` INSERTs (`:108`, `:152`) omit it; the audit action CHECK closed at five
  values (`0011:60-68`) mirrored by `auditStore.ts:41-50`, with `outcome IN
  ('success','denied')`; and `0011:58-59` / `auditStore.ts:46-48` recording that
  `CREDENTIAL_REVEALED` was deliberately omitted — which is why OD-MP-2 selects
  **`CREDENTIAL_USED`** instead. **Governance only: no code, no route, no client, no service, no
  schema, no migration, no privilege change, no worker change, no Railway change, no deployment,
  no database write.** ADR-016 is amended in the same change (rule 11); ADR-002, ADR-007,
  ADR-010 and ADR-014 are unchanged because no decision of theirs is affected.
- **This record changes no schema and no code.** *(Originally "no ADR, no schema, no code";
  corrected 2026-09-16 — the OD-MP amendment also amends **ADR-016**, as AGENTS.md rule 11
  requires when a decision affects an ADR. No other ADR is touched, and no schema or code is
  changed by any amendment to this document.)* Where it differs from any
  recommendation in the readiness audit, **this record is authoritative**; audit
  recommendations were not converted into decisions unless the owner approved them above.
