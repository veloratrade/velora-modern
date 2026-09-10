import * as jose from 'jose';
import { env } from '../../config/env.js';

export interface JwtAccessTokenPayload extends jose.JWTPayload {
  sub: string;
  role: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

export class JwtService {
  private static getSecretKey(): Uint8Array {
    const secret = env.JWT_SECRET || 'velora_development_jwt_secret_32_chars_min!!';
    return new TextEncoder().encode(secret);
  }

  /**
   * Encode JWT access token using HS256
   */
  static async signAccessToken(
    payload: { sub: string; role: string },
    ttlSeconds = 900, // Default 15 minutes
  ): Promise<string> {
    const secretKey = this.getSecretKey();
    const jti = Math.random().toString(36).substring(2) + Date.now().toString(36);

    return new jose.SignJWT({ ...payload })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
      .setJti(jti)
      .sign(secretKey);
  }

  /**
   * Verify and decode JWT access token.
   * Returns decoded payload or null if invalid/expired.
   */
  static async verifyAccessToken(token: string): Promise<JwtAccessTokenPayload | null> {
    if (!token) {
      return null;
    }

    try {
      const secretKey = this.getSecretKey();
      const { payload } = await jose.jwtVerify(token, secretKey, {
        algorithms: ['HS256'],
      });
      return payload as JwtAccessTokenPayload;
    } catch {
      return null;
    }
  }
}
