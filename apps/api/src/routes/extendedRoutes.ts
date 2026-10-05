// Extended route dispatcher — the single entry point the kernel delegates to.
//
// PLACEMENT MATTERS. The kernel calls this immediately BEFORE its terminal 404,
// so the Phase C surface keeps precedence: a migrated handler can never shadow
// an existing route even if the two ever collide. A handler returns `null` for a
// route it does not own, and the dispatcher hands the request back to the
// kernel's 404.
//
// ARCHITECTURE NOTE. Handlers are grouped per capability and registered in
// `ROUTE_HANDLERS`. Adding a capability means adding one module and one entry
// here — never editing the kernel again, which is what keeps the ADR-010 thin
// shell thin.
import type { ExtendedRouteContext, ExtendedRouteHandler, RouteResult } from "./types.js";

// The response helpers live in `./responses.js` (a leaf module) so a handler can
// import them without depending on this dispatcher. Re-exported here so the
// public entry point of the route layer is unchanged.
export { capabilityAbsent, forbidden, notFound, unauthenticated, validation } from "./responses.js";

import { handleWebhookRoutes } from "../webhooks/webhookRoutes.js";
import { handleSyncStatusRoutes } from "../accounts/syncStatusRoutes.js";
import { handleManualSyncRoutes } from "../accounts/manualSyncRoutes.js";
import { handleAnalyticsRoutes } from "../analytics/analyticsRoutes.js";
import { handleTagRoutes } from "../tags/tagRoutes.js";
import { handleAttachmentRoutes } from "../attachments/attachmentRoutes.js";
import { handleBillingRoutes } from "../billing/billingRoutes.js";
import { handleAiCoachRoutes } from "../aicoach/aiCoachRoutes.js";
import { handleAdminRoutes } from "../admin/adminRoutes.js";
import { handleAdminConsoleRoutes } from "../admin/adminConsoleRoutes.js";
import { handleAiRoutes } from "../ai/aiRoutes.js";
import { handleAiAdminRoutes } from "../ai/aiAdminRoutes.js";
import { handleSupportAiRoutes } from "../support/supportAiRoutes.js";
import { handlePortfolioRoutes } from "../portfolio/portfolioRoutes.js";
import { handleEaRoutes } from "../ea/eaRoutes.js";
import { handleTenancyRoutes } from "../tenancy/tenancyRoutes.js";
import { handleDeveloperRoutes } from "../developer/developerRoutes.js";
import { handleTelegramRoutes } from "../telegram/telegramRoutes.js";
import { handleSupportRoutes } from "../support/supportRoutes.js";

/**
 * Registration order is significant only for readability: each handler matches
 * on its own (method, path) pairs, and a `null` return means "not mine".
 */
const ROUTE_HANDLERS: readonly ExtendedRouteHandler[] = [
  // Ingress first: it is unauthenticated (signature-authenticated) and must not
  // be reachable behind any bearer check.
  handleWebhookRoutes,
  // Telegram: the webhook ingress is registered here for the same reason (its
  // secret-token check precedes any bearer handling), and its authenticated
  // routes resolve identity from `claims.sub` only.
  handleTelegramRoutes,
  // Support: user routes are ownership-scoped, the /admin/communications ones
  // carry their own capability check.
  handleSupportRoutes,
  // Authenticated capability surface.
  handleSyncStatusRoutes,
  handleManualSyncRoutes,
  handleAnalyticsRoutes,
  handleTagRoutes,
  handleAttachmentRoutes,
  handleBillingRoutes,
  handleAiCoachRoutes,
  handleAdminRoutes,
  handleAdminConsoleRoutes,
  handleAiRoutes,
  handleAiAdminRoutes,
  handleSupportAiRoutes,
  handlePortfolioRoutes,
  handleEaRoutes,
  handleTenancyRoutes,
  handleDeveloperRoutes,
];

export async function dispatchExtendedRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  for (const handler of ROUTE_HANDLERS) {
    const result = await handler(ctx);
    if (result !== null) return result;
  }
  return null;
}
