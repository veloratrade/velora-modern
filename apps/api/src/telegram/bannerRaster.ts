/**
 * SVG → PNG for the banner cards, in the runtime that can actually do it.
 *
 * WHY THIS FILE IS IN `apps/api` AND NOT IN `packages/domain`.
 *   The domain layer renders the SVG and must stay runnable in a Cloudflare Worker, where a native
 *   image module cannot exist at all. Rasterization is therefore an *adapter* of the Node runtime:
 *   this file probes for the dependency at construction, and when the probe fails the caller keeps the
 *   text card and the admin panel reports `unsupported` with the reason. Nothing here throws at import
 *   time and nothing here makes a capability claim the runtime cannot support.
 *
 * THE FONT IS PART OF THE FEATURE, NOT AN ASSET DETAIL.
 *   A Persian banner rasterized without an Arabic-script font is a rectangle of empty boxes — a
 *   plausible-looking image whose content silently failed to render. That is worse than no image, so
 *   the font is resolved and *verified*: if it cannot be loaded, the rasterizer reports itself
 *   unavailable rather than producing a decorative lie. `vazirmatn` is the font Velora's own UI uses,
 *   shipped as TTFs by the package (resvg cannot read woff2).
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BannerRasterizer {
  readonly available: true;
  readonly provider: "resvg";
  readonly fontLoaded: true;
  /** Which file was loaded and where it came from — the evidence behind `fontLoaded`. */
  readonly fontPath: string;
  readonly fontSource: string;
  /** `null` means "this SVG could not be rasterized" — never a partial or substituted image. */
  toPng(svg: string, opts?: { readonly width?: number | undefined }): Promise<Buffer | null>;
}

export interface BannerRasterProbe {
  readonly available: boolean;
  readonly reason: string | null;
  readonly fontLoaded: boolean;
  readonly fontSource: string | null;
  readonly moduleLoaded: boolean;
}

interface ResvgCtor {
  new (svg: string, options: Record<string, unknown>): {
    render(): { asPng(): Uint8Array };
    width?: number;
    height?: number;
  };
}

let cached: Promise<BannerRasterizer | null> | null = null;

/**
 * Where a usable Persian TTF may live, in priority order.
 *
 * The `vazirmatn` package has no `main` and no `exports`, so the usual resolution tricks fail on it —
 * which is fine for a font package and means the lookup has to be a directory walk. Ancestors are
 * searched because this monorepo hoists `node_modules` to the workspace root, while a deployed image
 * has it under the app itself; an operator can also name a path outright.
 */
const FONT_WEIGHTS = ["SemiBold", "Bold", "Regular", "Medium"] as const;

function ancestorDirs(from: URL | string): string[] {
  const origin = typeof from === "string" ? from : dirname(new URL(from).pathname);
  const out: string[] = [];
  let dir = origin.startsWith("/") ? origin : dirname(new URL(import.meta.url).pathname);
  for (let hops = 0; hops < 8 && dir !== "/" && dir !== ""; hops += 1) {
    out.push(dir);
    dir = dirname(dir);
  }
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    try {
      out.push(process.cwd());
    } catch {
      // no cwd (an exotic runtime): the caller's ancestors are still enough.
    }
  }
  return out;
}

function fontCandidates(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const explicit = (process.env["VELORA_BANNER_FONT_PATH"] ?? "").trim();
  if (explicit !== "") out.push({ path: explicit, source: "env:VELORA_BANNER_FONT_PATH" });
  const explicitDir = (process.env["VELORA_BANNER_FONT_DIR"] ?? "").trim();
  if (explicitDir !== "") {
    for (const weight of FONT_WEIGHTS) out.push({ path: join(explicitDir, `Vazirmatn-${weight}.ttf`), source: "env:VELORA_BANNER_FONT_DIR" });
  }
  for (const root of ancestorDirs(import.meta.url)) {
    for (const weight of FONT_WEIGHTS) {
      out.push({ path: join(root, "node_modules", "vazirmatn", "fonts", "ttf", `Vazirmatn-${weight}.ttf`), source: "package:vazirmatn" });
    }
  }
  // A system-installed Persian/Arabic face counts too: on a server image the font is often present
  // while the npm tree is pruned. These are guesses about the file system, never claims about output.
  for (const name of [
    "vazir/Vazirmatn-SemiBold.ttf", "vazir/Vazir.ttf", "Vazirmatn/Vazirmatn-SemiBold.ttf",
    "noto/NotoNaskhArabic-Bold.ttf", "noto/NotoNaskhArabic-Regular.ttf", "noto/NotoSansArabic-Bold.ttf",
  ]) {
    out.push({ path: join("/usr/share/fonts/truetype", name), source: "system" });
    out.push({ path: join("/usr/share/fonts/opentype", name), source: "system" });
  }
  return out;
}

function loadFont(): { path: string; bytes: Buffer; source: string } | null {
  for (const candidate of fontCandidates()) {
    try {
      if (!existsSync(candidate.path)) continue;
      const bytes = readFileSync(candidate.path);
      // A TTF/OTF is recognisable by its sfnt version or the 'OTTO' tag. Checking the magic is what
      // makes "the font file exists" different from "the font can be used".
      const head = bytes.subarray(0, 4).toString("latin1");
      // The sfnt signatures that resvg/rustybuzz can consume. The first two are the two orders a
      // TrueType version field is written in, and `Vazirmatn-*.ttf` uses the second one — which is why
      // this list was widened rather than left at the textbook value. wOFF/woff2 are NOT accepted:
      // the renderer cannot read them, and "loaded" would then mean "silently produced boxes".
      const ok =
        head === "\u0000\u0001\u0000\u0000" ||
        head === "\u0001\u0000\u0000\u0000" ||
        head === "OTTO" ||
        head === "true" ||
        head === "ttcf";
      if (ok && bytes.length > 4_096) return { path: candidate.path, bytes, source: candidate.source };
    } catch {
      // Unreadable ⇒ try the next candidate. Never fall through to "no font, render anyway".
    }
  }
  return null;
}

async function loadResvg(): Promise<ResvgCtor | null> {
  try {
    // `as unknown as` rather than a typed import: the module is loaded dynamically ON PURPOSE (a
    // static import would pull a native binding into a bundle that a Worker has to load), so the
    // compiler never sees its real type and the shape is asserted by the probe plus the tests below.
    const mod = (await import("@resvg/resvg-js")) as unknown as { Resvg?: ResvgCtor; default?: ResvgCtor };
    const ctor = mod.Resvg ?? mod.default ?? null;
    return typeof ctor === "function" ? (ctor as ResvgCtor) : null;
  } catch {
    return null;
  }
}

/**
 * Build once, then reuse. The module load and the font read are both process-level facts, and a probe
 * per post would turn a 5 MB font read into a per-publish cost for no benefit.
 */
export function bannerRasterizer(): Promise<BannerRasterizer | null> {
  if (cached !== null) return cached;
  cached = (async (): Promise<BannerRasterizer | null> => {
    const ctor = await loadResvg();
    if (ctor === null) return null;
    const font = loadFont();
    if (font === null) return null;
    const fontFiles: Record<string, Buffer> = { Vazirmatn: font.bytes };
    return {
      available: true,
      provider: "resvg",
      fontLoaded: true,
      fontPath: font.path,
      fontSource: font.source,
      async toPng(svg: string, opts): Promise<Buffer | null> {
        try {
          const instance = new ctor(svg, {
            font: { fontFiles, defaultFontFamily: "Vazirmatn", loadSystemFonts: false, defaultFontSize: 32, sansSerifFamily: "Vazirmatn" },
            background: "rgba(0,0,0,0)",
            ...(opts?.width !== undefined ? { fitTo: { mode: "width", value: opts.width } } : {}),
          });
          const png = instance.render().asPng();
          const bytes = Buffer.from(png);
          // A PNG of a card that rendered nothing is a bug the user would only discover in the channel.
          // 2 KiB is below any card with text in it, so this is a sanity floor, not a size policy.
          if (bytes.length < 2_048) return null;
          return bytes;
        } catch {
          return null;
        }
      },
    };
  })();
  return cached;
}

/** What the admin panel and `/help` are allowed to say, derived from the probe rather than asserted. */
export async function probeBannerRaster(): Promise<BannerRasterProbe> {
  const ctor = await loadResvg();
  const font = loadFont();
  const moduleLoaded = ctor !== null;
  const fontLoaded = font !== null;
  return {
    available: moduleLoaded && fontLoaded,
    moduleLoaded,
    fontLoaded,
    fontSource: font?.source ?? null,
    reason: !moduleLoaded ? "NO_RESVG_MODULE" : !fontLoaded ? "NO_PERSIAN_FONT" : null,
  };
}

/** Test seam only: forget the cached probe so a suite can simulate both runtimes. */
export function __resetBannerRasterCacheForTests(): void {
  cached = null;
}
