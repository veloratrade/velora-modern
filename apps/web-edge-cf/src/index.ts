/**
 * Workers entry point — deliberately a five-line wiring of the tested pure handler.
 * All logic lives in handler.ts; anything tempting a future editor to put logic HERE belongs
 * in handler.ts plus a node --test case, not in this file.
 */
import { createHandler, type AssetsNamespace, type EdgeEnv } from "./handler.ts";

interface WorkerEnv extends EdgeEnv {
  readonly ASSETS: AssetsNamespace;
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return createHandler(env, env.ASSETS)(request);
  },
} satisfies { fetch: (request: Request, env: WorkerEnv) => Promise<Response> };
