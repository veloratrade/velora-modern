/**
 * The ONE outbound path for AI tools, and the two guards that make it safe to exist.
 *
 * WHY A SEPARATE PATH FROM THE AI PROVIDER TRANSPORT.
 *   `aiExecutors.ts` talks to model APIs. Tools talk to a search API and to a browser service, and one
 *   of those requests carries a URL that a human typed. That difference is the whole security problem,
 *   and it is why this file exists: every tool request goes through `toolFetch` here, so the timeout,
 *   the response-size cap, the redirect refusal and the address checks are written ONCE. A tool service
 *   that "just calls fetch" is how an SSRF bug ships with a nice UX on top of it.
 *
 * THE ASYMMETRY, STATED PLAINLY.
 *   - An ENDPOINT (which provider we talk to) is chosen by the operator. For a self-hosted browser it
 *     may legitimately be a private address, because "inside the VPC" is where such a service lives.
 *   - A DESTINATION (which page the browser should open) is chosen by a request. It is always treated
 *     as hostile: no private range, no loopback, no metadata IP, no credentials in the URL, no
 *     non-http(s) scheme, and no redirect that we follow without re-checking.
 *   Confusing the two is the classic mistake in this area: a guard applied to both makes a
 *   self-hosted service unusable, and a guard applied to neither turns "prepare a channel post about
 *   this URL" into a request to `169.254.169.254`.
 */

export type ToolOutboundCode =
  | "NOT_CONFIGURED"
  | "UNSAFE_TARGET"
  | "TIMEOUT"
  | "NETWORK"
  | "STATUS"
  | "TOO_LARGE"
  | "MALFORMED"
  /** Fixed buckets a caller can map onto `AiCredentialStatus` without parsing a message. */
  | "AUTH"
  | "QUOTA"
  | "RATE_LIMITED";

export class ToolOutboundError extends Error {
  constructor(
    readonly code: ToolOutboundCode,
    /** Only ever a fixed string or an HTTP status number: never a body, never a URL with credentials. */
    readonly detail: string | null = null,
    /**
     * Seconds the provider asked us to wait, when the response said so. It is carried HERE because the
     * alternative is losing it: a caller catches the error, not the response, and a rate limit whose
     * `Retry-After` was thrown away turns into a retry at the wrong moment — the one behaviour a
     * throttled third party punishes hardest.
     */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`tool_outbound:${code}${detail === null ? "" : `:${detail}`}`);
    this.name = "ToolOutboundError";
  }
}

const IP_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True for anything that resolves to, or spells out, a non-public location. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "" ) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  if (h === "metadata" || h === "metadata.google.internal") return true;
  // IPv4, including the forms a naive parser accepts: decimal, hex, octal, and the compressed
  // `127.1`, `0x7f.1` styles. `URL.hostname` normalises some but NOT all of these across engines, so
  // the check is written against the shapes rather than trusting one canonicalisation.
  if (IP_LITERAL.test(h)) {
    const parts = h.split(".").map((p) => {
      if (p.startsWith("0x") || p.startsWith("0X")) return Number.parseInt(p, 16);
      if (p.length > 1 && p.startsWith("0")) return Number.parseInt(p.slice(1), 8);
      return Number.parseInt(p, 10);
    });
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true; // malformed ⇒ refuse
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local, incl. the cloud metadata address
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  // IPv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10), and the IPv4-mapped
  // prefix in either dotted or hex tail form (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
  if (h.includes(":")) {
    if (h === "::" || h === "::1") return true;
    if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
    const tail = h.split(":").pop() ?? "";
    if (tail.includes(".")) return isPrivateHost(tail);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
    if (mapped !== null) {
      const hi = Number.parseInt(mapped[1] ?? "0", 16);
      const lo = Number.parseInt(mapped[2] ?? "0", 16);
      return isPrivateHost(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return false;
  }
  // A bracketed bare-number hostname (`http://2130706433/` = 127.0.0.1 in some resolvers) and any
  // all-numeric hostname with no dot are refused outright rather than resolved.
  if (/^\d+$/.test(h)) return true;
  if (!h.includes(".")) return true;
  return false;
}

export interface SafeUrlOptions {
  /** Allow `http:` as well as `https:`. Off by default; used only for an operator-configured endpoint. */
  readonly allowHttp?: boolean;
  /** For an operator endpoint: private addresses permitted. NEVER set for a request destination. */
  readonly allowPrivate?: boolean;
  /** Refuse everything except these hosts (or their subdomains). Used by chart capture. */
  readonly allowHosts?: readonly string[];
}

/**
 * Parse and vet a URL that somebody else chose. Throws `ToolOutboundError("UNSAFE_TARGET")` with a
 * fixed reason; it never echoes the rejected value, because the value is what an attacker typed.
 */
export function assertSafeUrl(raw: string, opts: SafeUrlOptions = {}): URL {
  const trimmed = raw.trim();
  if (trimmed === "") throw new ToolOutboundError("UNSAFE_TARGET", "empty");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ToolOutboundError("UNSAFE_TARGET", "unparseable");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && opts.allowHttp === true)) {
    throw new ToolOutboundError("UNSAFE_TARGET", "scheme");
  }
  if (url.username !== "" || url.password !== "") throw new ToolOutboundError("UNSAFE_TARGET", "credentials");
  if (url.hostname === "") throw new ToolOutboundError("UNSAFE_TARGET", "no-host");
  if (opts.allowPrivate !== true && isPrivateHost(url.hostname)) throw new ToolOutboundError("UNSAFE_TARGET", "private");
  if (opts.allowHosts !== undefined && opts.allowHosts.length > 0) {
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const ok = opts.allowHosts.some((a) => host === a || host.endsWith(`.${a}`));
    if (!ok) throw new ToolOutboundError("UNSAFE_TARGET", "host-not-allowed");
  }
  // A fragment is never sent to a server, and a `#` in a captured URL is a sign of a hand-built string.
  if (url.username === "" && url.password === "" && url.search.length > 4_096) throw new ToolOutboundError("UNSAFE_TARGET", "query-too-long");
  return url;
}

/** Map an HTTP status onto the fixed buckets admin needs, without pretending to know the provider. */
export function classifyStatus(status: number): ToolOutboundCode | "OK" {
  if (status >= 200 && status < 300) return "OK";
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return "QUOTA";
  if (status === 408) return "TIMEOUT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "NETWORK";
  return "STATUS";
}

export interface ToolFetchInit {
  readonly method: "GET" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: string | undefined;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface ToolFetchResult {
  readonly status: number;
  readonly bytes: Buffer;
  readonly contentType: string;
}

/**
 * fetch() with a deadline, a size ceiling and no silent redirect-following.
 *
 * `redirect: "manual"` is not decoration: a provider that 302s to an internal address would otherwise
 * make this request the second half of an SSRF chain, with our own credentials attached. So a 3xx is
 * an ERROR here (`UNSAFE_TARGET:redirect`), and any caller that genuinely needs to follow one must
 * re-validate the `Location` and call again — a visible two-step rather than an invisible one.
 */
export async function toolFetch(
  url: URL,
  init: ToolFetchInit,
  /**
   * Injectable for tests, and ONLY for tests. The default is the platform's own fetch; a fake exists so
   * the request-building and error-mapping behaviour can be asserted without egress, which is what
   * "no real messages/requests during this task" requires.
   */
  fetchImpl: typeof fetch | undefined = undefined,
): Promise<ToolFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  const doFetch = fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(url as unknown as Parameters<typeof fetch>[0], {
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: { accept: "application/json, image/png;q=0.9, text/plain;q=0.5", ...(init.headers ?? {}) },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") throw new ToolOutboundError("TIMEOUT");
    throw new ToolOutboundError("NETWORK");
  }
  try {
    if (response.status >= 300 && response.status < 400) throw new ToolOutboundError("UNSAFE_TARGET", "redirect");
    const code = classifyStatus(response.status);
    if (code !== "OK") {
      // Drain nothing. A 5 MB error page is not worth reading, and the status is the whole signal —
      // except for the one header that changes what the caller should do next.
      throw new ToolOutboundError(code, String(response.status), retryAfterOf(response));
    }
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > init.maxResponseBytes) throw new ToolOutboundError("TOO_LARGE");
    const reader = response.body?.getReader();
    if (reader === undefined) return { status: response.status, bytes: Buffer.alloc(0), contentType: response.headers.get("content-type") ?? "" };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // The declared length can lie, and a chunked response has none. The running total is the real cap.
      if (total > init.maxResponseBytes) {
        await reader.cancel();
        throw new ToolOutboundError("TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
    return { status: response.status, bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse JSON from a tool response, refusing to guess when the body is not what was promised. */
export function parseToolJson(bytes: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new ToolOutboundError("MALFORMED");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ToolOutboundError("MALFORMED");
  return parsed as Record<string, unknown>;
}

/** `Retry-After` in seconds, clamped. A provider that asks for an hour gets an hour, not a retry loop. */
/** `Retry-After`, in seconds, if the response carried one and it parses as a small positive number. */
function retryAfterOf(response: { headers: { get(name: string): string | null } }): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 3_600 ? n : null;
}

export function retryAfterSeconds(response: { headers: { get(name: string): string | null } } | null): number | null {
  if (response === null) return null;
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(n, 3_600));
}
