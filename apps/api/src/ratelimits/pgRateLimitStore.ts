// PgRateLimitStore — Phase D D2: the real-PostgreSQL RateLimitStore adapter
// (direct pg). Port semantics (fixed window anchored at the first hit,
// preserved on increment, reset only after the bucket's OWN window expires)
// are PHP Core/RateLimiter.php parity and MUST match the memory store and the
// PGlite evidence adapter (db/tests/rateLimitPersistence.test.ts).
//
// PostgreSQL-specific divergence from the guidance adapter (deliberate, per
// D1 risk R6): instead of DELETE-expired → INSERT ON CONFLICT → SELECT as
// three separate autocommitted statements, the whole hit is ONE atomic
// statement — INSERT … ON CONFLICT (bucket) DO UPDATE with CASE-based window
// reset, RETURNING the resulting state. The upsert's row lock serializes
// concurrent hits on the same bucket, so no increment can be lost or skipped
// (atomicity VERIFIED on real PostgreSQL 16.15 via the S9 smoke shape; the
// adapter battery proves it under concurrent load). The 48h stale sweep stays
// a separate opportunistic DELETE (storage hygiene, not part of the
// allow/block contract — same as the memory store).
//
// Window math: expired ⇔ window_start < now − windowSec (strict), identical
// to the memory store's `nowMs − windowStartMs > windowSec·1000` and the
// PGlite adapter's DELETE cutoff. Exactly-at-the-edge keeps the window.
import type { Pool } from "pg";
import { poolQuery, type QueryFn } from "../persistence/pg.js";
import type { RateLimitStore } from "@velora/domain";

/** PHP parity: stale storage bounded independently of any bucket policy. */
const STALE_AFTER_MS = 172800 * 1000; // 48 h

export class PgRateLimitStore implements RateLimitStore {
  private readonly q: QueryFn;

  constructor(pool: Pool) {
    this.q = poolQuery(pool);
  }

  async hit(
    bucket: string,
    policy: { readonly windowSec: number },
    nowMs: number,
  ): Promise<{ hits: number; windowStartMs: number }> {
    const now = new Date(nowMs);
    const windowStartCutoff = new Date(nowMs - policy.windowSec * 1000);
    const staleCutoff = new Date(nowMs - STALE_AFTER_MS);

    // Opportunistic 48h hygiene sweep (PHP parity; races are harmless — any
    // row it can remove is >48h stale, i.e. already expired for every policy).
    await this.q("DELETE FROM rate_limits WHERE window_start < $1", [staleCutoff]);

    // Atomic fixed-window upsert: reset when the bucket's own window expired,
    // increment (window anchored) otherwise. hits is BIGINT → string in pg.
    const rows = await this.q(
      `INSERT INTO rate_limits (bucket, hits, window_start) VALUES ($1, 1, $2)
       ON CONFLICT (bucket) DO UPDATE SET
         hits = CASE WHEN rate_limits.window_start < $3 THEN 1 ELSE rate_limits.hits + 1 END,
         window_start = CASE WHEN rate_limits.window_start < $3 THEN $2 ELSE rate_limits.window_start END
       RETURNING hits, window_start`,
      [bucket, now, windowStartCutoff],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("rate-limit upsert returned no row");
    const ws = row.window_start;
    return {
      hits: Number(row.hits),
      windowStartMs: (ws instanceof Date ? ws : new Date(String(ws))).getTime(),
    };
  }
}
