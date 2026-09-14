// PgOwnershipStore — the real-PostgreSQL OwnershipStore adapter.
//
// The one-time guarantee is enforced by the DATABASE (installation_ownership
// has a single-row PRIMARY KEY pinned to TRUE), not by a prior read. A racing
// second INSERT raises SQLSTATE 23505, which is mapped to
// OwnershipAlreadyClaimedError here. That is why no read-then-write sequence
// and no transaction wrapper is required for correctness.
//
// EVIDENCE: the singleton behaviour is exercised in db/tests/migrations.test.ts
// against PGlite (in-wasm). NOT verified against a real PostgreSQL server.
import type { Pool } from "pg";
import { poolQuery, iso, isUniqueViolation, type QueryFn } from "../persistence/pg.js";
import {
  type OwnershipRecord,
  type OwnershipStore,
  OwnershipAlreadyClaimedError,
} from "./ownershipStore.js";

interface OwnershipRow {
  owner_user_id: string | number;
  claimed_by_user_id: string | number;
  claimed_at: Date | string;
  claimed_ip: string | null;
  claimed_user_agent: string | null;
}

function mapOwnership(r: OwnershipRow): OwnershipRecord {
  return {
    ownerUserId: String(r.owner_user_id),
    claimedByUserId: String(r.claimed_by_user_id),
    claimedAt: iso(r.claimed_at),
    claimedIp: r.claimed_ip,
    claimedUserAgent: r.claimed_user_agent,
  };
}

export class PgOwnershipStore implements OwnershipStore {
  private readonly q: QueryFn;

  constructor(pool: Pool) {
    this.q = poolQuery(pool);
  }

  async getOwnership(): Promise<OwnershipRecord | null> {
    const rows = await this.q("SELECT * FROM installation_ownership WHERE id = TRUE", []);
    return rows.length === 0 ? null : mapOwnership(rows[0] as unknown as OwnershipRow);
  }

  async claimOwnership(input: {
    ownerUserId: string;
    claimedByUserId: string;
    claimedIp: string | null;
    claimedUserAgent: string | null;
    now: Date;
  }): Promise<OwnershipRecord> {
    try {
      const rows = await this.q(
        `INSERT INTO installation_ownership
           (id, owner_user_id, claimed_by_user_id, claimed_at, claimed_ip, claimed_user_agent)
         VALUES (TRUE, $1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.ownerUserId,
          input.claimedByUserId,
          input.now,
          input.claimedIp,
          input.claimedUserAgent,
        ],
      );
      return mapOwnership(rows[0] as unknown as OwnershipRow);
    } catch (err: unknown) {
      // The singleton PK rejects the second claim — including a concurrent one.
      if (isUniqueViolation(err)) throw new OwnershipAlreadyClaimedError();
      throw err;
    }
  }
}
