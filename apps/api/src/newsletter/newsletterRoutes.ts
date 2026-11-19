// Newsletter routes — Phase 3 feature (GAP-NL): POST /api/v1/newsletter/subscribe.
//
// Public marketing signup (the landing footer's fake subscribe becomes real).
// Validated email; idempotent insert; fail-closed when the capability is not
// wired (503). No bearer auth is required — subscribe is open to any caller
// and is rate-limited at dispatch if an owner adds it to THROTTLED_ROUTES.
import { fail, ok } from "@velora/contracts";
import { NewsletterError, NewsletterService, type SubscribeInput } from "./newsletterService.js";
import type { NewsletterStore } from "./pgNewsletterStore.js";
import { capabilityAbsent, validation } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

const PATH = "/api/v1/newsletter/subscribe";

function readEmail(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const email = (body as Record<string, unknown>)["email"];
  return typeof email === "string" ? email : undefined;
}

export async function handleNewsletterRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.method !== "POST" || ctx.path !== PATH) return null;

  const store: NewsletterStore | null = ctx.config.newsletter ?? null;
  if (store === null) return capabilityAbsent(ctx, "newsletter");
  const service = new NewsletterService(store);

  try {
    const email = readEmail(await ctx.readBody(ctx.req));
    if (typeof email !== "string" || email.trim() === "") {
      return validation(ctx, { email: "A valid email is required." });
    }
    const input: SubscribeInput = { email };
    const { id } = await service.subscribe(input);
    return { status: 201, body: ok({ subscribed: true, id }) };
  } catch (err) {
    if (err instanceof NewsletterError) {
      return { status: err.status, body: fail(err.code, err.message, ctx.requestId) };
    }
    throw err;
  }
}
