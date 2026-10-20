// The Node↔Workers bridge: a `Request` in, a `Response` out, over the API kernel's OWN listener.
//
// WHY A BRIDGE AND NOT A SECOND API. `apps/api/src/kernel/server.ts` is the only place routing, auth,
// RBAC and the JSON envelope exist. Cloudflare Workers have no listening socket — they receive a
// `Request` and return a `Response` — so the question is never "which parts do I re-implement", it is
// "what is the smallest pair of objects the kernel needs to see". Measured from the source, that pair
// is tiny and closed:
//
//   req.method, req.url, req.headers, req.socket.remoteAddress, and `for await (const chunk of req)`
//   res.writeHead(status, headers), res.end(body?)
//
// Six members. So this file implements exactly those, and nothing is duplicated: the Worker runs the
// same `createRequestListener(config)` the Node server runs, which is why the API's own 1,700-test
// suite is the regression test for this host too.
//
// WHY NOT `node:http` DIRECTLY. Workers' `nodejs_compat` layer provides client and utility APIs, not
// `createServer` — there is no socket to listen on. `HttpServerRequest`-style shims are the supported
// direction of travel (it is what the Workers "node:http server" is not), and pretending otherwise
// would put a `listen()` call in a runtime that can never satisfy it.
import { Buffer } from "node:buffer";

/** The slice of `IncomingMessage` the kernel actually reads. */
export interface IncomingMessageLike {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | undefined>;
  readonly socket: { readonly remoteAddress: string | undefined };
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}

/** The slice of `ServerResponse` the kernel actually calls. */
export interface ServerResponseLike {
  writeHead(status: number, headers?: Record<string, string | string[]>): void;
  end(body?: string | Buffer): void;
}

export interface BridgedResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: Buffer | null;
}

/**
 * Request → the kernel's `req`.
 *
 * Header joining follows Node: a repeated header becomes `"a, b"`.
 *
 * `content-length` is NOT synthesised when the client omitted it (a chunked upload arrives without
 * one). The kernel reads that header only to reject an oversized body EARLY; the limit itself is
 * enforced by counting the bytes it iterates, so the bound holds either way — and buffering the body
 * in the bridge just to fill in a header would destroy the streaming it exists for. `adaptListener`'s
 * tests pin the 413 that proves it (see `nodeHttpBridge.test.ts`).
 *
 * `remoteAddress` is the connecting client, taken from `CF-Connecting-IP` (the only address Cloudflare
 * vouches for at the edge) and falling back to the `X-Forwarded-For` head. It feeds rate-limit buckets
 * and auth-event rows; it is never trusted for authorization.
 */
export function toIncomingMessage(request: Request): IncomingMessageLike {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of request.headers) {
    const existing = headers[key];
    headers[key] = existing === undefined ? value : `${existing}, ${value}`;
  }
  const url = new URL(request.url);
  const remoteAddress =
    request.headers.get("cf-connecting-ip") ??
    (request.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ??
    undefined;

  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    socket: { remoteAddress: remoteAddress === "" ? undefined : remoteAddress },
    async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
      // GET/HEAD carry no body. Reading them anyway would allocate an empty chunk array per request
      // and — worse — make `parseJsonBody` await a stream that a client may never close.
      if (request.method === "GET" || request.method === "HEAD" || request.body === null) return;
      const reader = request.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) yield Buffer.from(value);
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/** The collector the kernel writes into; `collect()` turns it into a fetch `Response`. */
export function createResponseCollector(): {
  res: ServerResponseLike;
  collect(): BridgedResponse;
  readonly settled: Promise<void>;
} {
  let status = 200;
  let headers: Record<string, string | string[]> = {};
  let body: Buffer | null = null;
  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolvePromise) => {
    settle = resolvePromise;
  });

  return {
    settled,
    res: {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string | string[]>): void {
        status = nextStatus;
        if (nextHeaders !== undefined) headers = { ...headers, ...nextHeaders };
      },
      end(chunk?: string | Buffer): void {
        body = chunk === undefined ? null : typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        settle();
      },
    },
    collect(): BridgedResponse {
      return { status, headers, body };
    },
  };
}

/**
 * A fetch handler over a Node-shaped listener.
 *
 * The listener is synchronous in shape and asynchronous in fact (`route()` is a promise chain that ends
 * in `res.end`), so the handler waits on the collector's `settled` signal rather than on a return value.
 * A listener that throws synchronously is captured too: a Worker that answered nothing at all would be
 * indistinguishable from a network failure to whoever is debugging at 3 a.m.
 */
export function adaptListener<Req extends object, Res extends object>(
  listener: (req: Req, res: Res) => void,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const collector = createResponseCollector();
    try {
      // The one assertion in this file, and the reason it is safe: the kernel's listener is DECLARED
      // against `node:http` types but touches only the six members implemented above (method, url,
      // headers, socket.remoteAddress, async iteration, writeHead/end) — measured from
      // `apps/api/src/kernel/server.ts`, not assumed. Narrowing the declaration instead would mean
      // re-typing every handler the kernel passes these objects to; inventing the other 60 members of
      // `IncomingMessage` would be a lie. If a seventh member is ever read, it will throw here on the
      // first request rather than silently returning wrong answers.
      listener(toIncomingMessage(request) as unknown as Req, collector.res as unknown as Res);
    } catch (error) {
      return Response.json(
        { status: "error", code: 500, message: "internal error", detail: error instanceof Error ? error.name : "unknown" },
        { status: 500 },
      );
    }
    await collector.settled;
    const { status, headers, body } = collector.collect();

    const out = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      // `set-cookie` must not be comma-joined: a folded cookie is a cookie the browser ignores, and
      // this API rotates refresh tokens — two cookies in one header is a normal state here.
      if (Array.isArray(value)) {
        for (const item of value) out.append(key, item);
      } else {
        out.set(key, value);
      }
    }
    // 204/304 must not carry a body; fetch throws if one is supplied.
    const status_forbids_body = status === 204 || status === 304;
    return new Response(status_forbids_body || body === null ? null : body, { status, headers: out });
  };
}
