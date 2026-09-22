// In-memory OwnershipStore (tests and local development).
//
// Mirrors the database singleton exactly: the second claim throws, so the
// one-time invariant is provable without PostgreSQL. Node runs this on a single
// thread, and claimOwnership performs its check-and-set with no interleaved
// await, so the write is atomic here in the same way the DB constraint is
// atomic there.
import {
  type OwnershipRecord,
  type OwnershipStore,
  OwnershipAlreadyClaimedError,
} from "./ownershipStore.js";
import type { AuditWrite } from "./auditStore.js";

export class MemoryOwnershipStore implements OwnershipStore {
  private record: OwnershipRecord | null = null;

  async getOwnership(): Promise<OwnershipRecord | null> {
    return this.record;
  }

  async claimOwnership(
    input: {
      ownerUserId: string;
      claimedByUserId: string;
      claimedIp: string | null;
      claimedUserAgent: string | null;
      now: Date;
    },
    audit?: AuditWrite,
  ): Promise<OwnershipRecord> {
    // Check-and-set with no await between them: equivalent to the DB's
    // single-row PRIMARY KEY, so a concurrent second claim cannot slip through.
    if (this.record !== null) throw new OwnershipAlreadyClaimedError();
    // C-34 atomicity, in-memory equivalent: the audit write happens BEFORE the
    // singleton is set, so a failing audit leaves ownership unclaimed — the
    // same observable outcome as the PG adapter's ROLLBACK.
    if (audit !== undefined) await audit(undefined);
    this.record = {
      ownerUserId: input.ownerUserId,
      claimedByUserId: input.claimedByUserId,
      claimedAt: input.now.toISOString(),
      claimedIp: input.claimedIp,
      claimedUserAgent: input.claimedUserAgent,
    };
    return this.record;
  }
}
