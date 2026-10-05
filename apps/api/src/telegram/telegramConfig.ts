// Telegram configuration — environment-only, fail-closed (ADR-018).
//
// Mirrors `apps/api/src/metaapi/metaApiConfig.ts` deliberately: a pure function
// over an env record, returning CODED findings whose messages never embed the
// configured value, plus an opaque secret holder that is awkward to log.
//
// WHY A MISSING BOT TOKEN IS NOT A BOOT FAILURE
//   ADR-014 §5 sets the rule for a third-party integration: an absent provider
//   credential makes the capability ABSENT, not the installation unbootable. A
//   missing Telegram token means the web product is completely unaffected, every
//   Telegram route answers its documented fail-closed 503, and `/ready` stays
//   green — exactly as a missing METAAPI_PLATFORM_TOKEN behaves. (The master key
//   IS a boot failure because stored ciphertext would become undecryptable; that
//   reasoning does not apply to a bot token.)
//
//   TG-001  TELEGRAM_BOT_TOKEN missing/empty      capability unavailable
//   TG-002  TELEGRAM_BOT_TOKEN malformed          capability unavailable
//   TG-003  TELEGRAM_BOT_USERNAME missing/malformed  LINKING unavailable
//   TG-004  TELEGRAM_WEBHOOK_SECRET missing/malformed  INGRESS unavailable
//   TG-005  VELORA_APP_URL/APP_ORIGIN missing or not an absolute https URL
//           → onboarding button unavailable (the bot says so rather than
//           inventing a destination)
//   TG-006  TELEGRAM_UPDATE_MODE missing/not webhook|polling
//           → the update stream has NO consumer: links can still be created and
//           the web surfaces work, but the bot never answers. Explicit, because
//           "which consumer owns the stream" is a deployment decision that must
//           never be guessed (two consumers on one stream is a data-integrity
//           bug, not a load-balancing choice).
//   TG-007  TELEGRAM_UPDATE_MODE=polling in production → refused, capability off
//           (see the mode rules below)
//
// PARTIAL CAPABILITY IS A REAL STATE AND IS MODELLED AS ONE. A deployment can
// legitimately have a bot token but no webhook secret (polling in development),
// or a token and secret but no public app URL. Each need is reported separately
// so an operator sees which half is missing instead of one undifferentiated
// "Telegram is not configured".

import { timingSafeEqual } from "node:crypto";

export type TelegramFindingCode = "TG-001" | "TG-002" | "TG-003" | "TG-004" | "TG-005" | "TG-006" | "TG-007";

/**
 * Who consumes the update stream.
 *
 *   webhook  — Telegram delivers to POST /api/v1/webhooks/telegram (production)
 *   polling  — this process calls getUpdates in a loop (development/staging)
 *   off      — nobody; the bot does not respond (web surfaces still work)
 *
 * EXACTLY ONE. A long-polling consumer and a webhook consumer on the same bot
 * both receive the same updates: the dedupe table would prevent duplicate
 * JOURNAL entries, but the second consumer's replies, consumed link tokens and
 * rate-limit accounting are still real work caused by a configuration mistake.
 * The mode is therefore a required, explicit choice, and the two adapters never
 * coexist (see `telegramPoller.ts` and `telegramRoutes.ts`).
 */
export type TelegramUpdateMode = "webhook" | "polling" | "off";

export interface TelegramFinding {
  readonly code: TelegramFindingCode;
  /** Fixed text — never embeds the configured value. */
  readonly message: string;
}

export interface TelegramEnv {
  readonly TELEGRAM_BOT_TOKEN?: string | undefined;
  readonly TELEGRAM_BOT_USERNAME?: string | undefined;
  readonly TELEGRAM_WEBHOOK_SECRET?: string | undefined;
  readonly TELEGRAM_UPDATE_MODE?: string | undefined;
  readonly VELORA_APP_URL?: string | undefined;
  readonly APP_ORIGIN?: string | undefined;
  /** Only used to refuse polling in a deployed environment (TG-007). */
  readonly APP_ENV?: string | undefined;
}

/**
 * An opaque secret holder.
 *
 * `toJSON`/`toString` reveal nothing, so `JSON.stringify(config)`, template
 * interpolation and console.log cannot leak the value by accident. `reveal()`
 * is the single reviewable choke point — and it is called in exactly one place
 * (the Bot API URL builder), never in a log statement.
 */
export class SecretValue {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return "[redacted]";
  }
  toString(): string {
    return "[redacted]";
  }
}

/**
 * Telegram bot tokens have a documented shape: `<bot_id>:<secret>`, where the id
 * is the numeric part of the bot's user id and the secret is a 30+ character
 * base64url-ish string. Validating the shape catches the two mistakes that
 * actually happen — a truncated paste and the wrong variable (e.g. a Gemini key
 * dropped into TELEGRAM_BOT_TOKEN) — before an outbound call is attempted.
 */
const BOT_TOKEN_RE = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
/**
 * Telegram's own requirement for `setWebhook`'s `secret_token`: 1–256 chars from
 * `A-Za-z0-9_-`. The floor is raised to 16 here so a guessable string cannot be
 * the only thing standing in front of the ingress — the value is a shared secret
 * presented on every delivery.
 */
const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;

export interface TelegramResolution {
  readonly botToken: SecretValue | null;
  readonly botUsername: string | null;
  readonly webhookSecret: SecretValue | null;
  /** Absolute https origin for the onboarding link, or null. Safe to log. */
  readonly appUrl: string | null;
  readonly findings: readonly TelegramFinding[];
  /** True when the bot can send and receive — the gate for the whole capability. */
  readonly configured: boolean;
  /** True when a linking deep link can be produced. */
  readonly linkingConfigured: boolean;
  /** True when the public webhook ingress can authenticate deliveries. */
  readonly webhookConfigured: boolean;
  /** The one consumer that owns the update stream. */
  readonly updateMode: TelegramUpdateMode;
  /** True when the update stream has a live consumer on this installation. */
  readonly updatesConsumed: boolean;
}

/**
 * Resolve the Telegram configuration. No I/O, no default credential, no
 * generated fallback of any kind.
 */
export function resolveTelegramConfig(env: TelegramEnv): TelegramResolution {
  const findings: TelegramFinding[] = [];
  const rawToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const rawUsername = (env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "");
  const rawSecret = (env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  // An EMPTY variable is a normal deployment state (a compose file or a build
  // arg that sets `VELORA_APP_URL=`), and `??` would stop at the empty string
  // instead of falling through — so the fallback is expressed on the trimmed
  // value rather than on nullishness.
  const rawAppUrl = (env.VELORA_APP_URL ?? "").trim() !== "" ? (env.VELORA_APP_URL ?? "").trim() : (env.APP_ORIGIN ?? "").trim();

  let botToken: SecretValue | null = null;
  if (rawToken === "") {
    findings.push({ code: "TG-001", message: "TELEGRAM_BOT_TOKEN is not configured." });
  } else if (!BOT_TOKEN_RE.test(rawToken)) {
    findings.push({ code: "TG-002", message: "TELEGRAM_BOT_TOKEN is malformed." });
  } else {
    botToken = new SecretValue(rawToken);
  }

  let botUsername: string | null = null;
  if (rawUsername === "") {
    findings.push({ code: "TG-003", message: "TELEGRAM_BOT_USERNAME is not configured." });
  } else if (!BOT_USERNAME_RE.test(rawUsername)) {
    findings.push({ code: "TG-003", message: "TELEGRAM_BOT_USERNAME is malformed." });
  } else {
    botUsername = rawUsername;
  }

  let webhookSecret: SecretValue | null = null;
  if (rawSecret === "") {
    findings.push({ code: "TG-004", message: "TELEGRAM_WEBHOOK_SECRET is not configured." });
  } else if (!WEBHOOK_SECRET_RE.test(rawSecret)) {
    findings.push({ code: "TG-004", message: "TELEGRAM_WEBHOOK_SECRET is malformed (16-256 chars of A-Za-z0-9_-)." });
  } else {
    webhookSecret = new SecretValue(rawSecret);
  }

  let appUrl: string | null = null;
  if (rawAppUrl === "") {
    findings.push({ code: "TG-005", message: "Neither VELORA_APP_URL nor APP_ORIGIN is configured." });
  } else {
    try {
      const parsed = new URL(rawAppUrl);
      // The origin is where a human clicks, and the deep-link handshake carries
      // a linking token through it, so plaintext is refused (ADR-013's rule for
      // origins). Loopback is allowed for local development only.
      const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
        findings.push({ code: "TG-005", message: "The configured application URL must be absolute https (loopback http is allowed for development)." });
      } else {
        appUrl = parsed.origin;
      }
    } catch {
      findings.push({ code: "TG-005", message: "The configured application URL is not a parseable URL." });
    }
  }

  // ── The consumer decision ────────────────────────────────────────────────
  const rawMode = (env.TELEGRAM_UPDATE_MODE ?? "").trim().toLowerCase();
  const isProduction = (env.APP_ENV ?? "").trim().toLowerCase() === "production";
  let updateMode: TelegramUpdateMode = "off";
  if (rawMode === "webhook") {
    // A webhook consumer without a secret would accept unsigned deliveries from
    // anyone who knows the path, so the mode is only honoured when the secret
    // that authenticates the ingress is valid.
    if (webhookSecret === null) {
      findings.push({ code: "TG-004", message: "TELEGRAM_UPDATE_MODE=webhook requires a valid TELEGRAM_WEBHOOK_SECRET." });
    } else {
      updateMode = "webhook";
    }
  } else if (rawMode === "polling") {
    // POLLING IS A DEVELOPMENT/STAGING MODE. In a deployed installation the
    // process may be scaled to more than one replica, and a second replica would
    // become a second consumer on the same stream (Telegram answers concurrent
    // getUpdates with 409, and whichever process wins answers the user). The
    // production path is the webhook.
    if (isProduction) {
      findings.push({ code: "TG-007", message: "TELEGRAM_UPDATE_MODE=polling is refused in production; use the webhook ingress." });
    } else {
      updateMode = "polling";
    }
  } else {
    findings.push({ code: "TG-006", message: "TELEGRAM_UPDATE_MODE must be explicitly 'webhook' or 'polling'." });
  }

  const configured = botToken !== null;
  return {
    botToken,
    botUsername,
    webhookSecret,
    appUrl,
    findings,
    configured,
    linkingConfigured: configured && botUsername !== null && appUrl !== null,
    webhookConfigured: configured && webhookSecret !== null,
    updateMode,
    updatesConsumed: configured && updateMode !== "off",
  };
}

/**
 * Fail-closed comparison for the secret token Telegram presents on every
 * delivery (`X-Telegram-Bot-Api-Secret-Token`).
 *
 * Constant-time, because a byte-by-byte early exit leaks the prefix of a shared
 * secret. Length is not secret and is compared first (the same reasoning as
 * `webhooks/signature.ts`).
 */
export function webhookSecretMatches(expected: string, presented: string | null | undefined): boolean {
  if (presented === null || presented === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented.trim(), "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
