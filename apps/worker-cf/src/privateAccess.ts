/**
 * The private-test access gate, on its own — and not only for tidiness.
 *
 * `index.ts` must export nothing but the handler, because workerd treats every other named
 * export of a Worker's entry module as a candidate entrypoint and refuses to start
 * (`Incorrect type for map entry 'TEST_USER_ID_KEY'`). A control that cannot be imported cannot
 * be tested either, so it lives here; `src/privateAccess.test.ts` covers it, and `index.ts`
 * calls into it before any runtime is composed.
 *
 * The rules, all of them load-bearing:
 *  - the allowed id comes only from the `TELEGRAM_TEST_USER_ID` secret, never from a field a
 *    user can type into (`message.text`, `callback_query.data`, a URL parameter);
 *  - the sender is read from `from.id` of an update that already passed `telegramUpdateSchema`;
 *  - unset or malformed ⇒ refuse everybody (fail closed), foreign or unattested ⇒ 200/drop so
 *    Telegram stops redelivering and the Free-plan request ceiling is not burned on refusals.
 */
import type { TelegramUpdate } from "@velora/contracts";

/** Deliberately structural: the gate does not depend on the whole `Env`, only on its one secret. */

export const TEST_USER_ID_KEY = "TELEGRAM_TEST_USER_ID";

const ALLOWED_ID_RE = /^[1-9][0-9]{0,18}$/;

export type AccessState =
  | { readonly valid: false; readonly configured: false; readonly note: "UNCONFIGURED"; readonly userId: null }
  | { readonly valid: false; readonly configured: true; readonly note: "INVALID"; readonly userId: null }
  | { readonly valid: true; readonly configured: true; readonly note: "ok"; readonly userId: string };

export const accessState = (env: { TELEGRAM_TEST_USER_ID?: string }): AccessState => {
  const raw = (env[TEST_USER_ID_KEY] ?? "").trim();
  if (raw === "") return { valid: false, configured: false, note: "UNCONFIGURED", userId: null };
  // Two independent checks: the shape, then whether JS can still compare it exactly.
  if (!ALLOWED_ID_RE.test(raw) || !Number.isSafeInteger(Number(raw))) {
    return { valid: false, configured: true, note: "INVALID", userId: null };
  }
  return { valid: true, configured: true, note: "ok", userId: raw };
};

export const senderOf = (update: TelegramUpdate): number | null =>
  update.callback_query?.from.id ?? update.message?.from?.id ?? update.edited_message?.from?.id ?? null;

export type AccessDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly status: 200 | 503;
      readonly code:
        | "ACCESS_GATE_UNCONFIGURED"
        | "ACCESS_GATE_INVALID"
        | "SENDER_UNVERIFIED"
        | "SENDER_ID_UNSAFE"
        | "UNAUTHORIZED_SENDER";
      readonly event: "telegram.access_gate_refused" | "telegram.access_denied";
      readonly message: string;
    };

export const decideAccess = (state: AccessState, update: TelegramUpdate | null): AccessDecision => {
  if (!state.valid) {
    return state.configured
      ? {
          allow: false,
          status: 503,
          code: "ACCESS_GATE_INVALID",
          event: "telegram.access_gate_refused",
          message: `${TEST_USER_ID_KEY} is not a plain positive integer; refusing every update.`,
        }
      : {
          allow: false,
          status: 503,
          code: "ACCESS_GATE_UNCONFIGURED",
          event: "telegram.access_gate_refused",
          message: `${TEST_USER_ID_KEY} is not set; this deployment only serves one test account.`,
        };
  }
  if (update === null) return { allow: true };
  const sender = senderOf(update);
  if (sender === null) {
    return {
      allow: false,
      status: 200,
      code: "SENDER_UNVERIFIED",
      event: "telegram.access_denied",
      message: "The update carries no sender Telegram can attest.",
    };
  }
  if (!Number.isSafeInteger(sender)) {
    return {
      allow: false,
      status: 200,
      code: "SENDER_ID_UNSAFE",
      event: "telegram.access_denied",
      message: "The sender id is outside the exactly-representable integer range.",
    };
  }
  if (String(sender) !== state.userId) {
    return {
      allow: false,
      status: 200,
      code: "UNAUTHORIZED_SENDER",
      event: "telegram.access_denied",
      message: "This bot is in private test mode.",
    };
  }
  return { allow: true };
};
