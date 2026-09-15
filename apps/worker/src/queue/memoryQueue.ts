// Deterministic in-memory QueuePort implementation — test/DEV ONLY.
// Implements the same semantics the pg-boss adapter targets: idempotency-key
// dedupe, backoff scheduling, lease expiry reclaim, DLQ after max attempts.
import type { JobDescriptor } from "@velora/contracts";
import { computeBackoffMs, shouldDeadLetter } from "@velora/domain";
import type { QueuePort, QueuedJob } from "./QueuePort.js";

export interface TestClock {
  nowMs(): number;
}

interface Entry {
  id: string;
  descriptor: JobDescriptor;
  attempts: number;
  state: "queued" | "active" | "done" | "dlq";
  availableAtMs: number;
  leaseDeadlineMs: number;
  dlqReason?: string;
}

export class MemoryQueue implements QueuePort {
  private entries: Entry[] = [];
  private seq = 0;
  constructor(private readonly clock: TestClock, private readonly rng: () => number = Math.random) {}

  async enqueue<P>(descriptor: JobDescriptor<P>): Promise<string> {
    const existing = this.entries.find((e) => e.descriptor.idempotencyKey === descriptor.idempotencyKey);
    if (existing) return existing.id; // duplicate delivery converges
    const id = `j${++this.seq}`;
    this.entries.push({ id, descriptor: descriptor as JobDescriptor, attempts: 0, state: "queued", availableAtMs: this.clock.nowMs(), leaseDeadlineMs: 0 });
    return id;
  }

  async claim(): Promise<QueuedJob | null> {
    const now = this.clock.nowMs();
    const entry = this.entries
      .filter((e) => e.state === "queued" && e.availableAtMs <= now)
      .sort((a, b) => a.descriptor.idempotencyKey.localeCompare(b.descriptor.idempotencyKey))[0];
    if (!entry) return null;
    entry.state = "active";
    entry.leaseDeadlineMs = now + entry.descriptor.leaseMs;
    return { id: entry.id, descriptor: entry.descriptor, attempts: entry.attempts };
  }

  async complete(id: string): Promise<void> {
    const e = this.get(id);
    e.state = "done";
  }

  async fail(id: string): Promise<void> {
    const e = this.get(id);
    e.attempts += 1;
    if (shouldDeadLetter(e.attempts, e.descriptor)) {
      e.state = "dlq";
      e.dlqReason = `max attempts (${e.attempts}) reached`;
    } else {
      e.state = "queued";
      e.availableAtMs = this.clock.nowMs() + computeBackoffMs(e.attempts, e.descriptor, this.rng);
    }
  }

  /** Simulates worker death: an active job whose lease expired becomes claimable. */
  async reclaimExpired(): Promise<number> {
    const now = this.clock.nowMs();
    let n = 0;
    for (const e of this.entries) {
      if (e.state === "active" && now >= e.leaseDeadlineMs) {
        e.state = "queued";
        e.availableAtMs = now;
        n++;
      }
    }
    return n;
  }

  async deadLetter(id: string, reason: string): Promise<void> {
    const e = this.get(id);
    e.state = "dlq";
    e.dlqReason = reason;
  }

  /**
   * Recorded, not executed. The in-memory queue has no clock by design — its
   * purpose is deterministic semantics tests, and a real timer would make them
   * time-dependent. Tests drive `runSyncTick` directly and assert on this map.
   */
  readonly schedules = new Map<string, string>();
  async schedule(jobClass: string, cron: string): Promise<void> {
    this.schedules.set(jobClass, cron);
  }

  async size(): Promise<number> {
    return this.entries.filter((e) => e.state === "queued" || e.state === "active").length;
  }
  async dlqSize(): Promise<number> {
    return this.entries.filter((e) => e.state === "dlq").length;
  }
  async dlqEntries(): Promise<Array<{ id: string; reason: string }>> {
    return this.entries.filter((e) => e.state === "dlq").map((e) => ({ id: e.id, reason: e.dlqReason ?? "" }));
  }
  attemptsOf(id: string): number {
    return this.get(id).attempts;
  }
  private get(id: string): Entry {
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new Error(`no job ${id}`);
    return e;
  }
}
