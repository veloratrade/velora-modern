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
  // Raised HERE, before any request is made: the caller asked for something Telegram cannot accept
  // (an oversized caption, a photo reference that is not a file id or an https URL). It exists so a
  // bad argument is a named local refusal instead of a confusing `API_ERROR` from a round trip.
  | "INVALID_REQUEST"
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
  /**
   * The `file_id` of the photo in the message that was just sent, when this call sent a photo.
   *
   * WHY IT IS WORTH RETURNING. The Bot API has no "upload only" method: the only way to obtain a
   * `file_id` for an image the bot itself produced is to send it somewhere and read the id back. So
   * the publish path that uploads rasterized banner bytes captures the id here, and a later re-send
   * (a retry, or the same card on another channel) can go out as a plain JSON `sendPhoto` without
   * rasterizing or uploading a second time. Absent when Telegram did not include it.
   */
  readonly photoFileId?: string | undefined;
}

/**
 * Image BYTES to upload, as opposed to a `file_id`/URL that already exists on Telegram's side.
 *
 * `filename` is the name Telegram shows in a forwarded file's metadata. It is validated to a bare
 * name because it lands inside a multipart part header — `..`, a slash or a CR would be a header
 * injection opportunity in a field the caller controls.
 */
export interface PhotoUpload {
  readonly bytes: Buffer;
  readonly filename: string;
}

/** Telegram's own limit for a bot upload. Enforced here so the answer is local, not a 400. */
export const TELEGRAM_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.png$/u;
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

/** Telegram's own caption limit, restated here so the transport can refuse instead of failing remotely. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

export interface SentMessageOptions {
  readonly replyToMessageId?: string | undefined;
  readonly inlineKeyboard?: readonly (readonly InlineKeyboardButton[])[] | undefined;
  readonly disableNotification?: boolean | undefined;
}
/**
 * `sendPhoto` options: the send options plus a caption.
 *
 * `photo` is NOT part of this shape — see `sendPhoto`. A file reference is a separate argument
 * precisely so a caller cannot accidentally put an arbitrary string where a destination belongs.
 */
export interface SendPhotoOptions extends SentMessageOptions {
  readonly caption?: string | undefined;
}

/**
 * What `sendPhoto` accepts as an image reference, and why nothing else does.
 *
 * A Telegram `file_id` (opaque, `[0-9A-Za-z_-]{20,}`) or an absolute `https` URL. Deliberately NOT
 * accepted: a `data:` URI (the transport is JSON-only, and a 5 MiB base64 blob in a webhook response
 * is a timeout waiting to happen), an `http:` URL (a cleartext fetch from Telegram's servers to a
 * host we chose), and anything else — because the only reason to pass a string here is "Telegram
 * already has this file", and a string that is not that is a bug worth naming at the call site.
 */
export function isSendablePhotoRef(value: string): boolean {
  return /^[0-9A-Za-z_-]{20,}$/.test(value) || /^https:\/\/[^\s]+$/u.test(value);
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
  /**
   * The bot's post right IN A CHANNEL (`can_post_messages`). Telegram sends this field for channels and
   * omits it for groups and supergroups, where posting is governed by the chat's own permissions — so a
   * supergroup administrator legitimately answers `undefined` here.
   */
  readonly canPostMessages: boolean;
  /**
   * The bot's send right in a group or supergroup. Derived from `can_send_messages` for a restricted
   * member and true for a live membership otherwise; null where Telegram has no opinion to give.
   */
  readonly canSendMessages: boolean | null;
}

/**
 * Can the bot post into this chat, as Telegram itself describes it?
 *
 * WHY THIS IS ONE FUNCTION. It is asked in two places that MUST agree — binding a channel
 * (`/channel <id>`) and deciding whether a preview may be published — and they previously disagreed
 * with Telegram's own vocabulary: both required `can_post_messages` for a SUPERGROUP, where Telegram
 * only reports that field for channels. A supergroup the bot administers was therefore reported as
 * unwritable, and publishing in it was blocked forever. Measured against the live API on 2026-10-21:
 * an administrator of the ICT supergroup answers `status:"administrator"`, `can_post_messages` absent,
 * while the chat reports `permissions.can_send_messages: true`.
 */
export function botCanPostIn(chatType: "private" | "group" | "supergroup" | "channel", member: TelegramMemberRef): boolean {
  if (member.status === "left" || member.status === "kicked") return false;
  // A channel post right is `can_post_messages` — for creators the transport already reports true.
  if (chatType === "channel") return member.canPostMessages;
  // Groups and supergroups: live membership is the right. A RESTRICTED member only has what the
  // restriction left them, so its own flag is the answer; everything else is enforced by Telegram at
  // send time (slow mode, topics, …), which is where those failures belong.
  if (member.status === "restricted") return member.canSendMessages === true;
  return true;
}

/** The request shape this client is willing to make: JSON or one multipart upload, nothing else. */
export interface TelegramRequestInit {
  readonly method: string;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: string | FormData | undefined;
  readonly signal?: AbortSignal | undefined;
}

type FetchLike = (url: string, init?: TelegramRequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface TelegramBotApi {
  sendMessage(chatId: string, text: string, options?: SentMessageOptions): Promise<SendMessageResult>;
  /**
   * Photo post: the image plus an HTML caption, with the same inline-keyboard support as
   * `sendMessage`. A caption is limited to 1024 characters by Telegram, so the caller renders to
   * that budget (`TELEGRAM_CAPTION_LIMIT` in the domain) and this transport REFUSES a longer one
   * rather than discovering it remotely.
   */
  /**
   * `photo` is either a reference Telegram already holds (a `file_id` or an https URL — sent as JSON)
   * or bytes to upload (sent as `multipart/form-data`). The two shapes exist because a chart the user
   * forwarded and a banner Velora just rasterized are different situations: only the second one has a
   * reference to name.
   */
  sendPhoto(chatId: string, photo: string | PhotoUpload, options?: SendPhotoOptions): Promise<SendMessageResult>;
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

/** The one inline-keyboard encoder. Both `sendMessage` and `sendPhoto` go through it. */
/**
 * The largest size Telegram says it will re-serve without re-uploading. A bot's `sendPhoto` result
 * carries one `photo[].file_id` per rendered size; the LAST is the biggest, and the biggest is what a
 * later post wants. Nothing is invented when the array is missing: the id stays absent and the next
 * publish rasterizes again.
 */
function lastPhotoFileId(photo: unknown): string | undefined {
  if (!Array.isArray(photo) || photo.length === 0) return undefined;
  const last = photo[photo.length - 1];
  if (!isRecord(last) || typeof last["file_id"] !== "string") return undefined;
  return last["file_id"];
}

function keyboardOf(rows: readonly (readonly InlineKeyboardButton[])[]): Record<string, unknown> {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData })),
    ),
  };
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
    // Bound deliberately. `fetch` on its own is a detached reference: node tolerates it, workerd
    // throws `TypeError: Illegal invocation`, and the catch below would report that as
    // `NETWORK` for every call — indistinguishable from a real network failure. Measured on a
    // deployed Worker on 2026-10-18, which is why the default is an arrow rather than the global.
    private readonly fetchImpl: FetchLike = ((url: string, init?: RequestInit) =>
      globalThis.fetch(url, init)) as unknown as FetchLike,
    private readonly timeoutMs: number = TELEGRAM_REQUEST_TIMEOUT_MS,
    // Portability: the Cloudflare Workers host needs to point the client at a
    // staging/stub origin to verify the outbound path without touching a real bot.
    // Defaults to the production Bot API, so every existing call site and test is
    // unchanged.
    private readonly apiBase: string = API_BASE,
  ) {}

  /** The single call site of `reveal()`. Never logged. */
  private url(method: string): string {
    return `${this.apiBase === "" ? API_BASE : this.apiBase}/bot${this.token.reveal()}/${method}`;
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    return this.perform<T>(method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /**
   * A `multipart/form-data` POST. Used for an upload, because that is the only body shape the Bot API
   * accepts for bytes — and the reason the request carries NO `content-type` header of our own: the
   * boundary has to be generated by the fetch implementation, and a hand-written one would mismatch it.
   */
  private async callForm<T>(method: string, form: FormData): Promise<T> {
    return this.perform<T>(method, { method: "POST", body: form });
  }

  private async perform<T>(method: string, init: TelegramRequestInit): Promise<T> {
    let response: Awaited<ReturnType<FetchLike>>;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      response = await this.fetchImpl(this.url(method), { ...init, signal: controller.signal });
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

  async sendPhoto(chatId: string, photo: string | PhotoUpload, options?: SendPhotoOptions): Promise<SendMessageResult> {
    const caption = options?.caption;
    // The caption limit is checked before the request for both shapes: a 4000-character caption
    // rejected remotely would already have cost the upload of a 200 KB image.
    if (caption !== undefined && caption.length > TELEGRAM_CAPTION_LIMIT) {
      throw new TelegramApiError("INVALID_REQUEST", null, null, null);
    }
    const keyboard = options?.inlineKeyboard === undefined ? null : keyboardOf(options.inlineKeyboard);

    if (typeof photo === "object" && photo !== null) {
      const bytes = photo.bytes;
      if (bytes.length === 0 || bytes.length > TELEGRAM_MAX_UPLOAD_BYTES) {
        throw new TelegramApiError(bytes.length === 0 ? "INVALID_REQUEST" : "FILE_TOO_LARGE", null, null, null);
      }
      // A filename goes into a `Content-Disposition` part header, so it is a bare name or nothing.
      if (!UPLOAD_FILENAME.test(photo.filename)) throw new TelegramApiError("INVALID_REQUEST", null, null, null);
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("photo", new Blob([bytes], { type: "image/png" }), photo.filename);
      // HTML parsing for a caption, the same as the JSON path: the banner body carries <b>/<i> from the
      // template renderer, and a caption that lost its markup would show the tags as literal text.
      form.set("parse_mode", "HTML");
      if (caption !== undefined && caption !== "") form.set("caption", caption);
      if (options?.disableNotification === true) form.set("disable_notification", "true");
      if (keyboard !== null) form.set("reply_markup", JSON.stringify(keyboard));
      const sent = await this.callForm<Record<string, unknown>>("sendPhoto", form);
      return { messageId: String(sent["message_id"] ?? ""), photoFileId: lastPhotoFileId(sent["photo"]) };
    }

    if (!isSendablePhotoRef(photo)) throw new TelegramApiError("INVALID_REQUEST", null, null, null);
    const payload: Record<string, unknown> = { chat_id: chatId, photo, parse_mode: "HTML" };
    if (caption !== undefined && caption !== "") payload["caption"] = caption;
    if (options?.disableNotification === true) payload["disable_notification"] = true;
    if (keyboard !== null) payload["reply_markup"] = keyboard;
    const result = await this.call<Record<string, unknown>>("sendPhoto", payload);
    return { messageId: String(result["message_id"] ?? ""), photoFileId: lastPhotoFileId(result["photo"]) };
  }

  async sendMessage(chatId: string, text: string, options?: SentMessageOptions): Promise<SendMessageResult> {
    const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
    if (options?.replyToMessageId !== undefined) payload["reply_to_message_id"] = Number(options.replyToMessageId);
    if (options?.disableNotification === true) payload["disable_notification"] = true;
    if (options?.inlineKeyboard !== undefined) payload["reply_markup"] = keyboardOf(options.inlineKeyboard);
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
   * THE GUARANTEE THIS METHOD OWNS is the POST-check: the bytes actually received
   * are measured, and anything over `maxBytes` is refused rather than truncated —
   * a truncated screenshot would be stored as a silent, corrupt attachment. After
   * the response buffer exists there is nothing left to bound, which is why the
   * size Telegram DECLARES (`getFile().file_size`, read before the request) is
   * enforced by the CALLER: `telegramBot.fetchBytes` refuses on the declared size
   * first, so an oversized file normally costs no download at all. Neither check
   * replaces the other, and this method cannot perform the early one because the
   * declaration does not travel with `filePath`.
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
    // `can_send_messages` is only meaningful for a restricted member; for everyone else Telegram does
    // not send it and its absence is not a refusal.
    const canSend =
      status === "restricted" ? result["can_send_messages"] === true : status === "member" || isAdmin ? true : null;
    return {
      status: known ? status : "left",
      canPostMessages: status === "creator" ? true : canPost,
      canSendMessages: canSend,
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
