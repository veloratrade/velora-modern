// QueuePort — the single queue abstraction (ADR-007/D-13). pg-boss is the
// production implementation target; the in-memory implementation exists for
// deterministic worker-semantics tests. Redis remains OUT until an ADR-007
// trigger fires (multi-node shared state / 500-1000 jobs-sustained / measured
// cache / pub-sub) — swapping the implementation must not touch the runner.
import type { JobDescriptor } from "@velora/contracts";

export interface QueuedJob<P = unknown> {
  id: string;
  descriptor: JobDescriptor<P>;
  attempts: number; // failed attempts so far
}

export interface QueuePort {
  /** Deduplicates by descriptor.idempotencyKey — returns the existing id. */
  enqueue<P>(descriptor: JobDescriptor<P>): Promise<string>;
  /** Claim the next runnable job (respecting backoff schedule + expired leases). */
  claim(): Promise<QueuedJob | null>;
  complete(id: string): Promise<void>;
  fail(id: string): Promise<void>; // records attempt; schedules per policy or DLQs
  deadLetter(id: string, reason: string): Promise<void>;
  size(): Promise<number>;
  dlqSize(): Promise<number>;
  dlqEntries(): Promise<Array<{ id: string; reason: string }>>;
}
