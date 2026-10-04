# Telegram Journal Client — security notes

Scope: the Telegram client added by ADR-018. It inherits the platform's model
(`docs/security-policy.md`, `docs/threat-model.md`); this file records only what
is *specific* to it, and how each control is checked. Claims are labelled with the
repository's vocabulary (`STATIC` / `RECORDED_RUNTIME` / `NOT_VERIFIED`).

---

## 1. Identity and authorisation

| Rule | Why | Checked by |
|---|---|---|
| No route accepts a user id, account id or Telegram id from the client | a client-supplied id is an authorisation decision made by the attacker | `apps/api/src/telegram/telegramRoutes.test.ts` (`STATIC`+`RECORDED_RUNTIME`) |
| The only way a Telegram identity becomes a Velora user is the linking handshake | usernames are mutable and non-unique; chat memberships are not proof | `telegramLinkService.test.ts`, `db/tests/telegramStoreAdapter.test.ts` |
| The stable **numeric** Telegram user id is the identity; `username` is cosmetic | a username can be changed to impersonate | `telegram_identities` shape (0023), adapter mapping |
| Callback data is untrusted input | it arrives from the client and is attacker-controllable | `packages/contracts/src/telegram.ts` regex + `telegramBot.test.ts` (forged/foreign/stale callbacks → `rejected`) |
| Ownership is a predicate in the SQL, not a read-then-write check | a check between two statements is a race | `revokeIdentity(userId, identityId)`, `claimChannelPost` composite FK |

**No second auth system.** The bot never authenticates a Velora user with a
password, an OTP or a code sent in chat. The web session remains the only way to
obtain a bearer token, and Telegram never sees one.

---

## 2. The link token

| Property | Value | Rationale |
|---|---|---|
| Entropy | 32 random bytes (base64url, 43 chars) | offline guessing is infeasible; the token is the only secret in the flow |
| Storage | SHA-256 hash only (`^[0-9a-f]{64}$` DB CHECK) | a database read cannot be replayed as a link |
| Lifetime | 10 minutes | short enough that a leaked chat history is stale |
| Use | single-use; consumption + expiry decided in ONE conditional `UPDATE` | two simultaneous deliveries cannot both succeed |
| Content | opaque — no user id, no email, no credential | a forwarded message discloses nothing about the account |
| Supersede | starting a new flow closes the previous pending token | an abandoned flow does not block the user or stay live |
| Logging | the token never appears in a log line or an audit row | asserted by tests; the audit records ids and outcomes only |

Delivery to the user is a Telegram **deep link** (`https://t.me/<bot>?start=<token>`)
opened by the user themself. The product never asks a user to type a password or a
code into Telegram, and would be suspicious if it did — the copy says so.

---

## 3. Update-stream integrity

- **One consumer.** Mode is explicit (`off|polling|webhook`), polling is refused in
  production (`TG-007`), the ingress answers `409` when the deployment polls, and
  the poller stops on a mode mismatch. Two consumers on one stream would let an
  update be processed twice or by the wrong process.
- **Claim before act.** `telegram_updates.update_id` is the primary key; the claim
  is `INSERT … ON CONFLICT DO NOTHING RETURNING`. A Telegram retry, a webhook
  redelivery or a replay after a crash becomes a duplicate outcome, never a second
  journal entry or a second spent token.
- **Claim before answer.** The webhook answers `200` only after the claim is held,
  so a crash mid-processing leaves a durable record instead of a lost update.
- **Ingress is secret-authenticated**, compared in constant time, before the body
  is read; the presented value is never logged.

---

## 4. Financial-record integrity

- A model, an OCR pass or a transcript **cannot** write to `trades` or
  `trade_events`. The only writer is `TradeService` through the ADR-002 domain
  fold, reached from `JournalApplicationService` after an explicit user
  confirmation.
- **Missing fields are never invented.** The deterministic parser reports
  `missingRequired`; an image reading returns `null` for anything not clearly
  visible and the prompt says "do not guess"; the card shows what will be written
  and the user may `ویرایش` first.
- **Confirmation is claimed once** (`CONFIRMING`), so a double tap or a redelivery
  cannot create a second trade; `CONFIRMED` implies a real trade via FK.
- **The mirror cannot double-post** (`UNIQUE (channel_id, trade_id)`) and cannot
  post another user's trade (composite FK to the owning user's row).

---

## 5. Data minimisation and AI egress

- Voice and screenshots are downloaded with a size cap (5 MiB, matching
  `trade_attachments`) and are refused — not truncated — above it.
- Only the **structured fields** read from an image are retained; the media bytes
  are not stored. A transcript is recorded as a **character count** on the attempt
  ledger, not as content.
- Journal **`notes` are excluded** from the analysis payload: sending a trader's
  private prose to a third party is a materially larger disclosure than the
  numbers, and the default does not do it.
- The analysis payload is **bounded** (aggregates + at most 20 sampled trades).
- **Consent is checked before assembly and before egress** — an unconsented user's
  data is not assembled for a provider at all. Refusals
  (`CONSENT_REQUIRED`, `PROVIDER_NOT_CONFIGURED`, `PAYLOAD_TOO_LARGE`) are recorded
  as `refused`, not as errors.
- **Fail closed by default.** With no provider credential the interpreter throws a
  typed not-configured error: no local speech heuristic, no "best guess" OCR, no
  fabricated content.
- Provider output is validated before storage; prose or an array where a JSON
  object is required is `EMPTY_RESULT`/`INVALID_PROVIDER_OUTPUT`, never fields.

---

## 6. Secrets

| Secret | Handling |
|---|---|
| `TELEGRAM_BOT_TOKEN` | holder object; `reveal()` has a single call site; redacted in `String()`/`JSON.stringify()`; never in an error, stack or log |
| `TELEGRAM_WEBHOOK_SECRET` | constant-time comparison; the presented value is never logged |
| `GEMINI_API_KEY` | only in the `x-goog-api-key` header (never in a URL, which proxies log); provider error bodies are never echoed |
| Link tokens | never logged; only hashes are stored |

Shape checks reject a credential pasted into the wrong variable before any
outbound call, and the repository's `tools/secret-scan.sh` gate covers the tree
(current status: PASS).

---

## 7. Rate limiting

Per-identity buckets (the Telegram user id, not an IP — a bot has no meaningful
client IP): link-start 5/h, updates 60/min, journal 20/h, analysis 8/h, channel
10/h. The store is shared across processes, so the limit does not depend on which
replica answered. Exceeding a limit answers `429` with `Retry-After`; the bot tells
the user to wait rather than silently dropping the message.

---

## 8. Error handling (no information disclosure)

A wrong, expired, revoked or already-consumed token produces the same
non-disclosing reply; the distinction is server-side only, so an attacker learns
nothing by probing. A foreign or missing draft id answers `rejected` with a
byte-identical reply. Route handlers map typed service errors to their own status
(`409 NOT_LINKED`, `429 RATE_LIMITED`) — an unexpected error is still a `500`, and
nothing is answered `200` to make a failure look like a success.

---

## 9. Not verified here

Live Telegram and live Gemini round trips, a webhook delivery to a deployed host,
and real-PostgreSQL concurrency (two sessions racing the atomic statements) are
**NOT VERIFIED** — see `docs/telegram/DEPLOYMENT.md` §7. The atomicity claims rest
on single-statement SQL plus PGlite (single-session) evidence, not on a race
observed against a real server.
