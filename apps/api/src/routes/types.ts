// Extended route layer — shared types (backend migration, pass 1).
//
// WHY THIS LAYER EXISTS. The kernel (`apps/api/src/kernel/server.ts`) is the
// frozen Phase C delivery shell: 42 routes, each written inline, following
// ADR-010 ("apps are thin shells; domain/contracts own the logic"). The backend
// migration adds a second, much larger capability generation — webhook ingress,
// analytics, tags, attachments, billing, AI coach, portfolio, EA ingestion,
// tenancy and the developer API. Growing one file without bound would make
// every future review read the whole surface, so migrated capabilities declare
// their routes here and the kernel delegates to ONE dispatcher placed
// immediately before its terminal 404.
//
// The context is deliberately narrow. Identity comes from the kernel (a single
// bearer verification implementation — this layer never re-derives it), and the
// body readers are kernel-owned so the 1 MiB cap and the JSON-object rule stay
// identical to the Phase C surface.
import type { IncomingMessage } from "node:http";
import type { AppRole } from "@velora/contracts";
import type { ApiConfig } from "../kernel/server.js";

/** Identical shape to the kernel's own `RouteResult`. */
export type RouteResult = { status: number; body: unknown; headers?: Record<string, string> };

/** Verified bearer claims (signature-checked; never client-supplied). */
export interface RouteClaims {
  readonly sub: string;
  readonly role: AppRole;
}

/**
 * Everything a migrated route handler may need.
 *
 * `isSystemOwner` is provided by the kernel because ownership storage is the
 * authoritative source of the System Owner identity; a handler must never
 * re-read it from a request field.
 */
export interface ExtendedRouteContext {
  readonly req: IncomingMessage;
  readonly method: string;
  readonly path: string;
  readonly url: URL;
  readonly config: ApiConfig;
  readonly requestId: string;
  /** Bearer access-token verification (kernel-owned, fail-closed). */
  readonly authenticate: (req: IncomingMessage) => RouteClaims | null;
  /** Parsed JSON object body (kernel-owned; 1 MiB cap; `{}` when absent). */
  readonly readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  /**
   * Raw request bytes. HMAC verification is over BYTES, not over a re-encoded
   * parse of them, so a migrated ingress route must use this reader and must
   * read the stream exactly once.
   */
  readonly readRawBody: (req: IncomingMessage, maxBytes?: number) => Promise<Buffer>;
  /** True when the given user id is the installation's System Owner. */
  readonly isSystemOwner: (userId: string) => Promise<boolean>;
}

/** A handler returns `null` when it does not own the (method, path) pair. */
export type ExtendedRouteHandler = (ctx: ExtendedRouteContext) => Promise<RouteResult | null>;
