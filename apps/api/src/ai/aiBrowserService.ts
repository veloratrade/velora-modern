/**
 * Browser automation, as a boundary we control — not a claim.
 *
 * WHY AN EXTERNAL BROWSER AND NOT A LIBRARY IN THIS PROCESS.
 *   The brief's own rule is the reason: a Cloudflare Worker cannot run a headless Chrome, whatever the
 *   package manager will happily install. Bundling puppeteer/playwright into the API process would mean
 *   the capability exists in one runtime, silently fails in the other, and — worst — the deployment image
 *   now needs a browser binary that this sandbox (and Workers) cannot provide. A Chrome-in-Docker
 *   service reached over HTTPS is the shape that works in BOTH runtimes: the process only needs fetch,
 *   and where no service is configured the tool reports `unavailable` with the exact thing to provision.
 *   The runtime check is real (`toolNeedsNode` below is false for this tool), which is what makes
 *   "integrated where feasible" true rather than aspirational.
 *
 * WHAT THIS IS NOT. It is not a proxy. The service can only be pointed at http(s) pages on hosts the
 * caller is allowed to name, the destination is vetted before the request is built (no private address,
 * no credentials in the URL, no non-http scheme), and a page's own redirects are not followed by us.
 * It never sends a Velora credential to a third-party origin: the only header on the request is the
 * browser service's own token, and the target URL carries nothing.
 */
import { defaultToolProvider, TOOL_BUDGETS, type ToolCapabilityEvidence, type ToolProviderDefinition } from "./aiToolCatalog.js";
import { assertSafeUrl, classifyStatus, toolFetch, ToolOutboundError, type ToolOutboundCode } from "./aiToolOutbound.js";

export interface BrowserCaptureRequest {
  /** The page to open. Vetted by `assertSafeUrl` — a URL from a user message is untrusted input. */
  readonly url: string;
  /** Restrict the destination to the chart hosts this product vouches for (used by chart capture). */
  readonly chartHostsOnly?: boolean | undefined;
  readonly fullPage?: boolean | undefined;
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  /**
   * How long to wait for the page. `networkidle0` is what a chart needs (it draws after load), and it
   * is also what a hostile page can use to hold a slot — so it is bounded by the provider timeout.
   */
  readonly waitUntil?: "load" | "domcontentloaded" | "networkidle0" | undefined;
  /** Extra seconds the caller asks the browser to wait before capturing, clamped hard below. */
  readonly settleMs?: number | undefined;
}

export interface BrowserCapture {
  readonly url: string;
  readonly contentType: "image/png";
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly capturedAt: string;
  readonly provider: string;
}

export interface BrowserText {
  readonly url: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly retrievedAt: string;
  readonly provider: string;
}

export type BrowserFailure = { readonly ok: false; readonly code: ToolOutboundCode; readonly reason: string };

export interface BrowserServiceDeps {
  readonly secrets: { resolve(key: string): Promise<{ value: string | null; source: "admin" | "env" | null }> };
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly nodeCrypto?: { createHash(algorithm: string): { update(data: Buffer): { digest(enc: "hex"): string } } };
}

const MAX_SETTLE_MS = 15_000;
const MIN_VIEWPORT = 320;
const MAX_VIEWPORT = 1_920;

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

/**
 * Turn browser HTML into text for a model, without a parser dependency.
 *
 * Script and style bodies are removed WITH their contents (page code is not "content" the user asked
 * for, and letting it through is how a page argues with the model), every other tag collapses to a
 * boundary, and entities are decoded only for the handful that appear in prose. Anything that needs a
 * real DOM — a chart canvas — is exactly what a screenshot is for instead.
 */
export function htmlToText(html: string, maxChars: number): { text: string; truncated: boolean } {
  const withoutMedia = html
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ");
  const spaced = withoutMedia
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/giu, "\n")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/[ \t\u00a0]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { text: spaced.slice(0, maxChars), truncated: spaced.length > maxChars };
}

export class AiBrowserService {
  private readonly now: () => Date;

  constructor(private readonly deps: BrowserServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private definition(): ToolProviderDefinition | null {
    return defaultToolProvider("browser_capture", null);
  }

  /**
   * The endpoint, resolved and re-validated on EVERY call rather than cached.
   *
   * `BROWSERLESS_URL` may be a private address — that is the legitimate shape of a self-hosted browser
   * on the same network — but it must still be http(s), carry no credentials, and be a real URL, because
   * "admin-configured" is a trust level, not immunity from malformed input. `BROWSERLESS_TOKEN` rides as
   * an Authorization header, never in the query string: a URL is what ends up in an access log.
   */
  private async endpoint(): Promise<{ base: URL; token: string | null; def: ToolProviderDefinition } | BrowserFailure> {
    const def = this.definition();
    if (def === null) return { ok: false, code: "NOT_CONFIGURED", reason: "NO_BROWSER_PROVIDER" };
    const resolved = await this.deps.secrets.resolve("BROWSERLESS_URL");
    const raw = (resolved.value ?? "").trim();
    if (raw === "") return { ok: false, code: "NOT_CONFIGURED", reason: "NO_BROWSERLESS_URL" };
    let base: URL;
    try {
      base = assertSafeUrl(raw, { allowHttp: true, allowPrivate: def.endpointMayBePrivate });
    } catch (err) {
      // `assertSafeUrl` reports WHY without repeating the URL. That reason is exactly what an operator
      // needs to fix it, so it is surfaced as a code rather than swallowed.
      if (err instanceof ToolOutboundError) return { ok: false, code: err.code, reason: `BAD_BROWSERLESS_URL:${err.detail ?? "rejected"}` };
      throw err;
    }
    const token = (await this.deps.secrets.resolve("BROWSERLESS_TOKEN")).value?.trim() || null;
    return { base, token, def };
  }

  private headers(token: string | null): Record<string, string> {
    return token === null
      ? { "content-type": "application/json" }
      : { "content-type": "application/json", authorization: `Bearer ${token}` };
  }

  private async post<T>(ep: { base: URL; token: string | null; def: ToolProviderDefinition }, path: string, payload: Record<string, unknown>): Promise<{ bytes: Buffer; contentType: string } | BrowserFailure> {
    const url = new URL(path, ep.base);
    try {
      const result = await toolFetch(
        url,
        {
          method: "POST",
          headers: this.headers(ep.token),
          body: JSON.stringify(payload),
          timeoutMs: ep.def.timeoutMs,
          maxResponseBytes: ep.def.maxResponseBytes,
        },
        this.deps.fetchImpl,
      );
      return { bytes: result.bytes, contentType: result.contentType };
    } catch (err) {
      if (err instanceof ToolOutboundError) return { ok: false, code: err.code, reason: err.detail ?? err.code };
      return { ok: false, code: "NETWORK", reason: "fetch-threw" };
    }
  }

  /** Capability evidence for admin. `verified` only after a real round trip (`validateConnection`). */
  async status(): Promise<ToolCapabilityEvidence> {
    const def = this.definition();
    if (def === null) {
      return { tool: "browser_capture", provider: "none", state: "unsupported", runtimeSupported: true, secrets: [], reason: "NO_PROVIDER_DECLARED", lastStatus: null, lastCheckedAt: null };
    }
    const secrets: { key: string; present: boolean; source: "admin" | "env" | null }[] = [];
    let all = true;
    for (const key of def.requiredSecrets) {
      const resolved = await this.deps.secrets.resolve(key);
      const present = resolved.value !== null && resolved.value !== "";
      if (!present) all = false;
      secrets.push({ key, present, source: present ? resolved.source : null });
    }
    return {
      tool: "browser_capture",
      provider: def.provider,
      state: all ? "configured" : "unavailable",
      runtimeSupported: true,
      secrets,
      reason: all ? null : "SERVICE_URL_AND_TOKEN_REQUIRED",
      lastStatus: null,
      lastCheckedAt: null,
    };
  }

  /**
   * Ask the service whether it is alive, without opening any third-party page. `/pressure` is a
   * browserless endpoint that answers about its own capacity, so this proves "we can reach and
   * authenticate to the browser" and nothing else — which is exactly what a validation path should
   * claim, and why it is not a screenshot of example.com.
   */
  async validateConnection(): Promise<{ ok: boolean; status: "VALID" | "INVALID_CREDENTIAL" | "NETWORK_ERROR" | "UNKNOWN"; latencyMs: number; errorCode: string | null; detail: string | null }> {
    const started = this.now().getTime();
    const ep = await this.endpoint();
    if ("ok" in ep && ep.ok === false) {
      return { ok: false, status: "UNKNOWN", latencyMs: 0, errorCode: ep.code, detail: ep.reason };
    }
    const endpoint = ep as { base: URL; token: string | null; def: ToolProviderDefinition };
    try {
      const url = new URL("/pressure?format=1", endpoint.base);
      const result = await toolFetch(url, {
        method: "GET",
        headers: this.headers(endpoint.token),
        timeoutMs: 5_000,
        maxResponseBytes: 16 * 1024,
      }, this.deps.fetchImpl);
      const latencyMs = Math.max(0, this.now().getTime() - started);
      if (result.bytes.length === 0) return { ok: false, status: "UNKNOWN", latencyMs, errorCode: "MALFORMED", detail: "empty-pressure-response" };
      return { ok: true, status: "VALID", latencyMs, errorCode: null, detail: null };
    } catch (err) {
      const latencyMs = Math.max(0, this.now().getTime() - started);
      if (err instanceof ToolOutboundError) {
        // Mapped from the CODE the boundary produced, not from its detail string: `detail` carries an
        // HTTP status only for the errors that came from a status, and parsing it as a number elsewhere
        // turns a socket failure into "UNKNOWN" — a wrong answer where an honest one was available.
        const status =
          err.code === "AUTH"
            ? "INVALID_CREDENTIAL"
            : err.code === "NETWORK" || err.code === "TIMEOUT" || classifyStatus(Number.parseInt(err.detail ?? "", 10)) === "NETWORK"
              ? "NETWORK_ERROR"
              : "UNKNOWN";
        return { ok: false, status, latencyMs, errorCode: err.code, detail: err.detail };
      }
      return { ok: false, status: "NETWORK_ERROR", latencyMs, errorCode: "NETWORK", detail: null };
    }
  }

  /** Capture a real screenshot. The bytes returned are the artifact — nothing is synthesized on failure. */
  async capture(request: BrowserCaptureRequest): Promise<BrowserCapture | BrowserFailure> {
    const ep = await this.endpoint();
    if ("ok" in ep && ep.ok === false) return ep;
    const endpoint = ep as { base: URL; token: string | null; def: ToolProviderDefinition };
    let target: URL;
    try {
      target = assertSafeUrl(request.url, {
        // A DESTINATION is never allowed to be private, whatever the endpoint's policy says.
        allowPrivate: false,
        allowHttp: false,
      });
    } catch (err) {
      if (err instanceof ToolOutboundError) return { ok: false, code: err.code, reason: `target:${err.detail ?? "rejected"}` };
      throw err;
    }
    if (request.chartHostsOnly === true && !(await this.isTrustedChartHost(target.hostname))) {
      return { ok: false, code: "UNSAFE_TARGET", reason: "host-not-a-trusted-chart-source" };
    }
    const viewport = {
      width: clampNumber(request.viewport?.width, 1_440, MIN_VIEWPORT, MAX_VIEWPORT),
      height: clampNumber(request.viewport?.height, 900, MIN_VIEWPORT, MAX_VIEWPORT),
    };
    const payload: Record<string, unknown> = {
      url: target.toString(),
      fullPage: request.fullPage === true,
      viewport,
      type: "png",
      gotoOptions: { waitUntil: request.waitUntil ?? "networkidle0", timeout: Math.max(1_000, Math.min(endpoint.def.timeoutMs - 2_000, 30_000)) },
      // A fixed settle is what lets a chart finish drawing. It is capped because an unbounded "wait for
      // the page to be ready" is a slot held open by whoever wrote the page.
      settle: clampNumber(request.settleMs, 1_500, 0, MAX_SETTLE_MS),
      blockRequestUrls: ["*://*.doubleclick.net/*", "*://*.googlesyndication.com/*", "*://*.google-analytics.com/*"],
    };
    const out = await this.post(endpoint, "/screenshot", payload);
    if ("ok" in out && out.ok === false) return out;
    const got = out as { bytes: Buffer; contentType: string };
    if (got.bytes.length === 0) return { ok: false, code: "MALFORMED", reason: "empty-screenshot" };
    // Verify it is actually a PNG. A service that answers 200 with an HTML error page must not have its
    // bytes stored as "the chart image" and then handed to a vision model.
    const signature = got.bytes.subarray(0, 8).toString("hex");
    if (signature !== "89504e470d0a1a0a") return { ok: false, code: "MALFORMED", reason: "not-a-png" };
    const dims = pngDimensions(got.bytes);
    const hash = await this.sha256(got.bytes);
    return {
      url: target.toString(),
      contentType: "image/png",
      bytes: got.bytes,
      width: dims?.width ?? viewport.width,
      height: dims?.height ?? viewport.height,
      byteLength: got.bytes.length,
      sha256: hash,
      capturedAt: this.now().toISOString(),
      provider: endpoint.def.provider,
    };
  }

  /** Read a page's text. Used for research, never as a substitute for a chart. */
  async extract(request: { url: string; maxChars?: number | undefined; chartHostsOnly?: boolean | undefined }): Promise<BrowserText | BrowserFailure> {
    const ep = await this.endpoint();
    if ("ok" in ep && ep.ok === false) return ep;
    const endpoint = ep as { base: URL; token: string | null; def: ToolProviderDefinition };
    let target: URL;
    try {
      target = assertSafeUrl(request.url, { allowPrivate: false, allowHttp: false });
    } catch (err) {
      if (err instanceof ToolOutboundError) return { ok: false, code: err.code, reason: `target:${err.detail ?? "rejected"}` };
      throw err;
    }
    if (request.chartHostsOnly === true && !(await this.isTrustedChartHost(target.hostname))) {
      return { ok: false, code: "UNSAFE_TARGET", reason: "host-not-a-trusted-chart-source" };
    }
    const out = await this.post(endpoint, "/content", { url: target.toString(), gotoOptions: { waitUntil: "domcontentloaded" } });
    if ("ok" in out && out.ok === false) return out;
    const got = out as { bytes: Buffer; contentType: string };
    const max = clampNumber(request.maxChars, 6_000, 200, TOOL_BUDGETS.browser_capture.maxQueryChars * 8);
    const rendered = htmlToText(got.bytes.toString("utf8"), max);
    return { url: target.toString(), text: rendered.text, truncated: rendered.truncated, retrievedAt: this.now().toISOString(), provider: endpoint.def.provider };
  }

  private async isTrustedChartHost(host: string): Promise<boolean> {
    // Imported lazily-by-value rather than by name to keep the trust list in ONE place (the catalogue).
    const { isTrustedChartHost } = await import("./aiToolCatalog.js");
    return isTrustedChartHost(host);
  }

  private async sha256(bytes: Buffer): Promise<string> {
    const injected = this.deps.nodeCrypto;
    if (injected !== undefined) return injected.createHash("sha256").update(bytes).digest("hex");
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(bytes).digest("hex");
  }
}

/** Read IHDR width/height. Cheap, and it stops a capture's metadata being a guess. */
function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
