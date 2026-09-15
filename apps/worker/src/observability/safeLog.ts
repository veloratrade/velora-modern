// safeLog — the worker's log-sink allow-list (G-3 hardening, defence in depth).
//
// The runner already emits only safe values (see safeError.ts). This module is
// the second barrier: it filters at the SINK, so a future call site that passes
// an unexpected field cannot serialize it into a durable log line.
//
// WHY AN ALLOW-LIST AND NOT A REDACTOR
//   A redactor must recognise every shape a secret can take — provider JSON,
//   base64, URL-encoded bodies, nested causes. The first unmatched shape is a
//   silent leak, and the failure mode is invisible. An allow-list inverts that:
//   an unanticipated field is DROPPED, so the worst case is a missing
//   diagnostic rather than a disclosed credential.
//
// Adding a field here is a deliberate act that should be reviewed as such.

/** Fields the worker is permitted to emit. Every one is non-secret by nature. */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "level", // fixed severity literal
  "event", // fixed event name
  "service", // fixed service name
  "jobClass", // developer-authored job identifier
  "id", // queue-generated job id
  "idempotencyKey", // derived from non-secret identifiers (ADR-007 shape)
  "attempts", // number
  "durationMs", // number
  "errorCode", // member of the closed WorkerErrorCode vocabulary
  "count", // number
]);

/**
 * Maximum length for any permitted string value. Bounds a pathological value
 * (e.g. an over-long jobClass) without attempting to interpret content.
 */
const MAX_VALUE_CHARS = 200;

/**
 * Project an arbitrary log event onto the allow-list.
 *
 * Values are additionally restricted by TYPE: only strings, finite numbers and
 * booleans survive. An object or array is dropped even under an allowed key,
 * because a nested structure is exactly how an error payload or provider
 * response body would smuggle text into a log line.
 */
export function safeLogFields(event: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (typeof value === "string") {
      out[key] = value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
    // Everything else (object, array, function, symbol, bigint, null,
    // undefined) is intentionally dropped.
  }
  return out;
}

/** Read-only view of the allow-list, for tests and review. */
export function allowedLogFields(): readonly string[] {
  return [...ALLOWED_FIELDS];
}
