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
};

export default nextConfig;
