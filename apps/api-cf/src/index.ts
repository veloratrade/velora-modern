/**
 * Workers entry point — three lines of wiring over the tested bridge and composition root.
 *
 * Everything that decides anything lives in `apps/api` (routing, auth, RBAC, envelopes) or in
 * `runtime.ts` (which capabilities this deployment has). A future editor tempted to add logic HERE
 * should add it there, with a test.
 */
import { createFetch, type Env } from "./runtime.js";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createFetch(env, ctx)(request);
  },
} satisfies { fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> };
