// Support AI — the three operator assists Legacy put in its AI module and phase 5
// recorded as open with this phase as their owner:
//
//   POST /api/v1/admin/communications/tickets/{id}/translate        (20/300)
//   POST /api/v1/admin/communications/tickets/{id}/copilot          (10/300)
//   POST /api/v1/admin/communications/tickets/{id}/copilot/draft    (10/300)
//
// THE CAPABILITY, IN BUSINESS TERMS
//   * translate — an operator reads a ticket written in the other language. They
//     may translate a stored message (by id) or a draft they are typing.
//   * copilot — an operator asks "what is this ticket about and what should I
//     do", over the ticket's own history.
//   * copilot/draft — an operator has written a reply and asks for it to be
//     tightened, made formal, or translated. THE RESULT IS NEVER SENT. It comes
//     back as a draft the operator edits and sends through the existing reply
//     route, so a model cannot write to a user on the platform's behalf.
//
// TWO PROPERTIES KEPT FROM LEGACY
//   1. Degradation, not failure: Legacy answers `200 {translation:{available:false,…}}`
//      when the AI is unavailable, because a support console must keep working
//      when the model does not. Modern keeps the shape and adds a REASON CODE —
//      `available:false` with no explanation is how an operator learns to ignore
//      the button.
//   2. The ticket must exist: `copilot/draft` 404s on an unknown ticket rather
//      than happily drafting against nothing.
//
// AUTHORIZATION is the support module's own (`support.tickets.manage` = Legacy
// `communication.reply`): these routes act on a ticket, so they answer to the
// permission that already guards replying to one. They are NOT gated by `aiManage`
// — an operator who may reply must be able to use the assist, and an AI
// administrator is a different job.

import { fail, ok } from "@velora/contracts";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";
import { capabilityAbsent, forbidden, unauthenticated } from "../routes/responses.js";
import type { AiManager } from "../ai/aiManager.js";
import { sha256 } from "../ai/aiAnalysisService.js";
import { AI_TRANSLATE_PROMPT, AI_COPILOT_PROMPT, AI_DRAFT_PROMPT, SUPPORT_AI_PROMPT_VERSION, renderTemplate } from "../ai/aiSupportPrompts.js";

const TRANSLATE = /^\/api\/v1\/admin\/communications\/tickets\/([^/]+)\/translate$/u;
const COPILOT = /^\/api\/v1\/admin\/communications\/tickets\/([^/]+)\/copilot$/u;
const COPILOT_DRAFT = /^\/api\/v1\/admin\/communications\/tickets\/([^/]+)\/copilot\/draft$/u;

/** What the AI is allowed to see of a ticket: the words, not the metadata store. */
export interface SupportTicketContext {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly messages: readonly { readonly id: string; readonly senderType: string; readonly body: string; readonly createdAt: string }[];
}

export interface SupportAiCapability {
  readonly manager: AiManager;
  readonly ticket: (ticketId: string) => Promise<SupportTicketContext | null>;
  /** The caller must hold the support manage permission; the support module owns that check. */
  readonly mayManage: (ctx: ExtendedRouteContext) => Promise<boolean>;
}

/** How much of a ticket an assist may carry. A thread is not a data export. */
export const MAX_TICKET_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 4_000;
export const MAX_DRAFT_CHARS = 4_000;

export async function handleSupportAiRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const translate = TRANSLATE.exec(ctx.path);
  const copilot = COPILOT.exec(ctx.path);
  const draft = COPILOT_DRAFT.exec(ctx.path);
  if (translate === null && copilot === null && draft === null) return null;
  if (ctx.method !== "POST") {
    return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
  }

  const capability: SupportAiCapability | null = ctx.config.supportAi ?? null;
  if (capability === null) return capabilityAbsent(ctx, "supportAi");

  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);
  if (!(await capability.mayManage(ctx))) return forbidden(ctx);

  const ticketId = String((translate ?? copilot ?? draft)![1]!);
  const body = await ctx.readBody(ctx.req);

  if (draft !== null) {
    const ticket = await capability.ticket(ticketId);
    if (ticket === null) return { status: 404, body: fail("SUPPORT_TICKET_NOT_FOUND", "Ticket not found.", ctx.requestId) };
    const text = typeof body["draft"] === "string" ? body["draft"].slice(0, MAX_DRAFT_CHARS) : "";
    if (text.trim() === "") {
      return { status: 422, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { draft: "required" }) };
    }
    const instruction = typeof body["instruction"] === "string" ? body["instruction"].slice(0, 200) : "";
    const outcome = await capability.manager.call({
      userId: claims.sub,
      feature: "copilot",
      ledgerFeature: "copilot",
      promptVersion: SUPPORT_AI_PROMPT_VERSION,
      prompt: renderTemplate(AI_DRAFT_PROMPT, {
        locale: String(body["target"] ?? "en") === "fa" ? "fa" : "en",
        subject: ticket.subject,
        instruction,
        draft: text,
      }),
      facts: { kind: "draft_transform", ticketId, chars: text.length },
      deadlineMs: Date.now() + 20_000,
      inputHash: sha256(text),
      requiresStructuredOutput: true,
    });
    return { status: 200, body: ok({ draft: shapeAssist(outcome, "text") }) };
  }

  if (copilot !== null) {
    const ticket = await capability.ticket(ticketId);
    if (ticket === null) return { status: 404, body: fail("SUPPORT_TICKET_NOT_FOUND", "Ticket not found.", ctx.requestId) };
    const history = boundedHistory(ticket);
    const outcome = await capability.manager.call({
      userId: claims.sub,
      feature: "copilot",
      ledgerFeature: "copilot",
      promptVersion: SUPPORT_AI_PROMPT_VERSION,
      prompt: renderTemplate(AI_COPILOT_PROMPT, {
        locale: String(body["target"] ?? "en") === "fa" ? "fa" : "en",
        subject: ticket.subject,
        status: ticket.status,
        history: JSON.stringify(history),
      }),
      facts: { kind: "ticket_analysis", ticketId, messages: history.length },
      deadlineMs: Date.now() + 20_000,
      inputHash: sha256(JSON.stringify(history)),
      requiresStructuredOutput: true,
    });
    return { status: 200, body: ok({ copilot: shapeAssist(outcome, "insight") }) };
  }

  // translate
  const target = String(body["target"] ?? "en").toLowerCase().trim() === "fa" ? "fa" : "en";
  let source = typeof body["text"] === "string" ? body["text"].slice(0, MAX_MESSAGE_CHARS) : "";
  let sourceKind: "draft" | "message" = "draft";
  const messageId = body["message_id"];
  if (messageId !== undefined && messageId !== null && String(messageId) !== "") {
    const ticket = await capability.ticket(ticketId);
    if (ticket === null) return { status: 404, body: fail("SUPPORT_TICKET_NOT_FOUND", "Ticket not found.", ctx.requestId) };
    const message = ticket.messages.find((m) => m.id === String(messageId));
    if (message === undefined) {
      return { status: 404, body: fail("SUPPORT_MESSAGE_NOT_FOUND", "Message not found.", ctx.requestId) };
    }
    source = message.body.slice(0, MAX_MESSAGE_CHARS);
    sourceKind = "message";
  }
  if (source.trim() === "") {
    return { status: 422, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { text: "required (or message_id)" }) };
  }

  const outcome = await capability.manager.call({
    userId: claims.sub,
    feature: "translate",
    ledgerFeature: "translate",
    promptVersion: SUPPORT_AI_PROMPT_VERSION,
    prompt: renderTemplate(AI_TRANSLATE_PROMPT, { target, text: source }),
    facts: { kind: "translation", target, chars: source.length },
    deadlineMs: Date.now() + 15_000,
    inputHash: sha256(source),
    requiresStructuredOutput: true,
  });
  const shaped = shapeAssist(outcome, "text");
  return {
    status: 200,
    body: ok({
      translation: {
        ...shaped,
        target,
        source: sourceKind,
        // Legacy's field name, kept: the console renders `translated_body`.
        translated_body: shaped.text ?? "",
      },
    }),
  };
}

/**
 * One shape for all three assists.
 *
 * `available:false` + a reason is the honest degradation Legacy intended: the
 * console keeps working, and the operator learns WHY the assist is grey rather
 * than guessing whether the ticket, the model or the platform is at fault.
 */
function shapeAssist(
  outcome: Awaited<ReturnType<AiManager["call"]>>,
  prefer: "text" | "insight",
): { available: boolean; reason: string | null; text: string | null; insight: Record<string, unknown> | null; provider: string | null; model: string | null; latencyMs: number | null } {
  if (outcome.status !== "generated") {
    return { available: false, reason: outcome.code, text: null, insight: null, provider: null, model: null, latencyMs: null };
  }
  const text = prefer === "text" ? (outcome.text ?? textOf(outcome.insight)) : outcome.text;
  return {
    available: true,
    reason: null,
    text,
    insight: outcome.insight,
    provider: outcome.provider,
    model: outcome.model,
    latencyMs: outcome.latencyMs,
  };
}

/** A structured answer that carries prose: take the first string field. */
function textOf(insight: Record<string, unknown> | null): string | null {
  if (insight === null) return null;
  for (const key of ["translated_body", "text", "translation", "summary", "draft"]) {
    const value = insight[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function boundedHistory(ticket: SupportTicketContext): { sender: string; body: string; at: string }[] {
  return ticket.messages.slice(-MAX_TICKET_MESSAGES).map((m) => ({
    sender: m.senderType,
    body: m.body.slice(0, MAX_MESSAGE_CHARS),
    at: m.createdAt,
  }));
}
