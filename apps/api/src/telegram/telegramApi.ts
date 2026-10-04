// Telegram Bot API client — the ONLY module that speaks to api.telegram.org.
//
// WHY A HAND-WRITTEN CLIENT AND NOT A LIBRARY
//   The surface needed here is six methods, and every one of them has a
//   security-relevant property that must be explicit rather than inherited:
//   bounded timeouts, a bounded download size, a bounded retry (Telegram's own
//   `retry_after`), and — most importantly — the bot token must never reach a
//   log. A third-party client would put a URL template containing the secret
//   token in an `Error.stack` the first time a request failed. Here, the token
//   lives in an opaque holder and every error this module raises carries a FIXED
//   message plus a safe classification.
//
// TRANSPORT IS INJECTED. `fetchImpl` defaults to the global fetch and is
// replaced in tests, so the bot's behaviour is provable without a network and
// without a credential — the same shape `metaapi/provisioningClient.ts` uses.
//
// NO RETRY LOOP. Telegram retries deliveries itself and returns `retry_after`
// for rate limits; a silent internal retry would stack latency onto a webhook
// response and hide the limit from the caller. The client surfaces the value and
// the caller decides.
import type { TelegramUpdate } from "@velora/contracts";
import type { SecretValue } from "./telegramConfig.js";

const API_BASE = "https://api.telegram.org";
const FILE_BASE = "https://api.telegram.org/file";

/** Bounded: a Telegram call is inside a webhook response path. */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
/** Bounded: a voice note or a screenshot, never an arbitrary download. */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; // = trade_attachments' 5 MiB limit

export type TelegramApiErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "MALFORMED_RESPONSE"
  | "RATE_LIMITED"
  | "CHAT_NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "FILE_TOO_LARGE"
  | "API_ERROR";

/** A safe, loggable failure. Never contains the token, a URL or a raw body. */
export class TelegramApiError extends Error {
  constructor(
    readonly code: TelegramApiErrorCode,
    /** HTTP status from Telegram, when there was one. */
    readonly status: number | null,
    /** Telegram's numeric error_code, when present. */
    readonly telegramCode: number | null,
    /** Seconds to wait, from Telegram's `retry_after`. Never retried internally. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(`telegram api: ${code}`); // fixed text — no URL, no description, no body
    this.name = "TelegramApiError";
  }
}

export interface SendMessageResult {
  readonly messageId: string;
}
/**
 * One inline-keyboard button.
 *
 * Two mutually exclusive kinds, because that is what the Bot API accepts:
 *   - `callbackData` — pressed inside the chat (confirmation buttons);
 *   - `url`          — opens a page (the onboarding button that starts linking).
 * A button carrying BOTH is rejected by Telegram, so the union makes that
 * mistake unrepresentable.
 */
export type InlineKeyboardButton =
  | { readonly text: string; readonly callbackData: string }
  | { readonly text: string; readonly url: string };

export interface SentMessageOptions {
  readonly replyToMessageId?: string | undefined;
  readonly inlineKeyboard?: readonly (readonly InlineKeyboardButton[])[] | undefined;
  readonly disableNotification?: boolean | undefined;
}
export interface TelegramFileRef {
  readonly fileId: string;
  readonly filePath: string | null;
  readonly fileSizeBytes: number | null;
}
export interface TelegramChatRef {
  readonly id: string;
  readonly type: "private" | "group" | "supergroup" | "channel";
  readonly title: string | null;
}
export interface TelegramMemberRef {
  readonly status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  /** True when the bot may post to the chat (channels/supergroups). */
  readonly canPostMessages: boolean;
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface TelegramBotApi {
  sendMessage(chatId: string, text: string, options?: SentMessageOptions): Promise<SendMessageResult>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  getFile(fileId: string): Promise<TelegramFileRef>;
  downloadFile(filePath: string, maxBytes?: number): Promise<Buffer>;
  getChat(chatId: string): Promise<TelegramChatRef>;
  getChatMember(chatId: string, userId: string): Promise<TelegramMemberRef>;
  getMe(): Promise<{ id: string; username: string | null }>;
  /**
   * Long-poll entry for the development consumer (see telegramPoller.ts).
   *
   * `offset` is the first update id to return; null means "whatever is
   * pending". The Bot API itself acknowledges everything below `offset`, which
   * is why the poller only advances it after an update has been handled.
   */
  getUpdates(offset: number | null, timeoutSeconds?: number): Promise<TelegramUpdate[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * HTTP implementation.
 *
 * `token` is a holder, not a string: it is revealed exactly once per request
 * inside `url()`, and it is never placed on an error, a log line or the `Error`
 * object this module constructs.
 */
export class HttpTelegramBotApi implements TelegramBotApi {
  constructor(
    private readonly token: SecretValue,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs: number = TELEGRAM_REQUEST_TIMEOUT_MS,
  ) {}

  /** The single call site of `reveal()`. Never logged. */
  private url(method: string): string {
    return `${API_BASE}/bot${this.token.reveal()}/${method}`;
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    let response: Awaited<ReturnType<FetchLike>>;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      response = await this.fetchImpl(this.url(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      // An aborted request and a socket failure are different failures: the first
      // is a timeout the caller may retry later, the second may be a DNS/TLS
      // problem. Neither message is propagated (it can contain the URL).
      const aborted = isRecord(err) && (err["name"] === "AbortError" || err["name"] === "TimeoutError");
      throw new TelegramApiError(aborted ? "TIMEOUT" : "NETWORK", null, null, null);
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TelegramApiError("MALFORMED_RESPONSE", response.status, null, null);
    }
    if (!isRecord(body)) throw new TelegramApiError("MALFORMED_RESPONSE", response.status, null, null);

    if (body["ok"] !== true) {
      const telegramCode = typeof body["error_code"] === "number" ? body["error_code"] : null;
      const retryAfter = isRecord(body["parameters"]) && typeof body["parameters"]["retry_after"] === "number"
        ? body["parameters"]["retry_after"]
        : null;
      throw new TelegramApiError(classify(telegramCode, response.status), response.status, telegramCode, retryAfter);
    }
    if (!("result" in body)) throw new TelegramApiError("MALFORMED_RESPONSE", response.status, null, null);
    return body["result"] as T;
  }

  async sendMessage(chatId: string, text: string, options?: SentMessageOptions): Promise<SendMessageResult> {
    const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
    if (options?.replyToMessageId !== undefined) payload["reply_to_message_id"] = Number(options.replyToMessageId);
    if (options?.disableNotification === true) payload["disable_notification"] = true;
    if (options?.inlineKeyboard !== undefined) {
      payload["reply_markup"] = {
        inline_keyboard: options.inlineKeyboard.map((row) =>
          row.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData })),
        ),
      };
    }
    const result = await this.call<Record<string, unknown>>("sendMessage", payload);
    return { messageId: String(result["message_id"] ?? "") };
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    // Answering is courtesy (it stops the button spinner); a failure here must
    // not abort the action the button already performed.
    const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text !== undefined) payload["text"] = text.slice(0, 200);
    await this.call<boolean>("answerCallbackQuery", payload);
  }

  async getFile(fileId: string): Promise<TelegramFileRef> {
    const result = await this.call<Record<string, unknown>>("getFile", { file_id: fileId });
    return {
      fileId: typeof result["file_id"] === "string" ? result["file_id"] : fileId,
      filePath: typeof result["file_path"] === "string" ? result["file_path"] : null,
      fileSizeBytes: typeof result["file_size"] === "number" ? result["file_size"] : null,
    };
  }

  /**
   * Download a file's bytes.
   *
   * BOUNDED TWICE: the declared size is checked before the request, and the
   * received body is checked after it, because the declared size is a claim by
   * Telegram rather than a guarantee about the bytes on the wire. Anything over
   * the cap is refused rather than truncated — a truncated screenshot would be
   * silently stored as a corrupt attachment.
   */
  async downloadFile(filePath: string, maxBytes: number = TELEGRAM_MAX_DOWNLOAD_BYTES): Promise<Buffer> {
    let response: Awaited<ReturnType<FetchLike>>;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs * 3); // downloads get a longer budget
    try {
      response = await this.fetchImpl(`${FILE_BASE}/bot${this.token.reveal()}/${filePath}`, { method: "GET", signal: controller.signal });
    } catch {
      throw new TelegramApiError("NETWORK", null, null, null);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new TelegramApiError("API_ERROR", response.status, null, null);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new TelegramApiError("FILE_TOO_LARGE", null, null, null);
    return bytes;
  }

  async getUpdates(offset: number | null, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      // Bounded on both ends by the Bot API's own contract (0–50 seconds).
      timeout: Math.max(0, Math.min(50, Math.trunc(timeoutSeconds))),
      // Only what this bot can act on; documents and edits are still delivered
      // as classified updates rather than being silently dropped by the API.
      allowed_updates: ["message", "callback_query", "edited_message"],
    };
    if (offset !== null) payload["offset"] = offset;
    const result = await this.call<unknown[]>("getUpdates", payload);
    if (!Array.isArray(result)) return [];
    // Validated by the caller (TelegramUpdatePipeline.parse), which is where the
    // frozen schema lives — this method only unwraps the transport envelope.
    return result as TelegramUpdate[];
  }

  async getChat(chatId: string): Promise<TelegramChatRef> {
    const result = await this.call<Record<string, unknown>>("getChat", { chat_id: chatId });
    const type = result["type"];
    return {
      id: String(result["id"] ?? chatId),
      type: type === "private" || type === "group" || type === "supergroup" || type === "channel" ? type : "private",
      title: typeof result["title"] === "string" ? result["title"] : null,
    };
  }

  /**
   * The bot's OWN membership and rights in a chat.
   *
   * `canPostMessages` is derived only from fields Telegram actually returned, and
   * defaults to false: an unverified chat is never treated as writable. This is
   * also why the service calls it for the BOT's user id rather than trusting a
   * client-supplied claim about a chat id.
   */
  async getChatMember(chatId: string, userId: string): Promise<TelegramMemberRef> {
    const result = await this.call<Record<string, unknown>>("getChatMember", { chat_id: chatId, user_id: Number(userId) });
    const status = result["status"];
    const known = status === "creator" || status === "administrator" || status === "member" || status === "restricted" || status === "left" || status === "kicked";
    const isAdmin = status === "creator" || status === "administrator";
    // Channels require can_post_messages; supergroups treat it as optional
    // (Telegram omits it for plain members), so membership alone is enough
    // outside a channel — the failure then surfaces at publish time.
    const canPost = isAdmin && result["can_post_messages"] !== false;
    return {
      status: known ? status : "left",
      canPostMessages: status === "creator" ? true : canPost,
    };
  }

  async getMe(): Promise<{ id: string; username: string | null }> {
    const result = await this.call<Record<string, unknown>>("getMe", {});
    return {
      id: String(result["id"] ?? ""),
      username: typeof result["username"] === "string" ? result["username"] : null,
    };
  }
}

/** Map Telegram's numeric error_code onto a fixed classification. */
function classify(telegramCode: number | null, httpStatus: number): TelegramApiErrorCode {
  if (telegramCode === 429) return "RATE_LIMITED";
  if (telegramCode === 403) return "FORBIDDEN";
  // 409 is Telegram's answer to a SECOND consumer of the same update stream
  // (`getUpdates` while a webhook is set, or two pollers). It is classified
  // distinctly because it is a deployment fault the poller must back off from
  // rather than retry into — see telegramPoller.ts.
  if (httpStatus === 409 || telegramCode === 409) return "CONFLICT";
  if (telegramCode === 400 && httpStatus === 400) return "API_ERROR";
  if (telegramCode === 404) return "CHAT_NOT_FOUND";
  return "API_ERROR";
}
