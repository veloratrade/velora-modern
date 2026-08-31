// Job semantics contract — ADR-007 (Accepted, D-13).
export type JobPriorityClass =
  | "webhook-projection" // highest
  | "sync"
  | "ai"
  | "reports"
  | "maintenance"; // lowest

export const PRIORITY_ORDER: readonly JobPriorityClass[] = [
  "webhook-projection",
  "sync",
  "ai",
  "reports",
  "maintenance",
];

/** Standard job descriptor — every job class MUST carry these (ADR-007). */
export interface JobDescriptor<P = unknown> {
  jobClass: string; // e.g. "metaapi.sync-account"
  priorityClass: JobPriorityClass;
  /** Business idempotency key, e.g. "sync:{accountId}:{cursor}" (ADR-007). */
  idempotencyKey: string;
  payload: P;
  /** Hard timeout per class; lease must exceed worst-case runtime. */
  timeoutMs: number;
  leaseMs: number;
  maxAttempts: number;
  /** Exponential backoff base with full jitter (see domain/jobSemantics). */
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_JOB_POLICIES: Record<JobPriorityClass, Pick<JobDescriptor, "timeoutMs" | "leaseMs" | "maxAttempts" | "backoffBaseMs" | "backoffMaxMs">> = {
  "webhook-projection": { timeoutMs: 15_000, leaseMs: 60_000, maxAttempts: 5, backoffBaseMs: 500, backoffMaxMs: 60_000 },
  sync: { timeoutMs: 120_000, leaseMs: 300_000, maxAttempts: 5, backoffBaseMs: 1_000, backoffMaxMs: 300_000 },
  ai: { timeoutMs: 60_000, leaseMs: 120_000, maxAttempts: 3, backoffBaseMs: 2_000, backoffMaxMs: 300_000 },
  reports: { timeoutMs: 300_000, leaseMs: 600_000, maxAttempts: 3, backoffBaseMs: 5_000, backoffMaxMs: 600_000 },
  maintenance: { timeoutMs: 120_000, leaseMs: 300_000, maxAttempts: 3, backoffBaseMs: 10_000, backoffMaxMs: 600_000 },
};

// Redis introduction triggers (ADR-007 §Decision) — documented boundary only;
// Redis is NOT part of the Phase 1 foundation.
export const REDIS_INTRODUCTION_TRIGGERS = [
  "multi-node deployment requiring shared rate-limit/cache state",
  "sustained queue throughput around 500-1000 jobs/sec",
  "measured cache requirement not fitting per-node memory",
  "genuine pub/sub fanout requirement",
] as const;
