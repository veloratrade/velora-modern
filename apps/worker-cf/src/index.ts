/**
 * Cloudflare Worker entry for the Velora Telegram bot, in private test mode.
 *
 * Deliberately thin, and with a reason: workerd treats every named export of a Worker's entry
 * module as a candidate entrypoint, so the gate, the composition and the D1 test path live in
 * `privateAccess.ts` / `runtime.ts` and this file exports only the handler. `wrangler dev`
 * cannot start otherwise — which is also why the split is worth having.
 *
 * The order in `fetch` IS the contract: method → configuration → webhook secret → body-size cap
 * → decode → access gate → runtime composition → claim → dispatch. Nothing after the gate runs
 * for a sender the gate refuses, so a refused update issues no statement at all.
 */
import { resolveTelegramConfig, webhookSecretMatches } from "../../api/src/telegram/telegramConfig.js";
import { TELEGRAM_WEBHOOK_MAX_BODY_BYTES } from "../../api/src/telegram/telegramRoutes.js";

import {
  fail,
  ok,
  telegramUpdateSchema,
  TELEGRAM_WEBHOOK_PATH,
  type TelegramUpdate,
} from "@velora/contracts";

import { accessState, decideAccess } from "./privateAccess.js";
import {
  adminAuthorized,
  asEnvRecord,
  composeRuntime,
  D1_DISABLED_FEATURES,
  handleTestUpdate,
  json,
  releasePool,
  storageMode,
  type Env,
} from "./runtime.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    // Liveness never depends on Telegram or the database, exactly like the API.
    if (url.pathname === "/health") {
      // Liveness stays independent of Telegram, the database and the gate — but the
      // mode is visible, because "healthy" and "willing to serve anybody" are answers
      // to different questions. No id, no secret, no count of anything personal.
      const access = accessState(env);
      return json(200, ok({
        status: "ok",
        time: new Date().toISOString(),
        mode: "private-test",
        // Which durable store, if any: "d1-test" is a test surface and must read as one.
        storage: storageMode(env),
        access: access.valid ? "armed" : `not-armed:${access.note.toLowerCase()}`,
      }));
    }

    if (url.pathname === "/ready") {
      const rt = composeRuntime(env, ctx);
      const access = accessState(env);
      // A bound database with a broken gate is NOT ready: it would accept updates it
      // then refuses for everyone, including its owner.
      let reason: string = rt.reason; // widened: the gate can rename it (below)
      let database = rt.pool !== null ? "ok" : "missing";
      if (rt.storage === "d1-test" && rt.test !== null) {
        // D1 is "connected" only if the schema is applied: an empty database that answers
        // `SELECT 1` is not a usable one, and calling it ready is how a test gets believed.
        const present = await rt.test.store.hasSchema().catch(() => false);
        database = present ? "ok" : "missing";
        if (!present && reason === "ok") reason = "D1_SCHEMA_MISSING";
      }
      // Readiness and the gate have to be visible in the *same* field a human or a
      // script reads first. A body that answers `"reason":"ok"` while the deployment
      // refuses every sender — including its owner — is how a test gets believed
      // before it is allowed to run, so the gate names itself here too. The database
      // reason wins when both are broken: a missing schema is the more specific fault.
      if (!access.valid && reason === "ok") {
        reason = access.configured ? "ACCESS_GATE_INVALID" : "ACCESS_GATE_UNCONFIGURED";
      }
      const ready = reason === "ok" && access.valid;
      void releasePool(rt);
      return json(ready ? 200 : 503, ok({
        status: ready ? "ready" : "not_ready",
        checks: { database, storage: rt.storage, telegram: rt.configured ? "enabled" : "absent", reason },
        access: { mode: "private-test", configured: access.configured, valid: access.valid, note: access.note },
      }));
    }

    if (url.pathname === "/api/v1/telegram/diagnostics") {
      // Constant-time, like the webhook secret: an early-exit compare on a bearer token
      // hands its prefix to anyone who can time the answer.
      if (!adminAuthorized(env, request)) {
        return json(401, fail("UNAUTHENTICATED", "Unauthenticated.", requestId));
      }
      // Auth first, method second: answering 405 to an unauthenticated caller would advertise
      // which paths exist. Everything below is a read, so anything else is refused outright.
      if (request.method !== "GET") {
        return json(405, fail("METHOD_NOT_ALLOWED", "Read-only route.", requestId));
      }
      const rt = composeRuntime(env, ctx);
      // Codes and fixed messages only — never a value, never a token.
      void releasePool(rt);
      return json(200, ok({
        configured: rt.configured,
        reason: rt.reason,
        storage: rt.storage,
        // Stated plainly so nobody has to infer it from a missing binding: on D1 these are off.
        disabled_features: rt.storage === "d1-test" ? [...D1_DISABLED_FEATURES] : [],
        findings: rt.findings,
        // Mode and shape only. The allowed id is personal data and is never echoed,
        // not even masked: `note` says whether the gate exists and parses.
        access: (() => {
          const a = accessState(env);
          return { mode: "private-test", configured: a.configured, valid: a.valid, note: a.note };
        })(),
      }));
    }

    if (url.pathname !== TELEGRAM_WEBHOOK_PATH) {
      return json(404, fail("NOT_FOUND", "Not found.", requestId));
    }

    // ── webhook ingress: the order below IS the contract ──────────────────────
    if (request.method !== "POST") {
      return new Response(JSON.stringify(fail("METHOD_NOT_ALLOWED", "Method not allowed.", requestId)), {
        status: 405,
        headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
      });
    }
    const resolution = resolveTelegramConfig(asEnvRecord(env));
    if (!resolution.configured) return json(503, fail("TELEGRAM_NOT_CONFIGURED", "Telegram is not configured.", requestId));
    if (resolution.updateMode === "polling") {
      return json(409, fail("TELEGRAM_MODE_CONFLICT", "This deployment consumes Telegram updates by polling.", requestId));
    }
    if (resolution.updateMode !== "webhook") {
      return json(503, fail("TELEGRAM_UPDATES_OFF", "Telegram update consumption is disabled.", requestId));
    }
    const expectedSecret = resolution.webhookSecret?.reveal() ?? null;
    if (expectedSecret === null || !webhookSecretMatches(expectedSecret, request.headers.get("x-telegram-bot-api-secret-token"))) {
      console.log(JSON.stringify({ level: "warn", event: "telegram.webhook_unauthorized", requestId }));
      return json(401, fail("UNAUTHENTICATED", "Unauthenticated.", requestId));
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > TELEGRAM_WEBHOOK_MAX_BODY_BYTES) {
      return json(400, fail("VALIDATION_FAILED", "request body too large", requestId));
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > TELEGRAM_WEBHOOK_MAX_BODY_BYTES) {
      return json(400, fail("VALIDATION_FAILED", "request body too large", requestId));
    }

    const bodyText = new TextDecoder().decode(body);
    // Decided before anything is composed: an unauthorized sender must not reach the
    // pool, the claim or a single query.
    const access = accessState(env);
    let gateUpdate: TelegramUpdate | null = null;
    if (access.valid) {
      // A throwing parse here would answer 500 for a body the pipeline is specified to
      // report as `malformed` (400-equivalent log + no claim), so the failure is
      // captured and left for that path to describe.
      let value: unknown = null;
      try {
        value = JSON.parse(bodyText) as unknown;
      } catch {
        value = null;
      }
      const parsed = value === null ? null : telegramUpdateSchema.safeParse(value);
      gateUpdate = parsed !== null && parsed.success ? parsed.data : null;
    }
    const decision = decideAccess(access, gateUpdate);
    if (!decision.allow) {
      console.log(JSON.stringify({
        level: decision.status === 503 ? "error" : "warn",
        event: decision.event,
        code: decision.code,
        requestId,
      }));
      // 503 is an operator fault worth retrying; 200 means "delivered, deliberately
      // dropped" so Telegram stops redelivering and no quota is burned on it.
      return decision.status === 503
        ? json(503, fail(decision.code, decision.message, requestId))
        : json(200, ok({ dropped: true, private: true, reason: decision.code }));
    }

    const rt = composeRuntime(env, ctx);
    if (rt.storage === "d1-test" && rt.test !== null) {
      // The gate above is what authorises; nothing here re-decides it. A body the gate could
      // not parse keeps the pipeline's own contract rather than inventing a second one.
      if (gateUpdate === null) return json(400, fail("VALIDATION_FAILED", "Malformed update.", requestId, { reason: "unparseable" }));
      const response = await handleTestUpdate(
        rt.test,
        gateUpdate,
        requestId,
        (event) => console.log(JSON.stringify(event)),
      );
      ctx.waitUntil(rt.deferred.settle().then(() => releasePool(rt)));
      return response;
    }
    if (rt.pipeline === null) return json(503, fail("TELEGRAM_NOT_CONFIGURED", "Telegram is not configured.", requestId));

    // The PostgreSQL branch is measured, not assumed, on what a dead database looks like: with no
    // wrapper here a connection failure escaped the handler as an unhandled rejection (it killed a
    // Node harness process outright, code 3D000), which on Workers means an 1101 with no code an
    // operator can grep for. An escaping error is not a false success — Telegram retries whatever it
    // cannot read — but a structured 5xx is a *diagnosable* one, and it keeps the update unacknowledged.
    let result;
    try {
      result = await rt.pipeline.acceptDeferred(bodyText, "webhook");
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code?: string }).code).slice(0, 40) : "unknown";
      console.log(JSON.stringify({ level: "error", event: "telegram.store_unavailable", code, requestId }));
      ctx.waitUntil(rt.deferred.settle().then(() => releasePool(rt)));
      return json(503, fail("TELEGRAM_STORE_UNAVAILABLE", "The Telegram store could not be reached, so this update is not acknowledged.", requestId, { code }));
    }
    // No flush step: every task the pipeline deferred is already inside
    // `ctx.waitUntil`, so this response cannot strand work, and no other request
    // can consume it. `deferred.outstanding` is the observable of that claim.
    // Only after that work is done do we close this invocation's connections, and we
    // close them inside waitUntil so the runtime still attributes them to this request.
    ctx.waitUntil(rt.deferred.settle().then(() => releasePool(rt)));
    switch (result.status) {
      case "accepted":
        return json(200, ok({ accepted: true }));
      case "duplicate":
        // Delivered and already handled: anything else makes Telegram retry forever.
        return json(200, ok({ accepted: false, duplicate: true }));
      case "malformed":
        return json(400, fail("VALIDATION_FAILED", "Malformed update.", requestId, { reason: result.reason }));
      case "wrong_consumer":
        return json(409, fail("TELEGRAM_MODE_CONFLICT", "Update mode mismatch.", requestId));
    }
  },

  /** Draft expiry: the API sweeps in-process; on Workers that becomes a Cron Trigger. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const rt = composeRuntime(env, ctx);
    if (rt.journal === null) return;
    const expired = await rt.journal.expireStale().catch(() => 0);
    // Periodic work lives here, not on the reply path — see `PgRateLimitStore.sweepExpired`.
    const swept = await rt.rateSweep?.().catch(() => 0) ?? 0;
    await releasePool(rt);
    if (expired > 0) console.log(JSON.stringify({ level: "info", event: "telegram.drafts_expired", count: expired }));
    if (swept > 0) console.log(JSON.stringify({ level: "info", event: "telegram.rate_limits_swept", count: swept }));
  },
};
