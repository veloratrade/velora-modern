/**
 * Where the API lives — the ONE place this app names it.
 *
 * The panel never talks to the API origin directly from the browser: every `/api/*` call is same-origin
 * and is forwarded by `src/app/api/[...path]/route.ts`, and the edge gate in `src/proxy.ts` asks the same
 * origin whether a session is live. Both read the origin from here, so there is exactly one variable to
 * change per deployment (`VELORA_API_ORIGIN`) and no second, quietly different copy of it.
 *
 * WHY AN ENV VAR AND NOT A SERVICE BINDING. A Workers service binding would be faster and would skip the
 * public hop, but it only exists on Cloudflare. `VELORA_API_ORIGIN` works unchanged on the future VPS
 * (`http://127.0.0.1:8080`, the API's own port) and in local dev, and this file is the seam where a
 * binding can later be preferred when present without touching either caller.
 *
 * WHY IT IS RESOLVED PER REQUEST, NOT AT MODULE LOAD. On Workers, `process.env` is populated per request
 * by the adapter; a module-level read captures whatever happened to be there at isolate start — often
 * nothing — and the failure mode is silent: the panel would probe `127.0.0.1:8080`, get a connection
 * error, fail closed, and redirect every protected page to /login with no clue why. That is exactly the
 * class of bug this file exists to prevent, so the lookup is a function.
 */

/** Local development only: the API's own default port (`apps/api/src/server-main.ts`). */
export const DEFAULT_DEV_API_ORIGIN = "http://127.0.0.1:8080";

/**
 * The API origin, or `null` when the configured value is unusable.
 *
 * A `null` answer is a hard failure the callers must surface (503 / fail-closed gate) rather than paper
 * over with a default: guessing an origin is how the staging panel ended up sending logins to a host that
 * does not exist.
 */
export function resolveApiOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.VELORA_API_ORIGIN ?? "").trim();
  const value = raw === "" ? DEFAULT_DEV_API_ORIGIN : raw;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // A URL that carries credentials would be logged by anything that prints the origin. Refuse it.
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

/** Same answer as {@link resolveApiOrigin}, for callers that cannot proceed at all without one. */
export function requireApiOrigin(env: Record<string, string | undefined> = process.env): string {
  const origin = resolveApiOrigin(env);
  if (origin === null) {
    throw new Error("VELORA_API_ORIGIN is not a usable http(s) origin");
  }
  return origin;
}
