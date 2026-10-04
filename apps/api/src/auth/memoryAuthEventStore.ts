// In-memory AuthEventStore (tests and local development).
//
// Mirrors the database contract: append-only, newest-first reads with the same
// deterministic tiebreak (occurred_at DESC, id DESC), the same pagination clamp
// and the same fail-open write policy as the PG adapter — so a test that passes
// against this adapter is testing the CONTRACT, and the PG battery exists to
// prove the adapter honours it against a real database.
//
// Records are frozen and returned as copies: a caller cannot reach back into
// stored history and edit it, which is the in-memory equivalent of the REVOKE
// UPDATE/DELETE grid in db/roles.sql.
import {
  clampPagination,
  normalizeAuthEvent,
  type AuthEventInput,
  type AuthEventPage,
  type AuthEventRecord,
  type AuthEventResult,
  type AuthEventStore,
} from "./authEventStore.js";

export class MemoryAuthEventStore implements AuthEventStore {
  private readonly records: AuthEventRecord[] = [];
  private seq = 0;
  private writeError: unknown = null;
  /** Test seam: makes the NEXT write fail, to exercise the fail-open policy. */
  private failNextWrite = false;

  async record(input: AuthEventInput): Promise<void> {
    const e = normalizeAuthEvent(input);
    try {
      if (this.failNextWrite) {
        this.failNextWrite = false;
        throw new Error("injected auth-event write failure");
      }
      this.seq += 1;
      this.records.push(
        Object.freeze({
          id: String(this.seq),
          occurredAt: (input.occurredAt ?? new Date()).toISOString(),
          userId: e.userId,
          eventType: e.eventType,
          result: e.result,
          reason: e.reason,
          ipAddress: e.ipAddress,
          userAgent: e.userAgent,
        }),
      );
    } catch (err) {
      // Same fail-open contract as the PG adapter.
      this.writeError = err;
    }
  }

  async listForUser(
    userId: string,
    opts?: { readonly page?: number; readonly perPage?: number; readonly result?: AuthEventResult },
  ): Promise<AuthEventPage> {
    const { page, perPage } = clampPagination(opts);
    // ORDER BY occurred_at DESC, id DESC — and ids are zero-padded so the
    // string comparison matches the numeric one.
    const ordered = [...this.records]
      .filter((r) => r.userId === userId && (opts?.result === undefined || r.result === opts.result))
      .sort((a, b) => {
        if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
        return Number(b.id) - Number(a.id);
      });
    const start = (page - 1) * perPage;
    return { events: ordered.slice(start, start + perPage), total: ordered.length, page, perPage };
  }

  lastWriteError(): unknown {
    return this.writeError;
  }

  /** Test seam — not part of the port. */
  failWrites(once = true): void {
    this.failNextWrite = once;
  }
}
