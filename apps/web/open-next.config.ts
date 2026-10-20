// OpenNext configuration for the Velora admin panel on Cloudflare Workers.
//
// WHAT THIS ADAPTER IS. `@opennextjs/cloudflare` is Cloudflare's own supported path for running an
// unmodified Next.js app in a Worker: it builds the app with `next build`, then emits a Worker
// (`.open-next/worker.js`) that runs the Next server, its route handlers AND `src/proxy.ts` (Next 16's
// middleware) inside `nodejs_compat`. Nothing in `src/` is rewritten to fit: no `output: "export"` (this
// app has dynamic routes, middleware and cookie-bound pages — static export cannot express any of them),
// no route-by-route ports.
//
// WHAT IS DELIBERATELY NOT ENABLED. No incremental cache backend (R2/KV/D1) and no tag cache. Both need
// a new Cloudflare resource, and this deployment is staging-only with a standing "no new paid resources"
// constraint. The consequence is honest and bounded: pages render on demand and the Next cache does not
// persist between requests. Every page in the panel is already dynamic (`force-dynamic` behind the
// session gate), so nothing regresses — but it is the first thing to add when staging needs caching.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
