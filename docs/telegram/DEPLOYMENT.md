# Telegram Journal Client — operator guide

**Status of this document:** it describes how to run the Telegram client that is
implemented on `feat/telegram-journal-client`. It separates what is *implemented
and verified in this repository* from what needs an external credential or a
deployment decision. Nothing here claims a live round trip: see §7.

---

## 1. What the client is

Telegram is a **first-class client of Velora**, not a side channel:

- **Same users.** A Telegram account becomes a Velora user only through the
  linking handshake. Before that, `/start` is onboarding and nothing else.
- **Same database.** Every confirmed journal entry is written through the existing
  `TradeService` (ADR-002 ledger) into `trades` / `trade_events`. There is no
  `telegram_trades` table and no second source of truth (ADR-018).
- **Same AI architecture.** Voice transcription, screenshot reading and journal
  analysis all go through the existing `AiProvider` boundary, with consent check,
  payload bound and the `ai_coaching_logs` ledger (0017) applying unchanged.
- **Same journal.** A journal confirmed in Telegram appears in the web app's
  journal and analytics immediately, because it is the same row.

### Surfaces

| Surface | Path | Auth |
|---|---|---|
| Bot update ingress | `POST /api/v1/webhooks/telegram` | `X-Telegram-Bot-Api-Secret-Token` (constant-time) |
| Status (web Settings) | `GET /api/v1/telegram/status` | Bearer |
| Start linking | `POST /api/v1/telegram/link/start` | Bearer, 5/hour/user |
| Unlink | `POST /api/v1/telegram/link/unlink` | Bearer |
| Journal channel | `GET` / `DELETE /api/v1/telegram/channel` | Bearer |

There is deliberately **no `POST /channel`**: binding a channel requires the
server to verify with the Bot API that the bot may post there, so it happens only
from Telegram (`/channel <chat id>`). The web can only remove what the user owns.

---

## 2. Configuration

All variables are read at call time, so a rotated secret takes effect without a
restart. Resolution is fail-closed and every failure is a fixed, listed finding.

| Variable | Required for | Rule | Failure code |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | everything | `<bot_id>:<secret>` (5–16 digits, then 30–64 of `A-Za-z0-9_-`) | `TG-001` missing, `TG-002` malformed |
| `TELEGRAM_BOT_USERNAME` | **linking only** | `[A-Za-z0-9_]{5,32}`, `@` tolerated | `TG-003` |
| `TELEGRAM_WEBHOOK_SECRET` | **webhook ingress only** | 16–256 of `A-Za-z0-9_-` | `TG-004` |
| `VELORA_APP_URL` (falls back to `APP_ORIGIN`) | deep links | absolute `https`; loopback `http` allowed in development | `TG-005` |
| `TELEGRAM_UPDATE_MODE` | update consumption | exactly `webhook` or `polling` | `TG-006` |
| `APP_ENV=production` | mode gate | refuses `polling` in production | `TG-007` |
| `GEMINI_API_KEY` | voice / images / analysis | any non-empty string | — (capability off, not an error) |

**Degradation is per capability, never global.** A deployment with a token but no
`TELEGRAM_BOT_USERNAME` still receives updates and journals by text; only the
deep link and the linking button are unavailable. With no token the entire
Telegram surface answers `503` and `/health` + `/ready` stay green — the web
product is unaffected, exactly as a missing MetaAPI token behaves (ADR-014 §5).

**Never logged.** The token holder redacts in `String()`/`JSON.stringify()`; the
only accessor is `reveal()`, called at the single request site. The config
resolver also refuses a token pasted into the wrong variable (e.g. a provider key
in `TELEGRAM_BOT_TOKEN`) by shape, before any outbound call.

---

## 3. The one-consumer rule (read this before deploying)

Telegram offers two ways to receive updates. **A deployment must consume exactly
one.** Two consumers on one stream is a silent data fault: whichever process wins
the race serves the user, a rolling deploy changes who that is, and the loser may
still act on an update it should not have.

| Mode | Who consumes | Where it is legitimate |
|---|---|---|
| `webhook` | `POST /api/v1/webhooks/telegram` | **production** (needs public HTTPS + secret) |
| `polling` | in-process `TelegramPoller` | local development and staging |

The rule is enforced in three independent places, so a mistake cannot be a single
point of failure:

1. **The resolver refuses `polling` when `APP_ENV=production`** (`TG-007`, mode
   becomes `off`) — the deployment cannot even start the wrong consumer.
2. **The ingress route answers `409 TELEGRAM_MODE_CONFLICT`** when the deployment
   polls, so a stray webhook is refused rather than double-processed.
3. **The poller stops and logs `telegram.poller_mode_mismatch`** if the configured
   mode is not `polling`, instead of silently skipping every update.

`server-main.ts` starts the poller only in `polling` mode, and mode `off` consumes
nothing at all (`503 TELEGRAM_UPDATES_OFF` on ingress).

### Production (webhook)

```bash
TELEGRAM_BOT_TOKEN=...            # from @BotFather
TELEGRAM_BOT_USERNAME=velora_bot
TELEGRAM_WEBHOOK_SECRET=...       # 16-256 chars; generate with openssl rand -hex 32
VELORA_APP_URL=https://app.example.com
TELEGRAM_UPDATE_MODE=webhook
APP_ENV=production
GEMINI_API_KEY=...                # optional; enables voice/image/analysis
```

Then register the webhook **once**, from a machine that holds the token:

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://app.example.com/api/v1/webhooks/telegram" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message","callback_query","edited_message"]'
```

Verify delivery state with `getWebhookInfo`. **Never run `setWebhook` and a
poller against the same bot** — `getUpdates` then answers `409 Conflict` to
whichever asks second; the poller treats that as the second-consumer fault it is
(`telegram.poll_failed` with `code:"CONFLICT"`, ≥15 s backoff, capped at 60 s).

### Local development (polling)

```bash
TELEGRAM_BOT_TOKEN=...            # a SEPARATE dev bot, so prod is never disturbed
TELEGRAM_BOT_USERNAME=velora_dev_bot
VELORA_APP_URL=http://127.0.0.1:3000   # loopback http is allowed here
TELEGRAM_UPDATE_MODE=polling
APP_ENV=development
```

Ensure no webhook is registered on the dev bot (`deleteWebhook`); a registered
webhook is what makes `getUpdates` answer 409.

---

## 4. Linking (both directions, one handshake)

| Direction | Path |
|---|---|
| Telegram-first (onboarding) | `/start` offers `[ 🔐 اتصال امن به Velora ]` → deep link → press **Start** |
| Website-first | Settings → *Telegram connection* → **🔐 Secure connection to Velora** → copy/open → press **Start** in Telegram |

The token is **32 crypto-random bytes, base64url, stored only as SHA-256**, valid
for **10 minutes**, single-use, and carries no account, user id or credential. The
account is resolved on the server from the token row, and completion is one atomic
conditional `UPDATE` — so two simultaneous deliveries of the same link cannot both
succeed. Revoking/re-linking is a state change on the identity row, not a new one.

States the UI and the bot can distinguish:
`NOT_LINKED · LINK_PENDING · LINKED · LINK_REVOKED · LINK_EXPIRED · LINK_ERROR`
(web labels: Disconnected / Connecting / Connected / Revoked / Expired / Error).

**A user never types a password or a code into Telegram**, and the product never
asks for one. The deep link carries an opaque token only.

---

## 5. Bot surface

Commands: `/start` `/help` `/journal` `/last` `/history` `/analyze` `/settings`
`/link` `/unlink` `/channel`.

Menu: 📝 New Journal · 📊 Last Trade · 📚 Journal History · 🧠 Analyze · ⚙️ Settings.

Journal flow: text, voice note or chart screenshot → the deterministic parser
extracts what is present → a confirmation card with `[تأیید][ویرایش][لغو]`.
**Missing fields are never invented**: the card says which are missing and the
draft stays `NEEDS_DETAIL` until the user supplies them. Only `تأیید` writes — via
`TradeService`, the same path the web uses — and the write is claimed once
(`CONFIRMING`), so a double tap or a Telegram retry cannot create two trades.
Drafts expire after 30 minutes and the sweep marks them `EXPIRED`.

---

## 6. Operations

- **Health:** `GET /health` (liveness) and `GET /ready` (readiness) are unchanged;
  Telegram being unconfigured never fails them.
- **Logs:** one JSON object per line. Useful events: `telegram.enabled` /
  `telegram.disabled`, `telegram.polling_enabled`, `telegram.update_consumed`,
  `telegram.update_duplicate`, `telegram.update_unprocessable`,
  `telegram.poll_failed` (`code`, `backoffMs`), `telegram.poller_mode_mismatch`,
  `telegram.webhook_unauthorized`, `telegram.channel_publish_failed`. No event
  carries a token, a link payload or a transcript.
- **Audit:** `audit_log` gains `TELEGRAM_LINK_STARTED`, `TELEGRAM_LINK_COMPLETED`,
  `TELEGRAM_LINK_FAILED`, `TELEGRAM_UNLINKED`, `TELEGRAM_CHANNEL_BOUND`,
  `TELEGRAM_CHANNEL_UNBOUND` (actor = the authenticated user, provider
  `TELEGRAM`).
- **Rate limits** (per user): link-start 5/h · updates 60/min · journal 20/h ·
  analysis 8/h · channel 10/h. Exceeding one answers `429` with `Retry-After`.
- **Rollback:** set `TELEGRAM_UPDATE_MODE` to anything other than the current mode
  (or remove `TELEGRAM_BOT_TOKEN`) and restart — the client stops consuming and
  the web product is untouched. Nothing in the Telegram schema is required by any
  other feature; migration `0023` is additive and leaves existing rows alone.
- **Uninstalling cleanly:** `deleteWebhook` (if webhook mode) before removing the
  environment variables, so Telegram stops retrying a dead endpoint.

---

## 7. What is NOT verified (do not claim otherwise)

| Claim | State |
|---|---|
| Live round trip against `api.telegram.org` (real bot, real user) | **NOT VERIFIED** — no bot token in scope. Everything else is exercised against a scripted transport. |
| Live Gemini call (voice, screenshot, analysis) | **NOT VERIFIED** — no provider credential in scope; the transport, prompt shape, refusal and ledger paths are tested with an injected fetch. |
| Webhook delivery from Telegram to a deployed endpoint | **NOT VERIFIED** — needs the deployed host + `setWebhook`. |
| Real-PostgreSQL concurrency (two sessions racing a token/claim) | **NOT VERIFIED** — the atomic statements are single-statement by construction and covered by PGlite (single session); `db/tests/*.pg.test.ts` remains the real-server path. |
| n8n relay transport | **NOT IMPLEMENTED** — recorded as a gap in ADR-018; the `MediaInterpreter` seam is where a relay would be added. |
| Worker-based background processing | **NOT USED** — `apps/worker` is not deployed; all Telegram work runs synchronously in the API process (deferred after the webhook's 200). |
