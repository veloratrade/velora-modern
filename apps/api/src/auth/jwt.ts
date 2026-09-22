// JWT service — HS256 via node:crypto, fail-closed. Phase B (S1/S6).
//
// S1 — NO fallback secret: this module never reads the process environment,
//      never derives or substitutes a secret, and construction without a
//      usable secret throws. Environment policy (required in production/
//      staging, minimum length) lives in @velora/contracts
//      validateSecurityBoot (SC-001/002).
// S6 — secure jti: every token carries a jti generated with
//      crypto.randomUUID() (OS CSPRNG). Math.random() is never used for any
//      security identifier (the only Math.random uses in the repository are
//      the injectable retry-jitter RNGs in queue semantics — not security).
//
// Token format: standard JWS compact serialization (RFC 7515/7519) —
// base64url(header).base64url(payload).base64url(HMAC-SHA256). Cross-
// implementation compatibility is proven in jwt.test.ts against a token
// signed by an independent implementation (Python stdlib) at test time.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/** Custom claims. `sub` (subject) is required; extras pass through. */
export type JwtClaims = { sub: string } & Record<string, string | number | boolean>;

/** Verified token payload — standard claims plus the caller's claims. */
export type JwtPayload = JwtClaims & { jti?: string; iat?: number; exp: number };

export class JwtConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtConfigError";
  }
}

export interface JwtOptions {
  /**
   * Clock (unix seconds) for signing and expiry evaluation. Default: real
   * time. Injectable for deterministic expiry tests (TestClock pattern);
   * jti entropy is NEVER injectable (S6).
   */
  readonly now?: () => number;
}

const B64URL = "base64url";
const HMAC_BYTES = 32; // SHA-256 digest length

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString(B64URL);
}

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data, "utf8").digest();
}

export class JwtService {
  private constructor(
    private readonly secret: string,
    private readonly now: () => number,
  ) {}

  /**
   * Fail-closed construction: a missing or whitespace-only secret throws.
   * There is no default secret and no fallback — anywhere.
   */
  static create(secret: string, options: JwtOptions = {}): JwtService {
    if (typeof secret !== "string" || secret.trim() === "") {
      throw new JwtConfigError(
        "JWT secret is missing or empty — refusing to construct the service. There is no fallback secret (S1).",
      );
    }
    return new JwtService(secret, options.now ?? (() => Math.floor(Date.now() / 1000)));
  }

  /** Sign claims with a fresh secure jti and a bounded lifetime. */
  sign(claims: JwtClaims, ttlSeconds: number): string {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new JwtConfigError("ttlSeconds must be a positive integer");
    }
    if (typeof claims.sub !== "string" || claims.sub === "") {
      throw new JwtConfigError("claims.sub must be a non-empty string");
    }
    const iat = this.now();
    const payload: JwtPayload = { ...claims, jti: randomUUID(), iat, exp: iat + ttlSeconds };
    const head = b64urlJson({ alg: "HS256", typ: "JWT" });
    const body = b64urlJson(payload);
    const sig = hmac(this.secret, `${head}.${body}`).toString(B64URL);
    return `${head}.${body}.${sig}`;
  }

  /**
   * Verify signature + header + expiry. Returns the payload, or null for ANY
   * malformed, tampered, wrongly-signed, non-HS256, or expired token — never
   * throws for invalid tokens (callers treat null as rejection).
   */
  verify(token: string): JwtPayload | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const head = parts[0];
    const body = parts[1];
    const sig = parts[2];
    if (head === undefined || body === undefined || sig === undefined) return null;

    // Header: exactly alg=HS256, typ=JWT — rejects "none" and alg confusion.
    let header: unknown;
    try {
      header = JSON.parse(Buffer.from(head, B64URL).toString("utf8"));
    } catch {
      return null;
    }
    if (typeof header !== "object" || header === null) return null;
    const h = header as Record<string, unknown>;
    if (h.alg !== "HS256" || h.typ !== "JWT") return null;

    // Signature: constant-time comparison.
    const expected = hmac(this.secret, `${head}.${body}`);
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, B64URL);
    } catch {
      return null;
    }
    if (provided.length !== HMAC_BYTES || !timingSafeEqual(expected, provided)) return null;

    // Payload: sub + exp required; exp strictly in the future.
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, B64URL).toString("utf8"));
    } catch {
      return null;
    }
    if (typeof payload !== "object" || payload === null) return null;
    const p = payload as Record<string, unknown>;
    if (typeof p.sub !== "string" || typeof p.exp !== "number" || !Number.isFinite(p.exp)) {
      return null;
    }
    if (this.now() >= p.exp) return null;
    return payload as JwtPayload;
  }
}
