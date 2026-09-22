// Attachment routes — v0.5 screenshots.
//   GET    /api/v1/trades/{id}/attachments         → list metadata
//   POST   /api/v1/trades/{id}/attachments         → RAW byte upload (see below)
//   GET    /api/v1/attachments/{id}/content        → the bytes
//   DELETE /api/v1/attachments/{id}                → soft delete
//
// WHY THE UPLOAD BODY IS RAW BYTES, NOT JSON+BASE64.
// The product limit is 5 MiB. A base64 JSON envelope would need ~6.7 MiB of
// transport for that, and the kernel's JSON reader caps a body at 1 MiB — the
// two limits are contradictory, and there is no JSON form of a 5 MiB image that
// fits inside a 1 MiB contract. Uploading the bytes directly keeps ONE size
// limit (the roadmap's 5 MiB) instead of inventing a second, tighter one that
// would silently reject legitimate screenshots.
//
// MIME CONTRACT: the caller declares the type in `Content-Type`; the service
// validates it against the whitelist and refuses anything else. The declared
// type is what is stored (0015 constrains it to the same whitelist), and the
// bytes are not decoded — Velora stores an opaque object, it does not process
// images in the request path.
import { fail, ok } from "@velora/contracts";
import { AttachmentError, MAX_ATTACHMENT_BYTES, type AttachmentService } from "./attachmentService.js";
import { capabilityAbsent, notFound, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

const TRADE_ATTACHMENTS = /^\/api\/v1\/trades\/([^/]+)\/attachments$/;
const ATTACHMENT_CONTENT = /^\/api\/v1\/attachments\/([^/]+)\/content$/;
const ATTACHMENT_ID = /^\/api\/v1\/attachments\/([^/]+)$/;

function single(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function handleAttachmentRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const tradeMatch = TRADE_ATTACHMENTS.exec(ctx.path);
  const contentMatch = ATTACHMENT_CONTENT.exec(ctx.path);
  const idMatch = ATTACHMENT_ID.exec(ctx.path);
  if (tradeMatch === null && contentMatch === null && idMatch === null) return null;

  const service: AttachmentService | null = ctx.config.attachments ?? null;
  if (service === null) return capabilityAbsent(ctx, "attachments");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);
  const userId = claims.sub;

  try {
    if (tradeMatch !== null) {
      const tradeId = decodeURIComponent(tradeMatch[1] ?? "");
      if (!(await service.tradeOwnedBy(userId, tradeId))) return notFound(ctx, "Trade not found.");

      if (ctx.method === "GET") {
        return { status: 200, body: ok({ attachments: await service.list(userId, tradeId) }) };
      }
      if (ctx.method === "POST") {
        const declaredType = single(ctx.req.headers["content-type"]) ?? "";
        const fileName =
          single(ctx.req.headers["x-file-name"]) ?? ctx.url.searchParams.get("file_name") ?? "";
        const category = ctx.url.searchParams.get("category") ?? "OTHER";
        let bytes: Buffer;
        try {
          // Read one byte past the limit so "exactly at the limit" is accepted
          // and "over the limit" is refused before the whole body is buffered.
          bytes = await ctx.readRawBody(ctx.req, MAX_ATTACHMENT_BYTES + 1);
        } catch {
          return {
            status: 413,
            body: fail("PAYLOAD_TOO_LARGE", `file exceeds ${MAX_ATTACHMENT_BYTES} bytes.`, ctx.requestId),
          };
        }
        const record = await service.upload({
          tradeId,
          userId,
          fileName,
          mime: declaredType.split(";")[0] ?? declaredType,
          category,
          bytes,
        });
        return { status: 201, body: ok(record) };
      }
      return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    }

    const attachmentId = decodeURIComponent((contentMatch ?? idMatch)?.[1] ?? "");

    if (contentMatch !== null) {
      if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
      const found = await service.content(userId, attachmentId);
      if (found === null) return notFound(ctx, "Attachment not found.");
      return {
        status: 200,
        body: found.bytes,
        headers: {
          "Content-Type": found.record.mime,
          "Content-Length": String(found.bytes.length),
          // Attachments are private to their owner: never cacheable by a shared
          // proxy, and never sniffable into an executable type.
          "Cache-Control": "private, no-store",
          "Content-Disposition": `inline; filename="${found.record.fileName.replace(/"/g, "")}"`,
          "X-Content-Type-Options": "nosniff",
        },
      };
    }

    if (ctx.method === "DELETE") {
      const removed = await service.remove(userId, attachmentId);
      if (!removed) return notFound(ctx, "Attachment not found.");
      return { status: 204, body: null };
    }
    return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
  } catch (err) {
    if (err instanceof AttachmentError) {
      return { status: err.status, body: fail(err.code, err.message, ctx.requestId) };
    }
    throw err;
  }
}
