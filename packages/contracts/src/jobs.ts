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

/**
 * Payload safety (G-3).
 *
 * ADR-007 §Security Impact already requires that "payloads must not contain
 * secrets". That is a rule a reviewer must remember; `SafeJobPayload` makes it
 * something the compiler can check.
 *
 * A payload may only be a flat record of identifiers and non-secret scalars.
 * Nested objects are excluded deliberately: nesting is how a credential, a
 * provider response body or a serialized error would realistically arrive
 * inside a payload.
 *
 * This is a CONSTRAINT, not a guarantee: a `string` field can still be misused
 * by a determined caller. It raises the cost of the mistake and documents the
 * intent at the type level — it does not replace review. Queue payloads are
 * persisted by pg-boss and survive into retries and the DLQ, so the rule is
 * load-bearing.
 */
export type SafeJobScalar = string | number | boolean | null;
export type SafeJobPayload = Readonly<Record<string, SafeJobScalar>>;

/**
 * A descriptor whose payload is constrained to identifier-shaped data. New job
 * classes SHOULD use this instead of the unconstrained `JobDescriptor`.
 */
export type SafeJobDescriptor<P extends SafeJobPayload = SafeJobPayload> = JobDescriptor<P>;

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
