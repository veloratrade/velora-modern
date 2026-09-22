// Worker handler registry (B10-c).
//
// The worker previously held `const handlers = new Map()` — an empty map with
// no registration mechanism and no way to state which job classes exist. This
// makes registration EXPLICIT and gives the pg-boss adapter the queue-name list
// it now requires (v10 has no wildcard fetch).
//
// DESIGN CONSTRAINTS (from the brief, each enforced here):
//   - explicit                → register() is the only way in; no auto-discovery
//   - reject unknown classes  → resolve() returns undefined; the runner then
//                               emits NO_HANDLER:<jobClass>, unchanged
//   - no dynamic code exec    → no eval, no import(), no string→function
//   - typed payloads          → handlers declare a SafeJobPayload shape
//   - secrets structurally
//     discouraged in payloads → SafeJobPayload permits only flat scalars
import type { JobDescriptor, SafeJobPayload } from "@velora/contracts";
import type { QueuedJob } from "../queue/QueuePort.js";

/**
 * A handler for one job class.
 *
 * The payload type is constrained to `SafeJobPayload` (flat scalars), so a
 * handler cannot declare a nested/credential-shaped payload without stepping
 * outside the registry's types — the compile-time half of "no secrets in
 * payloads" (ADR-007 §Security Impact).
 */
export type TypedJobHandler<P extends SafeJobPayload = SafeJobPayload> = (
  job: QueuedJob<P>,
) => Promise<void>;

/** Runtime-erased handler, as the runner consumes it. */
type ErasedHandler = (job: QueuedJob) => Promise<void>;

export class DuplicateJobClassError extends Error {
  constructor(jobClass: string) {
    super(`job class already registered: ${jobClass.slice(0, 64)}`);
    this.name = "DuplicateJobClassError";
  }
}

/**
 * Explicit registry of job classes this worker can execute.
 *
 * Deliberately NOT a plain Map: registration is guarded (duplicates throw
 * rather than silently replacing a handler), and the registry owns the
 * authoritative queue-name list the pg-boss adapter needs.
 */
export class HandlerRegistry {
  readonly #handlers = new Map<string, ErasedHandler>();

  /**
   * Register the handler for a job class.
   *
   * Duplicate registration throws: silently overwriting a handler would mean
   * the last import wins, which is an invisible and order-dependent bug.
   */
  register<P extends SafeJobPayload>(jobClass: string, handler: TypedJobHandler<P>): this {
    if (jobClass.trim() === "") throw new Error("job class must not be empty");
    if (this.#handlers.has(jobClass)) throw new DuplicateJobClassError(jobClass);
    this.#handlers.set(jobClass, handler as ErasedHandler);
    return this;
  }

  /** Resolve a handler, or undefined for an unknown class (→ NO_HANDLER). */
  resolve(jobClass: string): ErasedHandler | undefined {
    return this.#handlers.get(jobClass);
  }

  has(jobClass: string): boolean {
    return this.#handlers.has(jobClass);
  }

  /** Registered job classes — the queue names the adapter must create/poll. */
  jobClasses(): readonly string[] {
    return [...this.#handlers.keys()].sort();
  }

  get size(): number {
    return this.#handlers.size;
  }

  /**
   * The runner consumes a Map. Returning a COPY keeps the registry the single
   * source of truth: mutating the returned map cannot register a handler.
   */
  toHandlerMap(): Map<string, ErasedHandler> {
    return new Map(this.#handlers);
  }
}

/**
 * Build the worker's registry.
 *
 * STILL EMPTY BY DEFAULT, deliberately. The registry is a pure structure with
 * no knowledge of any concrete job class, so constructing one never implies a
 * dependency (a database pool, a platform token) that the caller may not have.
 * The composition root — `apps/worker/src/index.ts` — is the single place that
 * decides which classes this process serves, and it registers MetaAPI sync
 * there once its dependencies resolve.
 *
 * Keeping the default empty also preserves the fail-loud contract: a process
 * that reaches the runner with nothing registered still exits non-zero rather
 * than idling while looking healthy.
 */
export function createHandlerRegistry(): HandlerRegistry {
  return new HandlerRegistry();
}

/** Descriptor helper keeping payloads inside the safe-shape constraint. */
export type TypedDescriptor<P extends SafeJobPayload> = JobDescriptor<P>;
