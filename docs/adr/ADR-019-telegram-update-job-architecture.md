# ADR-019 — Telegram update processing over the job architecture

Status: **Accepted for the repository architecture** (queue path implementation and
its test battery were recorded at `e041856`; **live worker execution is
DEPLOYMENT_GATED** — see §Decision 6 and §Consequences). This acceptance does **not**
approve any credential-provisioning change to D-2.
Date: 2026-10-08 (D-2 clarification: 2026-10-10)
Supersedes: nothing. Extends: ADR-007 (job semantics / pg-boss), ADR-008 (webhook
ingestion), ADR-017 (agent-context state), **ADR-018** (Telegram journal client).
Proposes an owner-gated amendment to the worker credential boundary recorded in
`apps/worker/src/index.ts` (D-2, Boundary-Scoped Option B); no amendment is
ratified by this ADR.

## Context

ADR-018 established the Telegram journal client and left one property deliberately
unresolved (gap `MG-TG-3`):

> Telegram work runs synchronously in the API process (deferred after the webhook
> 200). A long media download plus a model call therefore occupies an API request
> slot after the answer.

The pre-ADR-019 sequence was:

```
POST /api/v1/webhooks/telegram
  → verify X-Telegram-Bot-Api-Secret-Token
  → validate against the frozen contract schema
  → claim the update_id            (telegram_updates, idempotency)
  → answer 200
  → setTimeout(() => bot.processClaimed(update))   ← still inside the API process
```

The claim made the early 200 safe. What it did not do was release the process: a
voice-note transcription plus a model call kept an API slot occupied for seconds
after Telegram had already been answered. With one slow update in flight per slot,
enough concurrent traffic turns a latency problem into an availability one.

Two constraints shaped every option considered:

1. **One Telegram architecture.** ADR-018's central requirement is that Telegram
   is not a second product. Any solution that re-implemented journaling,
   ownership, linking or AI governance for the worker path would be a regression
   dressed as an improvement.
2. **`apps/worker` is not deployed anywhere.** `MG-WORKER-DEPLOY` is open and the
   hosting decision is owner-gated. The worker process exists, runs locally, and
   is proven against a real PostgreSQL and a real pg-boss — but no service hosts
   it.

## Options considered

### Option A — keep the in-process `setTimeout` defer
Rejected. It is the status quo and the defect. It also has no durability: a crash
between the claim and the completion leaves the update row claimed and
unprocessed, recoverable only because the row is visible — not because the work
survived.

### Option B — a second Telegram consumer inside the worker
Rejected outright. It would duplicate `TelegramBot`, the journal application
service and the AI governance layer, and the two copies would drift the first
time either changed. This is exactly the "second product" ADR-018 forbids.

### Option C — move the update through the existing job architecture *(chosen)*
`Telegram update → API/webhook boundary → pg-boss → Worker → the one TelegramBot`.

ADR-007 already adopted pg-boss and the worker already consumes job classes
through a typed `HandlerRegistry` with a `SafeJobPayload` constraint. Reusing
that seam adds **no new dependency, no new service concept and no new failure
vocabulary**; it only changes *which process* finishes a claimed update.

### Option D — a dedicated Telegram microservice / separate repository
Rejected. It would split the journal domain from the ADR-002 ledger and create a
second deployment, a second secret store and a second ownership model — for a
workload measured in seconds per message.

## Decision

**Adopt Option C**, with six binding terms.

### 1. One job class, one safe payload
`TELEGRAM_UPDATE_JOB_CLASS = "telegram.update"`. The payload
(`TelegramUpdatePayload`) extends `SafeJobPayload`, so it may only contain flat
scalars — the compiler rejects a nested or credential-shaped payload. The update
travels as `updateJson` (a JSON string) because pg-boss **persists** payloads into
retries and the dead-letter queue; a nested object is precisely how a credential
or a provider response body would arrive.

### 2. Idempotency is the update id, in both systems
`idempotencyKey = telegram.update:<update_id>` — the **same identity** the
`telegram_updates` primary key uses. Queues are created with the pg-boss
`stately` policy, so a repeated `singletonKey` returns `null` instead of inserting
a second row. The two mechanisms therefore agree on what "the same update" means
rather than each inventing a notion of it.

### 3. Claim precedes enqueue
`TelegramUpdatePipeline.acceptDeferred` claims the update **first** and hands the
**already-claimed** update to the queue second. The worker calls
`processClaimed`, never `handleUpdate`: it finishes a claimed update and never
claims one a second time.

This ordering is the safety property, not an implementation detail. A Telegram
retry that arrives before the job row exists is recognised as a duplicate at the
HTTP layer and never becomes a second job; a retry that arrives after is
recognised by both the claim and the `stately` singleton key.

### 4. Queue failure falls back in-process, but only an accepted job is crash-durable
If enqueue returns false or throws, the pipeline logs a **code**, never provider
text, and selects the pre-ADR-019 in-process `processClaimed` path. In a live API
process that path attempts the already-claimed update; it is **not** a durable
queue substitute and cannot guarantee completion across an API process crash.
The claimed row remains observable, but Telegram retries are treated as duplicates.
Therefore the queue path is the durable execution contract; the fallback is a
best-effort availability measure and must not be described as crash-proof or
exactly-once across a process failure.

### 5. The worker composes the same bot, from a second composition root
The worker is a separate process and cannot reach the API's object graph, so
`apps/api/src/telegram/telegramProcessorFactory.ts` composes the **same**
`TelegramBot` (journal application service, AI coaching pipeline, link service,
first-trade mail and achievement) over one pool.

This is a second *composition root*, not a second architecture. Every rule —
validation, the ADR-002 ledger fold, ownership, consent gating, the attempt
ledger — still lives in the one implementation. The factory also composes the
first-trade notifier, because moving Telegram onto the queue must not silently
drop an email or an achievement that the HTTP path sends.

### 6. The handoff is default OFF, and that default is the safety property
* The API enqueues only when `TELEGRAM_QUEUE_ENABLED=true`.
* The worker registers the `telegram.update` handler only when it can compose a
  processor, which requires `TELEGRAM_BOT_TOKEN`.
* The base D-2 worker credential scope remains `DATABASE_URL` plus
  `METAAPI_PLATFORM_TOKEN`. A Telegram processor may additionally consume
  `TELEGRAM_BOT_TOKEN`; optional AI/mail processing may consume environment-only
  provider settings (`GEMINI_API_KEY`, `GEMINI_RELAY_URL`,
  `GEMINI_RELAY_TOKEN`, `RESEND_API_KEY`, with `APP_ORIGIN` and
  `SUPPORT_NOTIFY_EMAIL` as non-secret configuration). **Supplying any such
  additional secret to the worker is a proposed D-2 amendment and requires an
  explicit owner decision for the exact process/environment allowlist.** This
  ADR does not supply or provision them.

Rationale: **a job enqueued into a queue nobody consumes is an update that was
claimed and never processed** — a silent regression, strictly worse than the
latency the queue removes. Turning the handoff on is therefore a deployment
precondition, not a config convenience.

`apps/worker/src/index.ts` logs `telegram.worker_gated` with the reason when the
processor is absent, and registers nothing: the same fail-closed rule the MetaAPI
sync handler applies to a missing platform token. The processor's AI resolver is
environment-only; it does not import credential decryption, does not use
`CREDENTIAL_MASTER_KEY`, and cannot read the encrypted API-managed
`ai_platform_secrets` table. `db/roles.sql` revokes every worker privilege on that
table while preserving API-role DML. The new PG-role assertions are code evidence
only until run on the disposable real-PostgreSQL workflow; this sweep did not
apply privileges to any database.

## Consequences

### Positive
* The API process is released as soon as the job row is durable.
* With a successful queue handoff, durability moves from "a `setTimeout` in a
  process that may die" to a pg-boss row with ADR-007 retry/backoff/DLQ
  semantics, so a failure is retried within the class policy and then made
  visible in `velora.dlq`. The process-local fallback on enqueue failure is not
  covered by that guarantee.
* No new dependency, service, or Telegram rule.

### Negative / accepted
* **A second composition root must be kept in step** with `server-main.ts`. The
  risk is bounded by the worker test file, which builds its descriptors from the
  API's own `buildTelegramUpdateDescriptor`, so a producer/consumer disagreement
  fails the suite rather than production.
* **`attachments` is not composed in the worker factory.** With no attachment
  service a journal screenshot is recorded as metadata only and the entry still
  saves — `TelegramBot` documents this. Wiring attachments is a deployment step,
  recorded here rather than hidden.
* **End-to-end latency can increase** when the queue is healthy but the worker is
  busy. This is the intended trade: bounded API latency over unbounded worst-case
  message latency.

### Still open — owner and deployment gates, not missing queue architecture
1. **`MG-WORKER-DEPLOY` (`DEPLOYMENT_GATED`).** No service hosts the worker. Until
   one does, the queue handoff stays off by design; this ADR does not change the
   deployment topology.
2. **D-2 credential boundary (`OWNER_DECISION_REQUIRED`).** The owner must approve
   or reject the exact additional worker environment-secret allowlist before any
   deployment supplies it: `TELEGRAM_BOT_TOKEN`, optional `GEMINI_API_KEY` /
   `GEMINI_RELAY_TOKEN` (and the relay URL), and optional `RESEND_API_KEY`.
   `APP_ORIGIN` and `SUPPORT_NOTIFY_EMAIL` are configuration, not credentials.
   The worker must never receive `CREDENTIAL_MASTER_KEY`, per-user broker
   credentials/ciphertext, or decrypted per-user credentials. AI secret lookup in
   the worker is environment-only; encrypted `ai_platform_secrets` remain
   API-only, with worker access revoked in `db/roles.sql`. The new role-test
   assertions are **not run in this worktree** and no database role was changed.
3. **Live verification (`DEPLOYMENT_GATED`).** No Telegram round trip exists. A
   passing unit test is not live verification; no token was supplied, webhook
   registered, service deployed, or live journal entry observed in this sweep.

## Compliance

| ADR | How this change complies |
|---|---|
| ADR-007 | Reuses pg-boss, `SafeJobPayload`, `DEFAULT_JOB_POLICIES`, retry/backoff/DLQ. No second scheduler. |
| ADR-008 | Webhook ingress remains the only inbound surface; signature verification and body caps are unchanged. |
| ADR-009 | The user's locale is still resolved per message from `users.locale`; the worker reads the same column. |
| ADR-013 | No origin is hardcoded; `APP_ORIGIN` and the Telegram app URL are still read from the environment. |
| ADR-017 | `MG-TG-3` moves `OPEN/STATIC` → `PARTIAL/RECORDED_RUNTIME`; the gap register and `CHANGE_LOG` are updated in the same change. |
| ADR-018 | One identity bridge (`TelegramLinkService`), one journal domain, one AI boundary. No rule duplicated. |

## Evidence

| Claim | Evidence |
|---|---|
| Contract | `packages/contracts/src/telegram.ts` (`TELEGRAM_UPDATE_JOB_CLASS`, `TelegramUpdatePayload`) |
| Producer | `apps/api/src/telegram/telegramUpdateQueue.ts` + `.test.ts` |
| Seam | `apps/api/src/telegram/telegramUpdatePipeline.ts` + `.test.ts` |
| Consumer | `apps/worker/src/handlers/telegramUpdateHandler.ts` + `.test.ts` |
| Composition root | `apps/api/src/telegram/telegramProcessorFactory.ts` |
| Registration + gate | `apps/worker/src/index.ts` (`telegram.worker_gated` / `telegram.worker_enabled`) |
| Provisioning | `db/provision.ts` — `telegram.update` in `PGBOSS_QUEUES` (the `velora_worker` role holds no CREATE) |
| Historical battery (at `e041856`) | 1,442/1,442 (1,371 general + 71 PGlite), 0 fail; `tsc -b` 0; `secret-scan` 0; `next build --webpack` 39/39. This is the recorded result for that tree, not a test result for this residue-sweep worktree or the new PG-role assertions. |
| Architectural implementation record | `e041856` |
