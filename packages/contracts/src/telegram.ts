// Telegram client contract — ADR-018.
//
// WHY THIS IS A CONTRACT AND NOT A SERVICE DETAIL.
//   Two independent surfaces depend on the same vocabulary: the web application
//   (`Settings → Telegram` renders a connection STATE) and the bot (which renders
//   onboarding/confirmation flows for the same states). If each derived its own
//   strings they would drift, and "what does the user see" would stop being one
//   answer. The vocabulary below is therefore frozen here, exactly as the locale
//   and RBAC vocabularies are.
//
// TELEGRAM IS AN EXTERNAL IDENTITY PROVIDER, NOT AN ACCOUNT SYSTEM.
//   Nothing here models a password, an email, a login or a session. `telegram_user_id`
//   is Telegram's stable numeric id; `@username` is display-only metadata that can
//   be changed or removed by its owner at any time, so it is NEVER an identifier.
import { z } from "zod";

/**
 * The connection states a user can observe — in the web UI and in the bot.
 *
 * SIX STATES, THREE SOURCES. `NOT_LINKED`, `LINKED` and `LINK_REVOKED` come from
 * `telegram_identities.status`; `LINK_PENDING` and `LINK_EXPIRED` come from the
 * one-time linking transaction (`telegram_link_tokens`); `LINK_ERROR` is the
 * honest name for "the server could not determine the state" — it is never a
 * silent downgrade to `NOT_LINKED`, because telling a linked user they are
 * unlinked would invite them to re-link unnecessarily.
 */
export const TELEGRAM_LINK_STATES = [
  "NOT_LINKED",
  "LINK_PENDING",
  "LINKED",
  "LINK_EXPIRED",
  "LINK_REVOKED",
  "LINK_ERROR",
] as const;
export type TelegramLinkState = (typeof TELEGRAM_LINK_STATES)[number];

/** The state a Telegram identity is in when it has never been linked. */
export const TELEGRAM_DEFAULT_LINK_STATE: TelegramLinkState = "NOT_LINKED";

/**
 * Webhook ingress path. Mirrors the MetaAPI ingress convention
 * (`/api/v1/webhooks/metaapi`), so both external deliveries live under one
 * predictable prefix and are registered before any authenticated handler.
 */
export const TELEGRAM_WEBHOOK_PATH = "/api/v1/webhooks/telegram";

/** Authenticated linking/status surface consumed by the web application. */
export const TELEGRAM_STATUS_PATH = "/api/v1/telegram/status";
export const TELEGRAM_LINK_START_PATH = "/api/v1/telegram/link/start";
export const TELEGRAM_LINK_UNLINK_PATH = "/api/v1/telegram/link/unlink";
export const TELEGRAM_CHANNEL_PATH = "/api/v1/telegram/channel";

/** Commands the bot answers. Declared so `setMyCommands` and the router agree. */
export const TELEGRAM_COMMANDS = [
  "start",
  "help",
  "journal",
  "last",
  "history",
  "analyze",
  "settings",
  "link",
  "unlink",
] as const;
export type TelegramCommand = (typeof TELEGRAM_COMMANDS)[number];

/**
 * One-time linking token parameters.
 *
 * 32 random bytes (256 bits) is far beyond guessing range; the raw value is
 * base64url-encoded for a URL-safe deep link and only its SHA-256 is stored.
 * The TTL is short because the token is a bearer credential for the duration of
 * the linking handshake, and single-use because a consumed token must be useless
 * to anyone who later observes it (browser history, clipboard, screenshots).
 */
export const TELEGRAM_LINK_TOKEN_BYTES = 32;
export const TELEGRAM_LINK_TOKEN_TTL_SECONDS = 600; // 10 minutes
/** Unconfirmed journal drafts stop being actionable after this window. */
export const TELEGRAM_DRAFT_TTL_SECONDS = 1800; // 30 minutes

/**
 * Environment variable NAMES. Names only — never values, never defaults, never
 * a fallback token. Resolution lives in `apps/api/src/telegram/telegramConfig.ts`.
 */
export const TELEGRAM_CONFIG_ENV = {
  /** Bot token from @BotFather. SECRET. */
  botToken: "TELEGRAM_BOT_TOKEN",
  /** The bot's public @username (deep links are built from it). Non-secret. */
  botUsername: "TELEGRAM_BOT_USERNAME",
  /** `secret_token` presented by Telegram on every webhook delivery. SECRET. */
  webhookSecret: "TELEGRAM_WEBHOOK_SECRET",
  /**
   * Base URL of the Velora web application used for the onboarding button.
   * Falls back to APP_ORIGIN (ADR-013) — never a hardcoded production URL.
   */
  appUrl: "VELORA_APP_URL",
} as const;

/**
 * Telegram's own limits, encoded so the bot cannot produce an invalid call.
 * `sendMessage` text is capped at 4096 characters by the Bot API; the bot's
 * renderer truncates deterministically rather than letting Telegram reject it.
 */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
/** Bot API caption limit (used when a journal post carries a photo). */
export const TELEGRAM_MAX_CAPTION_CHARS = 1024;

/** Deep link that starts the linking handshake inside Telegram. */
export function telegramDeepLink(botUsername: string, token: string): string {
  return `https://t.me/${botUsername.replace(/^@/, "")}?start=${encodeURIComponent(token)}`;
}

/**
 * Payload accepted from Telegram's webhook.
 *
 * DELIBERATELY NARROW. Telegram sends many update kinds and adds fields over
 * time, so unknown properties are allowed (`.passthrough()` semantics by
 * omission) while every field this platform READS is validated — an unvalidated
 * `update_id` would silently break the idempotency claim, which is the one
 * guarantee that stands between a Telegram retry and a duplicated journal entry.
 */
const telegramUserSchema = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
  username: z.string().max(64).optional(),
  first_name: z.string().max(255).optional(),
});

const telegramChatSchema = z.object({
  id: z.number().int(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().max(255).optional(),
  username: z.string().max(64).optional(),
});

const telegramMessageSchema = z.object({
  message_id: z.number().int().positive(),
  from: telegramUserSchema.optional(),
  chat: telegramChatSchema,
  date: z.number().int().nonnegative(),
  text: z.string().max(8192).optional(),
  caption: z.string().max(2048).optional(),
  voice: z
    .object({
      file_id: z.string().min(1).max(256),
      duration: z.number().int().nonnegative().optional(),
      mime_type: z.string().max(64).optional(),
      file_size: z.number().int().nonnegative().optional(),
    })
    .optional(),
  audio: z
    .object({
      file_id: z.string().min(1).max(256),
      duration: z.number().int().nonnegative().optional(),
      mime_type: z.string().max(64).optional(),
      file_size: z.number().int().nonnegative().optional(),
    })
    .optional(),
  photo: z
    .array(
      z.object({
        file_id: z.string().min(1).max(256),
        file_unique_id: z.string().max(256).optional(),
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
        file_size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(8)
    .optional(),
  document: z
    .object({
      file_id: z.string().min(1).max(256),
      file_name: z.string().max(255).optional(),
      mime_type: z.string().max(64).optional(),
      file_size: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: telegramMessageSchema.optional(),
  edited_message: telegramMessageSchema.optional(),
  callback_query: z
    .object({
      id: z.string().min(1).max(128),
      from: telegramUserSchema,
      message: z
        .object({
          message_id: z.number().int().positive(),
          chat: telegramChatSchema,
        })
        .optional(),
      data: z.string().max(64).optional(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type TelegramCallbackQuery = NonNullable<TelegramUpdate["callback_query"]>;

/** The three inbound kinds this platform acts on. */
export type TelegramUpdateKind = "message" | "callback_query" | "edited_message" | "other";

/** Classify an update for the dedupe/observability row. */
export function classifyUpdate(update: TelegramUpdate): TelegramUpdateKind {
  if (update.message !== undefined) return "message";
  if (update.callback_query !== undefined) return "callback_query";
  if (update.edited_message !== undefined) return "edited_message";
  return "other";
}

/**
 * Button callback payloads.
 *
 * Telegram caps callback data at 64 bytes, so each value is a compact
 * `verb:subject` pair. The subject is a DRAFT id or a fixed selector — never an
 * amount, a price, a user id or anything a user could tamper with to widen their
 * own authority. Callback data arrives from the client and is therefore treated
 * as UNTRUSTED input; the server resolves ownership from the Telegram identity
 * on the callback itself, not from the payload.
 */
export const CALLBACK_ACTIONS = [
  "confirm", // confirm the pending draft — subject is the draft id
  "cancel", // discard the pending draft — subject is the draft id
  "edit", // show which fields can still be supplied
  "menu", // main-menu navigation — subject is a fixed destination
  "unlink", // unlink confirmation — subject is `yes` | `no`
  "history_more", // paginate history — subject is the page number
  "channel_test", // send a test post to the bound channel
  "connect", // re-show the secure-connection instructions
] as const;
export type CallbackAction = (typeof CALLBACK_ACTIONS)[number];

/** Destinations a `menu:` callback may name. A closed set — never free text. */
export const MENU_TARGETS = ["journal", "last", "history", "analyze", "settings"] as const;
export type MenuTarget = (typeof MENU_TARGETS)[number];

const CALLBACK_RE = /^(confirm|cancel|edit|menu|unlink|history_more|channel_test|connect):([A-Za-z0-9_-]{1,48})$/;

export function parseCallbackData(data: string): { action: CallbackAction; subject: string } | null {
  const match = CALLBACK_RE.exec(data.trim());
  if (match === null) return null;
  return { action: match[1] as CallbackAction, subject: match[2] as string };
}

export function buildCallbackData(action: CallbackAction, subject: string): string {
  return `${action}:${subject}`;
}
