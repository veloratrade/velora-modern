import type { NextConfig } from "next";

// apps/web Next configuration — Stage 1 §H.1/§H.4.
//  - trailingSlash:false + skipTrailingSlashRedirect: the ADR-009 URL contract mixes
//    "/en/" (slash) with "/login" (no slash); Next's global rule cannot express it and
//    would loop with the localeKernel's "/en" -> "/en/" 308. proxy.ts owns canonical form.
//  - transpilePackages: @velora/contracts ships TypeScript source.
//  - poweredByHeader:false: no framework fingerprint (parity with the API kernel).
const nextConfig: NextConfig = {
  trailingSlash: false,
  skipTrailingSlashRedirect: true,
  transpilePackages: ["@velora/contracts"],
  poweredByHeader: false,
  reactStrictMode: true,
  // W1: API proxy for local dev and same-origin contract.
  // In production Railway's reverse proxy handles TLS/HSTS and routes /api to the API service.
  // In dev, Next rewrites /api to the API process (VELORA_API_ORIGIN or default 8080).
  // This keeps the browser same-origin (no CORS) while allowing the web dev server
  // to run separately from the API (ADR-010). No business-logic coupling.
  async rewrites() {
    const origin = process.env.VELORA_API_ORIGIN ?? "http://127.0.0.1:8080";
    return [{ source: "/api/:path*", destination: `${origin}/api/:path*` }];
  },
};

export default nextConfig;
