// Error taxonomy — externally contractual error semantics only (ADR-006 tier).
export const ERROR_CODES = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT", // optimistic-concurrency / duplicate
  ORIGIN_REJECTED: "ORIGIN_REJECTED", // same-origin guard (verified behavior, 403)
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS", // inc 7 evidence correction: both lineages emit TOO_MANY_REQUESTS (PHP Response + Remote ApiError); the earlier RATE_LIMITED placeholder appeared in neither
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
