import type { NextConfig } from "next";

// apps/web Next configuration — Stage 1 §H.1/§H.4.
//  - trailingSlash:false + skipTrailingSlashRedirect: the ADR-009 URL contract mixes
//    "/en/" (slash) with "/login" (no slash); Next's global rule cannot express it and
//    would loop with the localeKernel's "/en" -> "/en/" 308. proxy.ts owns canonical form.
//  - transpilePackages: @velora/contracts and @velora/domain ship TypeScript
//    source. The web app imports the domain P&L engine for the trade form's live
//    preview (TRD-02) precisely so the preview cannot drift from the server's
//    stored numbers — one formula, two callers.
//  - poweredByHeader:false: no framework fingerprint (parity with the API kernel).
const nextConfig: NextConfig = {
  // BUNDLER: webpack, not Turbopack — and for one concrete reason.
  // `@velora/domain` ships TypeScript SOURCE whose internal imports carry
  // explicit `.js` specifiers (`export * from "./decimal.js"`), the standard TS
  // ESM convention this repo uses everywhere and what `tsc -b`/tsx consume.
  // Turbopack has no `.js` -> `.ts` extension aliasing, so the moment the web app
  // imports that package at RUNTIME (the trade form's live P&L preview, TRD-02)
  // the build fails with 20 "Can't resolve './decimal.js'" errors. webpack
  // expresses this in one line (`resolve.extensionAlias`), so the web build runs
  // on webpack. Scripts in package.json pass --webpack for build and dev; nothing
  // else in the app depends on the builder.
  trailingSlash: false,
  skipTrailingSlashRedirect: true,
  transpilePackages: ["@velora/contracts", "@velora/domain"],
  poweredByHeader: false,
  reactStrictMode: true,
  // The browser stays same-origin (no CORS, no third-party cookies) while the web app and the API run
  // as separate processes (ADR-010): `/api/*` is forwarded by a route handler, not by a rewrite.
  // `.js` in an import specifier may be a TypeScript file on disk (TS ESM).
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  // NO `rewrites()` FOR /api — deliberately. There used to be one here, `source: "/api/:path*"` to
  // `${VELORA_API_ORIGIN}/api/:path*`, and it was the bug: a rewrite is baked at BUILD time, so the
  // staging bundle carried whatever origin the build machine had (a Railway host that no longer
  // exists), the browser followed it, and Cloudflare answered `404 Application not found` — a platform
  // error, not the API's. `src/app/api/[...path]/route.ts` forwards the same paths instead, reading the
  // origin at REQUEST time, so changing the origin is a variable change and never a rebuild.
};

export default nextConfig;
