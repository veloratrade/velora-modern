// The panel's API hop: same-origin for the browser, real API on the other side.
//
// WHY THIS IS A PROXY AND NOT A SECOND API. Every route, permission check, envelope and cookie belongs
// to `apps/api` and is reached by forwarding the request unchanged. Nothing here inspects a payload,
// decides who may call what, or re-shapes a response: the outcome of a forwarded request is whatever the
// API decided, byte for byte. That is the property that keeps `/admin` genuinely gated — the panel cannot
// accidentally "help" an unauthorised request succeed because it does not make any decisions at all.
//
// WHY THE BROWSER IS NOT POINTED AT THE API ORIGIN DIRECTLY.
//   1. Cookies. The API issues `__Host-velora_refresh` (Secure, Path=/, no Domain). Served from the panel's
//      own origin through this hop it stays first-party; called cross-origin from the browser it would be
//      a third-party cookie — blocked by default in current browsers. The session would simply not survive.
//   2. The API's origin allowlist. A same-origin `Origin: https://<panel host>` is a value the API can
//      check and does (`API_ALLOWED_ORIGINS`). A cross-origin call would need that list widened.
//   3. Portability. On a VPS the same file forwards to `http://127.0.0.1:8080`; nothing changes but the var.
//
// The `404 Application not found` this replaces was exactly a wrong-origin hop: `/api/*` was being
// rewritten to a host that no longer existed, so the browser got a platform error instead of the API's
// `{code:"NOT_FOUND", requestId}` envelope. A proxy route cannot do that silently — if the origin is
// wrong or unusable it answers 503 with a reason, and the API's own error codes pass through untouched.
import { resolveApiOrigin } from "../../../lib/apiOrigin";

/** Headers that belong to a single connection and must not be forwarded by a proxy. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * The largest request body this hop will carry.
 *
 * The API's JSON cap is 1 MiB and its raw cap is 64 MiB; 8 MiB covers every panel request with room to
 * spare. The body is buffered because a Worker-to-Worker fetch with a streamed body also needs duplex
 * negotiation that the Node runtime under `next dev` handles differently — a size-bounded buffer is the
 * one shape that behaves identically in both. If a streaming upload is ever added, this is the line that
 * has to become a stream, and it should be a deliberate change with a test, not an accident.
 */
const MAX_BODY_BYTES = 8 * 1_048_576;

interface RouteContext {
  readonly params: Promise<{ readonly path: string[] }>;
}

const jsonError = (status: number, code: string, message: string): Response =>
  Response.json(
    { status: "error", data: null, error: { code, message, requestId: "web-proxy" }, timestamp: new Date().toISOString() },
    { status, headers: { "cache-control": "no-store" } },
  );

async function forward(request: Request, context: RouteContext): Promise<Response> {
  const origin = resolveApiOrigin();
  if (origin === null) {
    // Fail loudly and specifically. A 502 here would be a guess; this is a deployment fact.
    return jsonError(503, "API_ORIGIN_UNCONFIGURED", "the panel has no usable VELORA_API_ORIGIN");
  }

  const { path } = await context.params;
  const incoming = new URL(request.url);
  const target = `${origin}/api/${path.map(encodeURIComponent).join("/")}${incoming.search}`;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  // Keep the client's address visible to the API's rate limiter and auth-event rows. `cf-connecting-ip`
  // is set by the edge on the request THIS Worker received; the API sees its own copy for the subrequest,
  // so carrying it in `x-forwarded-for` is the portable way to preserve it (the API's bridge reads
  // `cf-connecting-ip` first, then this header's head).
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp !== null && !headers.has("x-forwarded-for")) headers.set("x-forwarded-for", clientIp);

  const method = request.method.toUpperCase();
  const carriesBody = method !== "GET" && method !== "HEAD";
  let body: ArrayBuffer | undefined;
  if (carriesBody) {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) {
      return jsonError(413, "PAYLOAD_TOO_LARGE", "request body exceeds the panel's forwarding limit");
    }
    body = raw.byteLength === 0 ? undefined : raw;
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      // The API answers redirects and 304s itself; following one here would hide a real answer and could
      // send a credentialed request somewhere the caller did not ask for.
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    // Unreachable origin: a 502 that names the hop, never a fabricated success.
    return jsonError(502, "API_UNREACHABLE", "the panel could not reach the API origin");
  }

  const out = new Headers();
  for (const [key, value] of upstream.headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // The body below is undici-decoded, so these describe an encoding that no longer exists.
    if (lower === "content-encoding") continue;
    out.set(key, value);
  }
  // `set-cookie` must survive as separate headers: the API sets `__Host-velora_refresh` and clears the
  // legacy name in the same response, and a folded header is a cookie the browser throws away.
  out.delete("set-cookie");
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const HEAD = forward;
export const OPTIONS = forward;

// Never pre-rendered, never cached: this route exists to carry a live request.
export const dynamic = "force-dynamic";
