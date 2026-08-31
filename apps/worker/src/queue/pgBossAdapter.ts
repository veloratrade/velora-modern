// pg-boss adapter — production queue implementation target (ADR-007/D-13).
//
// STATUS: implemented but NOT integration-tested in this environment:
// there is no PostgreSQL server available in the dev sandbox (Docker absent),
// so live pg-boss verification is deferred to the dev/staging environment
// (documented in ADR-011; worker semantics are covered deterministically via
// MemoryQueue + runner tests). pg-boss major version must stay PINNED.
import type { JobDescriptor } from "@velora/contracts";
import type { QueuePort, QueuedJob } from "./QueuePort.js";

/**
 * Minimal structural interface for the pinned pg-boss major. The adapter binds
 * to the live instance only when a real PostgreSQL exists (dev/staging bring-up);
 * exact option-shape verification is part of that first live run (ADR-011 §2).
 */
interface PgBossMinimal {
  start(): Promise<void>;
  send(args: { name: string; data: unknown; options: { singletonKey: string; priority: number } }): Promise<string | null>;
  fetch(opts: { queues: string[]; limit: number }): Promise<Array<{ id: string; data: unknown }> | null>;
  complete(id: string): Promise<unknown>;
  fail(id: string, options?: { data?: unknown }): Promise<unknown>;
  getJobCounts(): Promise<Record<string, number>>;
}

export async function createPgBossQueue(connectionString: string): Promise<QueuePort> {
  const { default: PgBoss } = await import("pg-boss");
  const boss = new PgBoss({ connectionString, max: 10 }) as unknown as PgBossMinimal;
  await boss.start();
  return {
    async enqueue<P>(descriptor: JobDescriptor<P>): Promise<string> {
      // pg-boss deduplicates by singletonKey; a null id means the singleton
      // already existed (duplicate suppressed) → return a stable derived id.
      const id = await boss.send({
        name: descriptor.jobClass,
        data: descriptor as never,
        options: { singletonKey: descriptor.idempotencyKey, priority: 1 },
      });
      return id ?? `dup:${descriptor.idempotencyKey}`;
    },
    async claim(): Promise<QueuedJob | null> {
      const jobs = await boss.fetch({ queues: ["*"], limit: 1 });
      const j = jobs?.[0];
      if (!j) return null;
      const d = j.data as unknown as JobDescriptor;
      return { id: j.id, descriptor: d, attempts: 0 };
    },
    async complete(id: string) { await boss.complete(id); },
    async fail(id: string) { await boss.fail(id); },
    async deadLetter(id: string, reason: string) { await boss.fail(id, { data: { dlq: true, reason } }); },
    async size() { const s = await boss.getJobCounts(); return s.queued ?? 0; },
    async dlqSize() { const s = await boss.getJobCounts(); return s.failed ?? 0; },
    async dlqEntries() { return []; }, // pg-boss maintains its own failed-state listing
  };
}
