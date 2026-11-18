// Test fixture: an access token that is backed by a LIVE session row, the only
// kind the API accepts since AUTH-REVOKE (Legacy AuthService::authenticate
// re-reads the user and the session on every protected request, and takes the
// role from the user row — never from the token).
//
// A bare `JwtService.sign({ sub, role })` is a forged-but-signed token that no
// login ever produced; suites that need a signed-in caller use this instead.
import { createHash, randomBytes } from "node:crypto";
import type { AppRoleName } from "./userStore.js";
import type { MemoryUserStore } from "./memoryUserStore.js";
import { JwtService } from "./jwt.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export async function sessionTokenFor(
  store: MemoryUserStore,
  secret: string,
  sub: string,
  role: string = "user",
  opts: { omitRoleClaim?: boolean } = {},
): Promise<string> {
  const existing = await store.findUserById(sub);
  if (existing === null) store.seedUser({ id: sub, role: role as AppRoleName });
  else if (existing.role !== role) await store.updateUserRole(sub, role as AppRoleName, new Date());
  // `omitRoleClaim`: a live-session token whose JWT carries no `role` claim
  // (the role must come from the user row, never from the token).
  return liveSessionToken(store, secret, opts.omitRoleClaim === true ? { sub } : { sub, role });
}

/**
 * Signs `claims` VERBATIM (including lying role / systemOwner claims) and backs
 * the token with a live session for `claims.sub`, WITHOUT touching the user
 * row. For suites proving that token claims grant nothing the row does not.
 */
export async function liveSessionToken(
  store: MemoryUserStore,
  secret: string,
  claims: { sub: string } & Record<string, string | number | boolean>,
): Promise<string> {
  const token = JwtService.create(secret).sign(claims as { sub: string }, 900);
  await store.createSession({
    userId: claims.sub,
    refreshTokenHash: sha256(randomBytes(32).toString("hex")),
    accessTokenHash: sha256(token),
    ipAddress: null,
    userAgent: null,
    // Far enough out that suites pinning `now` to any 2026 date still see it live.
    expiresAt: new Date(Date.now() + YEAR_MS),
    createdAt: new Date(),
  });
  return token;
}
