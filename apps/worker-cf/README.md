# `apps/worker-cf` — the existing Telegram bot, hosted on Cloudflare Workers

This is **a host, not a second bot**. Every line of bot behaviour is imported from
`apps/api/src/telegram/*` and the services that file already used. Exactly three things are
replaced, because a Workers runtime cannot provide them:

| Node.js host (`server-main.ts`) | This host | Why |
|---|---|---|
| `pg` `Pool` | `./pgHyperdrive.ts` → `postgres.js` over the `HYPERDRIVE` binding | no raw TCP on Workers |
| node HTTP kernel + routes | `fetch` handler in `./index.ts` | same path, same order, same status codes, same `{status,data,error,timestamp}` envelope |
| `pg-boss` deferred jobs | `ctx.waitUntil` through the pipeline's `defer` port (`createDeferredWork`) | no process to own a queue |
| in-process draft-expiry sweep | `triggers.crons` → `scheduled()` | nothing runs between requests |

## Configuration

`wrangler.jsonc` carries non-secret config only. Three secrets, and only these, are provisioned
with `wrangler secret put` (never `vars`, which are readable in the dashboard):

```
wrangler secret put TELEGRAM_BOT_TOKEN        # the existing @MyVeloratradeBot
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # must equal what setWebhook sends
wrangler secret put WORKER_ADMIN_TOKEN        # read-only diagnostics bearer
```

Two non-secret vars complete the config, and one of them is a deliberate gap:
`TELEGRAM_BOT_USERNAME` (value from `getMe`; without it the resolver reports TG-003 and `/link` is
disabled) is set. **`VELORA_APP_URL` / `APP_ORIGIN` is not set**, and must not be guessed — it is the
origin that single-use link tokens are mailed to, so a wrong value means handing a live token to another
domain owner. Left unset it degrades visibly (TG-005, `linkingConfigured:false`), which is the intended
behaviour; the owner fills it with the real web-app origin.

`TELEGRAM_API_BASE` exists for staging against a stub. **Leave it unset in production:** it would
point the Bot API calls at another origin, and Telegram's tokens travel in the URL path
(`/bot<TOKEN>/sendMessage`), so any proxy in front of `api.telegram.org` can read them. In
particular this must never be aimed at the account's `tgpl` Worker (see "Security note" below).

Two config decisions are recorded in comments where they belong, because both look like bugs and
neither is:

* `compatibility_date` is pinned to `2026-05-03`, below the repo's usual date, because wrangler
  4.86.0's bundled workerd refuses any newer date. Raise it with a wrangler upgrade, not alone.
* There is **no** `limits` block. `memory_mb` is not a valid key (`UserLimits` = `cpu_ms |
  subrequests`), and `limits` itself only applies on the paid plan; the whole request path measures
  ~43 µs of CPU against the Free plan's 10 ms, and Cloudflare does not count the database or Bot
  API wait at all.

## Rules this code exists to keep

1. **Deferred work is per invocation.** `createDeferredWork` is built inside `composeRuntime` and
   handed straight to `ctx.waitUntil` at deferral time. A module-scope queue let one request's flush
   splice another's task and run it under the *wrong* `waitUntil`: the second request answers 200,
   which suppresses Telegram's retry, and if the first is then cancelled the claimed update is lost
   silently. `src/deferredWork.test.ts` pins this, including a canary that shows the old shape fails
   the same assertions.
2. **No driver is ever shared between requests.** `poolFor` is called inside `composeRuntime` and the
   instance is released in the *same* invocation's `waitUntil`, after its deferred work settles. A
   memoised pool passed the whole Node test suite and then failed under workerd with
   `Cannot perform I/O on behalf of a different request` (postgres.js's `postgres/cf` build binds the
   Hyperdrive WebSocket stream to the request that created it) — measured as an alternating
   `200, 500, 200, 500`. Because the update row is already claimed at that point, the 500's retry is
   answered `duplicate`: a dropped user message, permanently. Auto-closing the pool inside
   `composeRuntime` is equally wrong — `settle()` resolves an empty chain immediately, so the driver is
   gone before the first query (`CONNECTION_ENDED`). Both orderings are pinned by tests.
3. **Absence is a capability state, never a fallback.** No `HYPERDRIVE` binding ⇒
   `NO_DATABASE_BINDING` ⇒ 503 on the webhook, with `/health` still green. An in-memory substitute
   would lose a CONFIRMED journal entry between isolates, which is worse than refusing.
4. **The ingress order is the security property**: mode/secret check (constant time, before the body
   is read) → 256 KiB cap (declared, then actual) → zod schema → claim → 200.
5. **`POOL_MAX` is 2.** A Worker may hold 6 simultaneous outgoing connections per invocation, and
   transactions do *not* use this pool — `withTransaction` → `pool.connect()` → `PinnedClient` opens
   its own single-connection driver — so the real peak per isolate is `POOL_MAX + concurrent
   transactions`. The harness measures it (8 at `max:2`, 14 at `max:8`) and proves the 6 concurrent
   transactions all commit at the shipped cap. The measured cost of the smaller cap is queueing on a
   16-query burst; a webhook delivery issues at most one ad-hoc query at a time.
6. **`telegram_updates.outcome` is not proof of delivery.** The row is created when the update is
   claimed, with `outcome` NULL, and `finishUpdate` writes `handled` in a `finally` after dispatch —
   so an update whose `sendMessage` afterwards failed still reads `handled`. The observable of a
   failed send is the `telegram_send_failed` warn line (`telegramBot.ts:889-894`), which is
   swallowed on purpose because a redelivery must not re-write a confirmed journal entry. Any
   dashboard or alert must read the log, not the table.

## The private D1 test store (the destination this phase chose)

The test deployment uses **Cloudflare D1**, not an external Postgres service, and not Velora's main
database. `wrangler.jsonc` binds it as `VELORA_TEST_DB`:

```
d1_databases: [{ binding: "VELORA_TEST_DB", database_name: "velora-telegram-test",
                database_id: "51314295-7db1-4089-8487-ef087d915a76" }]
```

Only the essential bot capabilities run on it: receive the update, decide from `from.id` **alone**
(`TELEGRAM_TEST_USER_ID`, a secret), claim the `update_id` exactly once, store the message, answer the
commands this build can actually serve (`/start`, `/help`, `/stats` — `src/testCommands.ts`, Persian-first
because that is the product's locale), and record the outcome. `/start <payload>` is *refused*, not
imitated: the deep-link handshake belongs to the PostgreSQL services, and untrusted text buys no authority.
The schema is `d1/migrations/0001_telegram_test.sql` — one `STRICT` table with a `CHECK` on the outcome
enum and one index — plus `0002_telegram_test_attempt.sql`, which adds `attempt INTEGER NOT NULL
DEFAULT 1` so the claim can tell "already finished" from "failed, safe to re-attempt". **The PostgreSQL migrations must never be run against D1**; `apps/api/src/db/migrations/*` is
Postgres-only SQL (`::` casts, `$n`, `RETURNING`, `jsonb`) and D1 is not Postgres. Everything else is
disabled by not being composed at all (`D1_DISABLED_FEATURES`: journal, trades, linking, AI, audit), so
the database physically contains no trade, journal or audit table.

Two runtime rules that cost real debugging time and are easy to re-break:

1. **`src/index.ts` exports exactly one thing** — `export default { fetch, scheduled }`. In workerd every
   *value* export of an entry module is a candidate entrypoint, so a module that also exports constants
   boots under `wrangler deploy` and dies under `wrangler dev` with
   `Incorrect type for map entry '…': the provided value is not of type 'function or ExportedHandler'`.
   The access gate therefore lives in `src/privateAccess.ts` (it depends on nothing but its own secret,
   which is also why its tests can import it directly) and composition plus the D1 path in
   `src/runtime.ts`.
2. **The Bot API transport must be a bound `fetch`.** `HttpTelegramBotApi`'s default is a detached global,
   which Node tolerates and workerd answers with `TypeError: Illegal invocation` — surfacing as
   `TelegramApiError{code:"NETWORK"}` for *every* target. `runtime.ts` passes an explicit bound
   implementation; the shared client's default is bound too.

On measuring sends: the handler logs the error **code**, never the message, because the message path can
carry the token URL. If a send fails in a test, look for `telegram.test_update_failed` and read `code`
before blaming the network — three unrelated targets returning one code means the transport, one target
returning `MALFORMED_RESPONSE` means something answered with a non-JSON body.

### Running the D1 path locally

`wrangler.dev-d1.jsonc` is deliberately **not tracked** (it matches `.gitignore`'s `wrangler.dev*.jsonc`),
so recreate it when needed: the same config as `wrangler.jsonc` with `d1_databases` intact and no
`hyperdrive` entry. Then:

```
# one-off, local only — fake values, never a real token
cat > .dev.vars <<'ENV'
TELEGRAM_UPDATE_MODE=webhook
APP_ENV=development
TELEGRAM_TEST_USER_ID=<the id you are testing as>
TELEGRAM_BOT_TOKEN=1234567:AAlocalfake_localfake_localfake_1
TELEGRAM_WEBHOOK_SECRET=local-dev-webhook-secret-0123456789
TELEGRAM_API_BASE=http://127.0.0.1:9913
ENV

npx wrangler d1 execute velora-telegram-test --local --persist-to /tmp/d1local \
  -c wrangler.dev-d1.jsonc --file d1/migrations/0001_telegram_test.sql
npx wrangler dev --local -c wrangler.dev-d1.jsonc --port 8792 --persist-to /tmp/d1local
# read a row back with the same --local --persist-to pair, e.g.
#   select update_id, outcome, text_excerpt from telegram_updates order by update_id desc limit 5;
```

`.dev.vars` is where local *string* variables belong: `wrangler dev --var KEY:777001` is JSON-coerced to a
number and `--var 'KEY:"777001"'` arrives with literal quotes, which the gate then rejects as
`not-armed:invalid`. Delete `.dev.vars` when finished — the repo root does **not** ignore it.

## Two read-only admin routes

Both are guarded by `WORKER_ADMIN_TOKEN` through `adminAuthorized()` in `src/runtime.ts` — same-length
check then `timingSafeEqual`, and a configured token shorter than 16 characters counts as absent. They
answer questions that would otherwise require *doing* something to the deployment:

| route | answers | never returns |
|---|---|---|
| `GET /api/v1/telegram/diagnostics` | config presence, mode, findings, gate *shape* | any id, token, or count of personal data |

Both routes require the admin bearer and `diagnostics` answers `405` to anything but `GET` (auth is
checked first, so an unauthenticated caller cannot enumerate paths by watching the method response).

**The `/api/v1/telegram/egress` probe that used to be here was retired on 2026-10-18, after the webhook
went live.** It existed because the only outbound call the Worker makes sat behind the private-access
gate, so answering "can this Worker reach Telegram?" would otherwise have meant arming the gate with
somebody's id — and inventing an id to get a number is not an acceptable price. It did its job (report
§10.10/§10.11: eight consecutive `getMe`+`getChat` round trips from the deployed Worker, which reversed
an earlier wrong claim of mine about filtered egress). Then the webhook was registered and all three of
its questions became answerable from signals that need no extra route: `getWebhookInfo` for inbound
delivery, a row's `outcome:"handled"` for "the reply was accepted by the Bot API", and the provider `code`
on `telegram.test_update_failed` for what broke. A route that makes outbound calls on demand, with no
remaining question to answer, is surface without value — so it is gone, with the code and its nine tests
archived under `velora-telegram-bot-deploy/retired/egress-probe/` and a test in `src/adminGuard.test.ts`
asserting the path now 404s (a 401 there would mean it was only hidden).

## What is deliberately NOT available here

Stated as gaps, not as parity. Each one answers with the repo's capability-absent shape
(`Unconfigured*`) rather than pretending to work:

| Capability | Status on Workers | Why | Blocked on |
|---|---|---|---|
| Voice notes / audio transcription | **absent, but not free** | the refusal is honest (`copy.voiceUnavailable`) yet it happens *after* the host has sent "processing…" and run `fetchBytes` → `getFile` + `downloadFile` (`telegramBot.ts:523-528`) — two Bot API calls and a discarded download — and after `transcribeAndRecord` booked a `refused` row in `ai_coaching_logs` (`mediaInterpreter.ts:276-291`) | no ffmpeg on Workers; short-circuiting on an unconfigured interpreter is an `apps/api` change, deliberately not made here |
| Chart/photo OCR → journal extraction | **absent** | needs `tesseract` + the `attachments` service; with none wired, `telegramBot.ts:633-634` returns before any upload | both are Node-side; `media.interpreter` is `UnconfiguredMediaInterpreter` |
| `/analyze` AI coach insight | **absent unless `GEMINI_API_KEY` is set**, and even then the n8n relay path is not wired | the API resolves provider keys from `ai_platform_secrets`; this host reads only `GEMINI_API_KEY` from env | owner decision on where AI keys live |
| Draft-expiry sweep | **present, but 5-minute granularity** | `scheduled()` cron instead of the in-process timer | none — a behaviour difference to accept |
| `getUpdates` polling | **refused** (409 / TG-007) | a poller needs a long-lived loop | by design |
| Everything except intake + gate + store + read-back | **absent on the D1 destination** | `D1_DISABLED_FEATURES`: journal, trades, linking, AI, audit — not composed, not half-wired | the owner's choice of destination; the Postgres path stays the real one |
| Journal, trades, linking, AI on D1 | **absent, by construction** | `composeRuntime` returns `pipeline: null` for `storage === "d1-test"`, so there is no object that could write a trade; the D1 table holds one update per row and nothing else |
| A delivered reply in a real chat | **delivered by Telegram itself, measured**: after the webhook was registered, the owner's three queued `/start` updates arrived (update_ids 407785934-6), each answered 200 on the deployed version and each stored `outcome:"handled"` | the ingress was never polled; see `evidence/webhook_live_tail.txt` |
| `/api/v1/telegram/status` and the bearer link routes | **not ported** | they belong to the authenticated web app, which stays on the existing host | by design |
| Crash-durable job replay | **narrower than pg-boss, but no longer lossy** | a `failed` row is re-claimable (`CLAIM_SQL`'s `DO UPDATE … WHERE outcome = 'failed'`, attempt+1) and a store failure answers 503/502 instead of acknowledging; a `handled` row stays terminal.

## Commands

Every number below was measured in this Workspace against the shipped code; the
disposable database is a local `initdb` cluster, never a real one.

```
npm -w @velora/worker-cf run types     # tsc, no emit                                  → 0 errors
npm -w @velora/worker-cf run bundle    # wrangler --dry-run, reports the real size     → 482.01 KiB / 107.64 KiB gzip (with D1)
npm -w @velora/worker-cf test          # D1 store 12 + access gate 18 + deferred work 7 → 37/37
IT_DATABASE_URL=postgres://… npm -w @velora/worker-cf run it    # real-PG harness      → 61/68 checks
LEAST_PRIVILEGE_DATABASE_URL=… SEED_DATABASE_URL=… npm -w @velora/worker-cf run lp    # bot role only → 25/25
npm run typecheck                      # whole repo                                      → 0 errors
npm test                               # whole repo                                        → exit 0 (1409/1409 + PGlite 73/73)
npm run test:migrations                # migration runner on PGlite                       → 19/19
DATABASE_URL=postgres://… npx tsx --test db/tests/*.pg.test.ts                            → 346/346
npm run secret-scan                    # no credential in any tracked file                → 0 findings
```

`run it` and `run lp` go through `tsx`, not plain `node`: both scripts import the Worker's
TypeScript entry point, which node refuses (`ERR_UNKNOWN_FILE_EXTENSION`). The env gate is checked
before that import, so a run without the URL exits 2 immediately — the scripts cannot silently
pass by skipping the database. `integration.mjs` covers the journal round trip, duplicate
suppression, the deferred-work regression under concurrency and the pool lifecycle; its private
test-mode section proves that a refused sender moves no row in any of the six tables the bot can
touch, that an id claimed in message text or in `callback_query.data` grants nothing, that an
unset or malformed gate answers 503 instead of becoming an open bot, and that `/ready` stays red
while the gate is broken even when the database answers fine. `leastPrivilege.mjs` runs the same
real flows **as** the least-privilege bot role and asserts nine denials as genuine `42501`s.

`npm test` **excludes** every `*.pg.test.ts` file by design (`tools/run-tests.mjs:28-32`: they need a
real server, and a local skip must not masquerade as evidence), and it **includes** the `apps/api`
suites that cover the bot logic this host imports. So the repo suite proves the shared logic, while
the `DATABASE_URL` battery proves the parts that only exist on a real Postgres — the privilege grid
(`pgRoles` 24/24), duplicate-update handling (`telegramConcurrency` 10/10) and trade concurrency
(`pgTradeConcurrency` 14/14).

`run it` requires `IT_DATABASE_URL` and exits 2 without it, on purpose: it seeds and deletes
fixture rows in the database it is pointed at. Never point it at production. It also creates and drops
one scratch database (`velora_cf_probe`) so the connection-count checks are exact instead of polluted
by whatever else shares the cluster — which means the role it connects with needs `CREATEDB`; the
other two tables it touches are dropped in `finally`.

`.gitignore` in this directory keeps `.wrangler/`, `dist/` and `.dev.vars` out of git. The last one
matters: the repo root ignores `dist/` and `*.tsbuildinfo` but **not** `.dev.vars`, and local
Hyperdrive development needs a password in its connection string (`miniflare` rejects a
passwordless one).

## Security note on the account's `tgpl` Worker

`tgpl` is a hand-uploaded, unauthenticated pass-through to `api.telegram.org`. It is **preserved
untouched** — no code, config, secret or route of it was changed by this project, and it must not
be overwritten (there is no repository behind it, so a replacement would be unrecoverable). Its
risks — open proxy, quota abuse, and bot tokens visible in a third Worker's URL — are documented in
`velora-telegram-bot-deploy/05-…` with a remediation plan that is deliberately kept separate from
this deployment.
