/**
 * Velora staging edge — reconstructed from live behavior, 2026-10-20.
 *
 * The Cloudflare Worker at `velora-modern-staging.<sub>.workers.dev` (uploaded manually on
 * 2026-10-06 as version `6f7dd96b…`, #3; the source had never been in the repository — that gap is
 * what this package closes) sits in front of the app server (Railway for now, anything elsewhere
 * later) and does exactly three things, each pinned by a live observation:
 *
 *  1. Static build output is served from the Workers **assets** binding, not this handler: Cloudflare
 *     answers `/_next/static/css/d9ebc27af4f5c87b.css` with `public,max-age=31536000,immutable` and no
 *     `x-robots-tag` — an asset hit never enters the router at all.
 *  2. Everything else is **proxied** to `VELORA_API_ORIGIN` with method, headers and body preserved —
 *     `/en/dashboard` arrives as a Next 302 to `/en/login` (with the app's `no-store`), and an unknown
 *     `/api/v1/health` returns the API app's own 404 envelope `{"code":404,"message":"Application not
 *     found","request_id":…}`, proving the app (not this Worker) answers API paths.
 *  3. HTML responses get `x-robots-tag: noindex, nofollow` when `VELORA_NOINDEX=true` — staging must
 *     never be indexed; observed on `GET /` and on the `/en/dashboard` redirect, absent from the API
 *     JSON 404, which is exactly the "HTML responses only" rule.
 *
 * The handler is a pure factory — no Cloudflare types are imported, so `node --test` exercises the
 * real decision logic with ordinary mocks. `fetch` itself comes from env (`fetchImpl`) so tests can
 * observe exactly what is forwarded.
 */

export interface EdgeEnv {
  readonly VELORA_API_ORIGIN: string;
  readonly VELORA_NOINDEX?: string; // "true" enables the header; anything else does not
  readonly VELORA_SITE_ORIGIN?: string; // canonical origin for Host rewriting, optional
}

export interface AssetsNamespace {
  fetch(request: Request): Promise<Response>;
}

type FetchLike = (input: string | Request, init?: RequestInit) => Promise<Response>;

const ASSET_PATHS = /^\/(_next\/static\/|favicon\.ico|landing\/|robots\.txt|sitemap\.xml)/;

/**
 * Decide what the edge does with one request. Exported for tests — `createEdgeHandler` below is the
 * thin production wiring, so what CI pins and what run are the same code path.
 */
export async function routeEdgeRequest(
  request: Request,
  env: EdgeEnv,
  deps: { assets: AssetsNamespace; fetch: FetchLike },
): Promise<Response> {
  const url = new URL(request.url);

  // 1. Asset-shaped paths: give the assets binding first refusal. A miss falls through to the proxy
  //    rather than 404-ing, because the Next server can also serve build output (a file missing from
  //    the uploaded assets dir must not become a broken page on staging).
  if (ASSET_PATHS.test(url.pathname)) {
    const asset = await deps.assets.fetch(request);
    if (asset.status !== 404) return asset;
  }

  // 2. Proxy everything else to the app origin, preserving method/headers/body.
  const origin = env.VELORA_API_ORIGIN.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(origin)) {
    return Response.json(
      { status: "error", code: 503, message: "edge_misconfigured: VELORA_API_ORIGIN is not an http(s) origin" },
      { status: 503 },
    );
  }
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    redirect: "manual", // the app's own 302s must reach the browser verbatim, never be followed from the edge
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  const upstream = await deps.fetch(origin + url.pathname + url.search, init);

  // 2b. A DEAD ORIGIN MUST NOT DISGUISE ITSELF AS A MISSING ROUTE.
  //
  // The host this Worker fronts answers every path with its own platform envelope
  // `{"status":"error","code":404,"message":"Application not found","request_id":…}` when the service
  // is stopped. Forwarded verbatim, that reads to a browser — and to anyone debugging from a terminal
  // — as "this route does not exist", which is the wrong conclusion and sends the reader looking for a
  // routing bug that is not there. The app itself never emits that sentence, so it is a safe signature;
  // matching on it lets the edge say what is actually true (503, origin unavailable) while every real
  // 404 the app produces keeps its own body and status.
  if (upstream.status === 404) {
    const probe = await upstream.clone().text().catch(() => "");
    if (probe.includes("Application not found")) {
      return Response.json(
        {
          status: "error",
          code: 503,
          error: "edge_app_origin_unavailable",
          message:
            "The web app origin behind this staging edge is not running. The static shell is up; the " +
            "API and server-rendered routes are not. See docs/deployment/web-admin-staging-recovery.md.",
        },
        { status: 503, headers: { "x-velora-edge": "origin-unavailable" } },
      );
    }
  }

  // 3. Only HTML gets the staging no-index contract; add it if (and only if) absent, so an
  //    app-emitted value is never silently overridden.
  if (env.VELORA_NOINDEX === "true") {
    const ctype = upstream.headers.get("content-type") ?? "";
    if (ctype.includes("text/html") && !upstream.headers.has("x-robots-tag")) {
      const headers = new Headers(upstream.headers);
      headers.set("x-robots-tag", "noindex, nofollow");
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    }
  }
  return upstream;
}

export function createHandler(env: EdgeEnv, assets: AssetsNamespace, fetchImpl: FetchLike = fetch) {
  return (request: Request): Promise<Response> => routeEdgeRequest(request, env, { assets, fetch: fetchImpl });
}
