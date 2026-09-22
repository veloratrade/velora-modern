// Tag routes — v0.5.
//   GET    /api/v1/tags
//   POST   /api/v1/tags
//   DELETE /api/v1/tags/{id}
//   GET    /api/v1/trades/{id}/tags
//   POST   /api/v1/trades/{id}/tags
//   DELETE /api/v1/trades/{id}/tags/{tagId}
//
// OWNERSHIP IS STRUCTURAL. Every call is scoped by `claims.sub`; a foreign tag
// or trade is a single non-disclosing 404. A trade that does not exist and a
// trade owned by somebody else are indistinguishable to the caller — which is
// the same rule the Phase C trade routes already follow.
import { fail, ok } from "@velora/contracts";
import { TagError, validateTagInput, type TagStore } from "./tagService.js";
import { capabilityAbsent, notFound, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

const TAGS = "/api/v1/tags";
const TAGS_ID = /^\/api\/v1\/tags\/([^/]+)$/;
const TRADE_TAGS = /^\/api\/v1\/trades\/([^/]+)\/tags$/;
const TRADE_TAG_ID = /^\/api\/v1\/trades\/([^/]+)\/tags\/([^/]+)$/;

function tagError(ctx: ExtendedRouteContext, err: TagError): RouteResult {
  return { status: err.status, body: fail(err.code, err.message, ctx.requestId) };
}

export async function handleTagRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const isTags = ctx.path === TAGS;
  const tagIdMatch = TAGS_ID.exec(ctx.path);
  const tradeTagsMatch = TRADE_TAGS.exec(ctx.path);
  const tradeTagIdMatch = TRADE_TAG_ID.exec(ctx.path);
  if (!isTags && tagIdMatch === null && tradeTagsMatch === null && tradeTagIdMatch === null) return null;

  const store: TagStore | null = ctx.config.tags ?? null;
  if (store === null) return capabilityAbsent(ctx, "tags");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);
  const userId = claims.sub;

  try {
    // ---- tag collection ---------------------------------------------------
    if (isTags && ctx.method === "GET") {
      return { status: 200, body: ok({ tags: await store.list(userId) }) };
    }
    if (isTags && ctx.method === "POST") {
      const body = await ctx.readBody(ctx.req);
      const input = validateTagInput(body);
      const created = await store.create(userId, input);
      return { status: 201, body: ok(created) };
    }
    if (isTags) return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };

    // ---- single tag -------------------------------------------------------
    if (tagIdMatch !== null) {
      const tagId = decodeURIComponent(tagIdMatch[1] ?? "");
      if (ctx.method === "DELETE") {
        const removed = await store.remove(userId, tagId);
        if (!removed) return notFound(ctx, "Tag not found.");
        return { status: 204, body: null };
      }
      if (ctx.method === "GET") {
        const tag = await store.find(userId, tagId);
        if (tag === null) return notFound(ctx, "Tag not found.");
        return { status: 200, body: ok(tag) };
      }
      return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    }

    // ---- trade ⇄ tag links ------------------------------------------------
    const tradeId = decodeURIComponent((tradeTagsMatch ?? tradeTagIdMatch)?.[1] ?? "");
    if (!(await store.tradeOwnedBy(userId, tradeId))) return notFound(ctx, "Trade not found.");

    if (tradeTagsMatch !== null) {
      if (ctx.method === "GET") {
        return { status: 200, body: ok({ tags: await store.listForTrade(userId, tradeId) }) };
      }
      if (ctx.method === "POST") {
        const body = await ctx.readBody(ctx.req);
        const rawTagId = body["tag_id"] ?? body["tagId"];
        if (rawTagId === undefined || rawTagId === null) {
          throw new TagError(400, "VALIDATION_FAILED", "tag_id is required.");
        }
        const tagId = String(rawTagId);
        // The tag must exist AND belong to the caller. A foreign tag id is a
        // 404, never a 403: existence must not be probed through the error code.
        if ((await store.find(userId, tagId)) === null) return notFound(ctx, "Tag not found.");
        const assigned = await store.assign(userId, tradeId, tagId);
        if (!assigned) return { status: 409, body: fail("TAG_ALREADY_ASSIGNED", "Tag already assigned.", ctx.requestId) };
        return { status: 201, body: ok({ trade_id: tradeId, tag_id: tagId }) };
      }
      return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    }

    const tagId = decodeURIComponent(tradeTagIdMatch?.[2] ?? "");
    if (ctx.method === "DELETE") {
      const removed = await store.unassign(userId, tradeId, tagId);
      if (!removed) return notFound(ctx, "Tag assignment not found.");
      return { status: 204, body: null };
    }
    return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
  } catch (err) {
    if (err instanceof TagError) return tagError(ctx, err);
    throw err;
  }
}
