// CredentialService — the B-1 application layer over the C-22 credential store.
//
// WHY THIS EXISTS
//   The encrypted store (C-22) shipped with no production caller: nothing could
//   create, list or delete a credential. This service is that caller. It is
//   deliberately thin — it owns authorization and validation, and delegates all
//   cryptography and persistence to the existing CredentialStore.
//
// THE OWNERSHIP INVARIANT (the reason this file is shaped this way)
//   Every method takes the AUTHENTICATED actor and derives the owner from it.
//   There is no `userId` parameter a caller could point at someone else, and no
//   overload that accepts an owner id. `actorUserId === targetUserId` always,
//   structurally — not by a policy check that a future call site might forget.
//
//   That is what keeps ADR-016's rule true at the application layer:
//   "Application authority does not imply secret disclosure authority."
//   An admin, super_admin or System Owner calling these methods acts as
//   THEMSELVES and reaches only their own rows, because the only id in play is
//   the one the authenticator produced.
//
// NO REVEAL (B-1 scope)
//   This service deliberately exposes NO reveal/decrypt operation. The store's
//   reveal() is untouched and remains unreachable from HTTP. There is no
//   production consumer for secret disclosure yet (MetaAPI/C-27 does not
//   exist), and an unused disclosure path is pure risk. Reveal semantics —
//   including whether it must fail closed when its audit row cannot be
//   written — are deferred to a later gate with its own decision.
//
// NO AUDIT YET (B-3 scope)
//   B-1 intentionally writes no audit events: the audit schema cannot yet
//   represent them (migration 0009 constrains audit_log.action, and there are
//   no credential_id/provider columns). The store's create()/delete() keep
//   their existing optional `tx` parameter, so B-3 can later run the mutation
//   and the audit append inside ONE transaction without reshaping this service.
//
// SECRET HANDLING
//   The plaintext secret exists only as an argument passed straight into the
//   store, which encrypts before touching the database. It is never logged,
//   never returned, and never placed on an error. Every value this service
//   returns is CredentialRecord — a metadata-only type that by construction has
//   no field capable of holding a secret, ciphertext, IV or auth tag.

import {
  CredentialAlreadyExistsError,
  type CredentialProvider,
  type CredentialRecord,
  type CredentialStore,
} from "./credentialStore.js";

/**
 * Domain error carrying the HTTP shape, mirroring AccountError so the route
 * layer maps credentials exactly like every other owner-scoped resource.
 */
export class CredentialError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

/**
 * The authenticated caller. `id` is the server-derived authenticated identity
 * (authority.sub) — NEVER a value read from a request body, query string or
 * route parameter.
 *
 * `requestId` is the per-request correlation id from kernel/security.ts. It is
 * metadata only: it never affects authorization. It is accepted now so that
 * B-3 can record it on audit entries without changing this signature.
 */
export interface CredentialActor {
  readonly id: string;
  readonly requestId?: string;
}

/** Providers accepted by this phase. Mirrors the 0010 CHECK and the port type. */
const SUPPORTED_PROVIDERS: readonly string[] = ["METAAPI"];

/**
 * Upper bound on an accepted secret. Not a security control — the store
 * encrypts whatever it is given — but a request-hygiene limit that stops an
 * unbounded body from becoming a giant ciphertext row.
 */
const MAX_SECRET_LENGTH = 4096;

export interface CredentialServiceDeps {
  readonly store: CredentialStore;
  /** Injectable clock; defaults to real time. Keeps tests deterministic. */
  readonly now?: () => Date;
}

export class CredentialService {
  private readonly now: () => Date;

  constructor(private readonly deps: CredentialServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Store a new credential for the AUTHENTICATED user.
   *
   * The owner is `actor.id`. The request body supplies only `provider` and
   * `secret`; a `userId` in the body is ignored entirely — it is never read, so
   * it cannot influence ownership.
   */
  async createCredential(actor: CredentialActor, input: unknown): Promise<CredentialRecord> {
    const body = isRecord(input) ? input : {};

    const provider = body.provider;
    if (typeof provider !== "string" || !SUPPORTED_PROVIDERS.includes(provider)) {
      throw new CredentialError(400, "VALIDATION_FAILED", "Invalid provider.", {
        provider: "INVALID_PROVIDER",
      });
    }

    const secret = body.secret;
    if (typeof secret !== "string" || secret.trim() === "") {
      // The message names the FIELD, never the value: an error must not echo a
      // secret back to the client or into a log.
      throw new CredentialError(400, "VALIDATION_FAILED", "Invalid secret.", {
        secret: "REQUIRED",
      });
    }
    if (secret.length > MAX_SECRET_LENGTH) {
      throw new CredentialError(400, "VALIDATION_FAILED", "Invalid secret.", {
        secret: "TOO_LONG",
      });
    }

    try {
      return await this.deps.store.create({
        userId: actor.id, // authenticated identity — never client-supplied
        provider: provider as CredentialProvider,
        secret,
        now: this.now(),
      });
    } catch (err) {
      if (err instanceof CredentialAlreadyExistsError) {
        // 409 mirrors the store's (user, provider) uniqueness rule: replacing a
        // credential is an explicit delete-then-create, never a silent
        // overwrite of a secret the user cannot see.
        throw new CredentialError(409, "CREDENTIAL_EXISTS", err.message, {
          provider: "ALREADY_EXISTS",
        });
      }
      throw err;
    }
  }

  /**
   * Metadata for every credential owned by the authenticated user.
   * CredentialRecord carries no secret material, so this response is safe to
   * serialize by construction rather than by filtering.
   */
  async listCredentials(actor: CredentialActor): Promise<readonly CredentialRecord[]> {
    return this.deps.store.list(actor.id);
  }

  /**
   * Delete (revoke) a credential owned by the authenticated user.
   *
   * A credential belonging to someone else is reported as NOT_FOUND — the same
   * response as a genuinely absent id. The two are deliberately
   * indistinguishable, matching the non-disclosing 404 posture used by accounts
   * and trades, so this endpoint cannot be used to probe whether another user
   * holds a credential.
   */
  async deleteCredential(actor: CredentialActor, id: string): Promise<{ deleted: true }> {
    const removed = await this.deps.store.delete(id, actor.id);
    if (!removed) throw new CredentialError(404, "NOT_FOUND", "Credential not found.");
    return { deleted: true };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
