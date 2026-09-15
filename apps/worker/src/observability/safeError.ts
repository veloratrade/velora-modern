// safeError — secret-safe error classification for the worker (G-3 hardening).
//
// THE PROBLEM THIS SOLVES
//   The worker previously logged `err.message` verbatim. That is safe for an
//   internal `new Error("boom")`, but an integration error can embed the
//   request that produced it — including a broker password Velora forwarded to
//   a provider. A single unscrubbed message is enough to write a user's
//   credential into a durable log.
//
//   Verified before this module existed: an Error whose message contained
//   `investorPassword=...` was serialized into the worker's log line in full.
//
// THE RULE
//   Raw error text NEVER reaches a log sink, a DLQ reason, or any other durable
//   surface. What propagates is a CODE from a closed vocabulary, plus metadata
//   that is structurally incapable of holding a secret (an enum, a boolean, a
//   number).
//
//   This is an allow-list, not a redaction pass. Redaction requires guessing
//   every shape a secret can take — a losing game against provider payloads,
//   base64 blobs and URL-encoded bodies. Emitting only known-safe values cannot
//   leak something it never carries.
//
// WHAT IS DELIBERATELY NOT HERE
//   No regex scrubber, no "mask everything that looks like a token". Those
//   create false confidence: the first unmatched shape becomes a silent leak.

/**
 * Closed vocabulary of worker failure codes. Every value is a fixed literal
 * chosen by this module — never derived from provider or exception text.
 */
export const WORKER_ERROR_CODES = [
  "TIMEOUT", // handler exceeded the ADR-007 hard timeout
  "NO_HANDLER", // no handler registered for the job class
  "HANDLER_FAILED", // handler threw a non-classified error
  "MAX_ATTEMPTS", // bounded retries exhausted (queue policy)
  "PROVIDER_REJECTED", // third party returned a terminal 4xx
  "PROVIDER_UNAVAILABLE", // third party returned a retryable 5xx / transport failure
  "PROVIDER_MALFORMED", // third party response was not the documented shape
  "RESERVATION_HELD", // another worker already owns this account's sync lease
  "NOT_CONFIGURED", // required configuration (e.g. a platform token) is absent
  "UNKNOWN", // nothing more specific could be established
] as const;

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[number];

/**
 * An error that carries its own classification. Integration adapters should
 * throw this instead of a bare Error so the worker can report a precise code
 * without ever reading `message`.
 *
 * `message` still exists (it is an Error) and MAY contain detail for a local
 * stack trace, but the worker never logs it — only `code` is emitted.
 */
export class ClassifiedError extends Error {
  readonly code: WorkerErrorCode;

  constructor(code: WorkerErrorCode, message?: string) {
    // The message defaults to the code itself so that even an accidental
    // `String(err)` at some future call site yields nothing sensitive.
    super(message ?? code);
    this.name = "ClassifiedError";
    this.code = code;
  }
}

/** True when `value` is one of the known codes. Narrow, no coercion. */
export function isWorkerErrorCode(value: unknown): value is WorkerErrorCode {
  return typeof value === "string" && (WORKER_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Reduce ANY thrown value to a safe code.
 *
 * Note what this function never does: it never reads `message`, never
 * stringifies the error, and never inspects nested causes for text. An
 * unrecognized error becomes `UNKNOWN` — losing detail is the correct trade
 * when the alternative is leaking a credential.
 */
export function classifyError(err: unknown): WorkerErrorCode {
  if (err instanceof ClassifiedError) return err.code;
  // A structurally-tagged error (e.g. crossing a module boundary) is accepted
  // only when its tag is already a member of the closed vocabulary.
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (isWorkerErrorCode(code)) return code;
  }
  return "UNKNOWN";
}

/**
 * Build the log payload for a failed job.
 *
 * Every field is either a fixed literal, an enum member, or a number. There is
 * no field capable of carrying free text, so this object cannot leak a secret
 * by construction — the same "structurally impossible" discipline
 * `CredentialRecord` uses for credential metadata.
 */
export function safeFailureEvent(input: {
  readonly event: string;
  readonly jobClass: string;
  readonly jobId: string;
  readonly attempts: number;
  readonly code: WorkerErrorCode;
  readonly durationMs?: number;
}): Record<string, string | number> {
  const out: Record<string, string | number> = {
    level: "warn",
    event: input.event,
    jobClass: input.jobClass,
    id: input.jobId,
    attempts: input.attempts,
    errorCode: input.code,
  };
  if (input.durationMs !== undefined) out["durationMs"] = input.durationMs;
  return out;
}

/**
 * Dead-letter reasons are persisted by the queue, so they obey the same rule as
 * logs: a bounded, fixed string built only from a code and the job class.
 *
 * ADR-007 already requires "DLQ contents are redacted"; this makes that
 * mechanical rather than a reviewer's responsibility.
 */
export function safeDlqReason(code: WorkerErrorCode, jobClass: string): string {
  // jobClass is a registered, developer-authored identifier, never user or
  // provider input — but it is still length-bounded here so a pathological
  // value cannot bloat a durable row.
  const cls = jobClass.slice(0, 64);
  return `${code}:${cls}`;
}
