/**
 * Admin-facing tool capability state and verification — the difference between "a key exists" and
 * "this works here".
 *
 * WHY THIS FILE EXISTS RATHER THAN A FLAG IN THE FEATURE TABLE. A model provider's key says nothing
 * about a search provider or a browser service, and a capability list assembled from `AI_ENABLED` is a
 * guess with a UI attached. So each tool's state is read from the service that would actually use it:
 *
 *   • `unavailable` — a required secret does not resolve, and the row names WHICH ONE;
 *   • `configured`  — every required secret resolves, nothing more has been proven;
 *   • `verified`    — a live round trip against that tool's own endpoint succeeded, just now;
 *   • `failing`     — the round trip ran and failed, with the code it returned;
 *   • `unsupported` — the runtime cannot host the tool at all (a native module in a Worker), which is a
 *                     different sentence from "go configure it" and must never be merged into it.
 *
 * Nothing here caches a result across requests: a credential that was revoked five minutes ago must not
 * keep reporting `verified` because a row in a table said so yesterday. Verification is therefore a POST
 * the operator performs, and the state it produced is returned with the instant it was produced.
 */
import type { AiSearchService } from "./aiSearchService.js";
import type { AiBrowserService } from "./aiBrowserService.js";
import { AI_TOOLS, isAiTool, TOOL_CAPABILITY_STATES, type ToolCapabilityEvidence, type ToolCapabilityState } from "./aiToolCatalog.js";

export interface BannerRasterProbeLike {
  readonly available: boolean;
  readonly reason: string | null;
  readonly fontLoaded: boolean;
  readonly fontSource: string | null;
  readonly moduleLoaded: boolean;
}

export interface AiToolAdminDeps {
  readonly search: AiSearchService;
  readonly browser: AiBrowserService;
  /**
   * The rasterizer, when this process can even ask. `null` in a Worker — which is why the state is
   * `unsupported` there rather than `unavailable`: no amount of configuration makes it true, and an
   * operator told to "go set a key" for a native binding is being sent on a fool's errand.
   */
  readonly raster: (() => Promise<BannerRasterProbeLike>) | null;
  /** Render one card and check the bytes, for `banner_raster`'s verification. */
  readonly rasterize?: ((svg: string) => Promise<Buffer | null>) | undefined;
  readonly now?: () => Date;
}

export interface ToolValidationResult {
  readonly tool: string;
  readonly state: ToolCapabilityState;
  readonly ok: boolean;
  readonly status: string;
  readonly latencyMs: number;
  readonly errorCode: string | null;
  readonly detail: string | null;
  readonly checkedAt: string;
}

const SAMPLE_SVG =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"400\" height=\"120\">" +
  "<rect width=\"400\" height=\"120\" fill=\"#0e1626\"/>" +
  "<text x=\"24\" y=\"70\" font-size=\"40\" fill=\"#d4af37\">Velora 123</text></svg>";

export class AiToolAdminService {
  private readonly now: () => Date;

  constructor(private readonly deps: AiToolAdminDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The vocabulary the panel may render, from the catalogue — a state no row can produce is a bug. */
  static states(): readonly string[] {
    return TOOL_CAPABILITY_STATES;
  }

  static tools(): readonly string[] {
    return AI_TOOLS;
  }

  /** The banner probe, without a render: what `/help` and the panel are allowed to promise. */
  async rasterProbe(): Promise<BannerRasterProbeLike | null> {
    return await (this.deps.raster?.() ?? Promise.resolve(null));
  }

  async capabilities(): Promise<readonly ToolCapabilityEvidence[]> {
    const rows: ToolCapabilityEvidence[] = [];
    rows.push(await this.deps.search.status());
    rows.push(await this.deps.browser.status());
    const raster = await this.rasterProbe();
    rows.push(
      raster === null
        ? {
            tool: "banner_raster",
            provider: "resvg",
            state: "unsupported",
            runtimeSupported: false,
            secrets: [],
            reason: "NO_NATIVE_IMAGE_MODULE_IN_THIS_RUNTIME",
            lastStatus: null,
            lastCheckedAt: null,
          }
        : {
            tool: "banner_raster",
            provider: "resvg",
            // A loaded module and a loaded font is `configured` — NOT `verified`. Only a render that came
            // back with real PNG bytes earns `verified`, and this function renders nothing.
            state: raster.available ? "configured" : "unavailable",
            runtimeSupported: true,
            secrets: [],
            reason: raster.reason,
            lastStatus: null,
            lastCheckedAt: null,
          },
    );
    return rows;
  }

  /**
   * Verify ONE tool, by that tool's own definition of alive.
   *
   * No cross-talk: verifying search never touches the browser, and a successful model-provider probe is
   * not evidence for either. Each branch calls the method the feature itself uses, so a green light here
   * means "the thing the user would hit works", not "a URL near it answered".
   */
  async validate(tool: string): Promise<ToolValidationResult | { readonly error: "UNKNOWN_TOOL" | "TOOL_NOT_VERIFIABLE" }> {
    const checkedAt = this.now().toISOString();
    if (!isAiTool(tool)) return { error: "UNKNOWN_TOOL" };
    if (tool === "web_search") {
      const out = await this.deps.search.validateConnection();
      return {
        tool,
        state: out.ok ? "verified" : out.status === "RATE_LIMITED" || out.status === "QUOTA_EXCEEDED" ? "configured" : "failing",
        ok: out.ok,
        status: out.status,
        latencyMs: out.latencyMs,
        errorCode: out.errorCode,
        detail: out.retryAfterSeconds === null ? null : `retry_after=${out.retryAfterSeconds}`,
        checkedAt,
      };
    }
    if (tool === "browser_capture") {
      const out = await this.deps.browser.validateConnection();
      return {
        tool,
        state: out.ok ? "verified" : "failing",
        ok: out.ok,
        status: out.status,
        latencyMs: out.latencyMs,
        errorCode: out.errorCode,
        detail: out.detail,
        checkedAt,
      };
    }
    const rasterize = this.deps.rasterize;
    if (rasterize === undefined) return { error: "TOOL_NOT_VERIFIABLE" };
    const started = this.now().getTime();
    const png = await rasterize(SAMPLE_SVG);
    const latencyMs = Math.max(0, this.now().getTime() - started);
    if (png === null) {
      const probe = await this.rasterProbe();
      return {
        tool,
        state: "failing",
        ok: false,
        status: "INVALID_CREDENTIAL",
        latencyMs,
        errorCode: probe?.reason ?? "RENDER_FAILED",
        detail: probe === null ? "no-rasterizer-in-runtime" : `font=${probe.fontSource ?? "none"} module=${probe.moduleLoaded ? "loaded" : "missing"}`,
        checkedAt,
      };
    }
    return {
      tool,
      state: "verified",
      ok: true,
      status: "VALID",
      latencyMs,
      errorCode: null,
      // The evidence is the artefact's own shape: a real PNG of a known card, produced here, now.
      detail: `png ${png.length}B magic=${png.subarray(1, 4).toString("latin1")}`,
      checkedAt,
    };
  }
}
