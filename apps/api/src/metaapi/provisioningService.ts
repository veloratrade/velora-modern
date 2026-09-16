// MetaApiProvisioningService — OD-MP-1 / OD-MP-2 / OD-MP-3.
//
// THIS FILE IS THE ONLY PRODUCTION CONSUMER OF CredentialStore.reveal().
// That is a deliberate, reviewable choke point, and it is the whole scope of
// the authorization: OD-MP-1 rule 5 permits credential consumption "only
// inside the future provisioning application service".
//
// OWNERSHIP IS THE ONLY AUTHORIZATION RULE (OD-MP-1 rules 1-4, 10-12).
//   Every method takes an ACTOR whose id is the authenticated `claims.sub`,
//   and every store call is scoped by it. No method accepts a user id from a
//   caller, there is no admin or System Owner branch anywhere in this file,
//   and `reveal(id, userId)` is called with the actor's own id — so an
//   administrator cannot reach another user's secret even by calling this
//   service directly.
//
// PLAINTEXT LIFETIME (OD-MP-1 rule 6).
//   The decrypted secret exists in ONE local const inside `connect`, is passed
//   straight into the provider request body, and is never: persisted, logged,
//   put on an error, written to an audit row, placed on a queue, or returned.
//   The audit row records THAT a credential was used, never the value.
//
// THE PROVIDER CALL NEVER RUNS INSIDE A DATABASE TRANSACTION (OD-MP-1 /
// governance §9): a short transaction reserves the operation, it commits, the
// HTTP call happens with no transaction open, and a second short transaction
// records the outcome.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccountStore, AccountRecord } from "../accounts/accountStore.js";
import { AccountBindingConflictError } from "../accounts/accountStore.js";
import type { CredentialStore } from "../credentials/credentialStore.js";
import type { AuditStore } from "../auth/auditStore.js";
import type { ProvisioningStore } from "./provisioningStore.js";
import {
  createMetaApiAccount,
  deleteMetaApiAccount,
  findAccountByMarker,
  newTransactionId,
  ProvisioningError,
  type ProvisioningClientOptions,
} from "./provisioningClient.js";

/** Authenticated actor. `id` is ALWAYS claims.sub — never client input. */
export interface ProvisioningActor {
  readonly id: string;
  readonly requestId?: string | undefined;
}

/**
 * Application error with an HTTP status and a stable code.
 *
 * Mirrors AccountError/CredentialError so the kernel maps it with the existing
 * convention. Messages are fixed strings: a provider message or response body
 * is NEVER placed here, because it can echo submitted values back to a client
 * or into a log.
 */
export class ProvisioningServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "ProvisioningServiceError";
  }
}

export interface ProvisioningDeps {
  readonly accounts: AccountStore;
  readonly credentials: CredentialStore;
  readonly operations: ProvisioningStore;
  readonly audit: AuditStore;
  /** Platform token supplier. Returns null when MetaAPI is not configured. */
  readonly platformToken: () => string | null;
  readonly clientOptions?: ProvisioningClientOptions | undefined;
  readonly now?: (() => Date) | undefined;
  /** Bounded 202 polling budget (OD-MP-1 / Phase 4). */
  readonly maxPollAttempts?: number | undefined;
  readonly pollDelayMs?: number | undefined;
  /** Injected so tests do not sleep in real time. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Non-secret view returned to the client. Carries no credential material. */
export interface ConnectResult {
  readonly accountId: string;
  readonly metaapiAccountId: string;
  readonly status: "connected";
  /** True when this request converged onto an existing binding (idempotency). */
  readonly alreadyConnected: boolean;
}

export interface DisconnectResult {
  readonly accountId: string;
  readonly status: "disconnected";
  /** Whether the provider-side account was deleted in this call (OD-MP-3 F). */
  readonly providerAccountDeleted: boolean;
}

const LOGIN_RE = /^[A-Za-z0-9._-]{1,32}$/;
const SERVER_RE = /^[A-Za-z0-9 ._-]{1,64}$/;
const PLATFORMS = new Set(["mt4", "mt5"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deterministic operation key: sha-256 over the stable identity of the
 * request. A double-click, a browser retry and a re-submitted form all produce
 * the SAME key, so they converge on one durable operation instead of
 * provisioning twice.
 *
 * The broker PASSWORD is deliberately NOT part of the key: it is a secret, and
 * a user correcting a mistyped password must be able to retry the same
 * logical operation rather than forking a new one.
 */
function operationKeyFor(
  userId: string,
  accountId: string,
  server: string,
  login: string,
  platform: string,
): string {
  return createHash("sha256")
    .update([userId, accountId, server.toLowerCase(), login, platform].join("\u0000"))
    .digest("hex");
}

/**
 * Provider-side marker derived from the operation key. Deterministic,
 * collision-resistant and CONTAINS NO SECRET — it is a hash prefix, not the
 * user's data. This is what makes an ambiguous provider outcome recoverable
 * without relying on provider deduplication (which is NOT PROVEN, D-7).
 */
function markerFor(operationKey: string): string {
  return `velora-${operationKey.slice(0, 32)}`;
}

export class MetaApiProvisioningService {
  private readonly now: () => Date;
  private readonly maxPollAttempts: number;
  private readonly pollDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ProvisioningDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxPollAttempts = deps.maxPollAttempts ?? 5;
    this.pollDelayMs = deps.pollDelayMs ?? 2_000;
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Connect a user-OWNED trading account to MetaAPI.
   *
   * PHASE 8 DECISION — this BINDS AN EXISTING ACCOUNT and never creates one.
   * Modern account creation is its own validated capability
   * (`POST /api/v1/accounts`) with its own plan quota; provisioning from here
   * would duplicate that quota logic and could silently create a second
   * account for a user who already had one. The account id is therefore a
   * path parameter, always resolved through `findByIdForUser`.
   */
  async connect(actor: ProvisioningActor, accountId: string, input: unknown): Promise<ConnectResult> {
    const token = this.deps.platformToken();
    if (token === null) {
      // ADR-014: absence of the platform token is a MISSING CAPABILITY, not a
      // crash and not a client error.
      throw new ProvisioningServiceError(
        503,
        "SERVICE_UNAVAILABLE",
        "MetaAPI is not configured.",
      );
    }

    const body = isRecord(input) ? input : {};
    const { login, server, platform, credentialId } = this.validate(body);

    // 1. OWNERSHIP — the account must exist AND belong to the caller. A miss is
    //    a non-disclosing 404, identical to every other account route, so this
    //    endpoint cannot be used to probe for other users' account ids.
    const account = await this.deps.accounts.findByIdForUser(accountId, actor.id);
    if (account === null) {
      throw new ProvisioningServiceError(404, "NOT_FOUND", "Account not found.");
    }
    this.requireBindingCapableStore();

    // 2. IDEMPOTENT SHORT-CIRCUIT — already bound to the same broker identity.
    const existing = await this.deps.accounts.getMetaApiBinding!(accountId, actor.id);
    if (existing !== null) {
      return {
        accountId,
        metaapiAccountId: existing,
        status: "connected",
        alreadyConnected: true,
      };
    }

    const operationKey = operationKeyFor(actor.id, accountId, server, login, platform);
    const marker = markerFor(operationKey);

    // 3. DURABLE RESERVATION (short transaction, committed before any HTTP).
    //    The UNIQUE (user_id, operation_key) index decides the race: a
    //    concurrent duplicate receives the existing row, not a second one.
    const reserved = await this.deps.operations.reserve({
      userId: actor.id,
      accountId,
      operationKey,
      providerMarker: marker,
      transactionId: newTransactionId(),
      now: this.now(),
    });
    const operation = reserved.operation;

    // A completed operation whose binding is already recorded converges here.
    if (operation.status === "COMPLETED" && operation.providerAccountId !== null) {
      return {
        accountId,
        metaapiAccountId: operation.providerAccountId,
        status: "connected",
        alreadyConnected: true,
      };
    }

    // 4. RECONCILE BEFORE PROVISIONING. An operation that previously ended
    //    ambiguously, or that was accepted and never resolved, may ALREADY own
    //    a provider account. Creating another would orphan the first.
    if (operation.status === "AMBIGUOUS" || operation.status === "ACCEPTED" || !reserved.created) {
      const found = await this.reconcile(token, marker);
      if (found !== null) {
        return this.completeBinding(actor, account, operation.id, found, /* reconciled */ true);
      }
    }

    // 5. CREDENTIAL CONSUMPTION — owner-scoped, in memory, for this call only.
    //    `reveal` is called with the ACTOR's id: the store's SQL is
    //    `WHERE id = $1 AND user_id = $2`, so a credential belonging to anyone
    //    else is simply not found. There is no admin path to this line.
    const secret = await this.deps.credentials.reveal(credentialId, actor.id);
    if (secret === null) {
      // Refused use is the security-relevant event (OD-MP-2): record it as a
      // DENIED consumption. No plaintext exists to leak — there was none.
      await this.appendAudit(actor, {
        action: "CREDENTIAL_USED",
        outcome: "denied",
        credentialId,
        tradingAccountId: accountId,
      });
      await this.deps.operations.markStatus(operation.id, "FAILED", this.now(), {
        lastErrorCode: "CREDENTIAL_NOT_FOUND",
        incrementAttempts: true,
      });
      // Non-disclosing: indistinguishable from "no such credential".
      throw new ProvisioningServiceError(404, "NOT_FOUND", "Credential not found.");
    }

    // The successful-use record is written BEFORE the provider call, so the
    // trail cannot lose the fact that the secret was used if the process dies
    // mid-request. It records the lifecycle event only — never the secret.
    await this.appendAudit(actor, {
      action: "CREDENTIAL_USED",
      outcome: "success",
      credentialId,
      tradingAccountId: accountId,
    });

    // 6. PROVIDER CALL — no database transaction is open here.
    let providerAccountId: string;
    try {
      providerAccountId = await this.provision(
        token,
        { login, password: secret, server, platform, marker },
        operation.transactionId ?? newTransactionId(),
        marker,
      );
    } catch (err) {
      await this.recordProviderFailure(operation.id, err);
      throw this.toServiceError(err);
    }

    return this.completeBinding(actor, account, operation.id, providerAccountId, false);
  }

  /**
   * OD-MP-3: user-owned disconnect.
   *
   * LOCAL UNBINDING is the default and the only thing that always happens.
   * Provider deletion is OPT-IN (`deleteProviderAccount: true`) and is a
   * DISTINCT operation (OD-MP-3 F); credential revocation is a third,
   * separate operation and is NEVER performed here — the user revokes a
   * credential through the credential routes.
   *
   * NO TRADE IS TOUCHED. Imported trades, their P/L, timestamps, provenance
   * and ledger events all survive verbatim (OD-MP-3 B/C/D/I): this method
   * issues no DELETE and no UPDATE against any trade table.
   */
  async disconnect(
    actor: ProvisioningActor,
    accountId: string,
    input: unknown,
  ): Promise<DisconnectResult> {
    const body = isRecord(input) ? input : {};
    const deleteProvider = body["deleteProviderAccount"] === true;

    const account = await this.deps.accounts.findByIdForUser(accountId, actor.id);
    if (account === null) {
      throw new ProvisioningServiceError(404, "NOT_FOUND", "Account not found.");
    }
    this.requireBindingCapableStore();

    const previous = await this.deps.accounts.getMetaApiBinding!(accountId, actor.id);
    if (previous === null) {
      throw new ProvisioningServiceError(
        409,
        "NOT_CONNECTED",
        "This account is not connected to MetaAPI.",
      );
    }

    // Provider deletion FIRST when requested: if it fails we stop, leaving the
    // binding intact and the state recoverable. Unbinding first would strand a
    // provider account we could no longer identify from Velora.
    let providerAccountDeleted = false;
    if (deleteProvider) {
      const token = this.deps.platformToken();
      if (token === null) {
        throw new ProvisioningServiceError(503, "SERVICE_UNAVAILABLE", "MetaAPI is not configured.");
      }
      try {
        // 404 is treated as success inside the client: "already absent" is the
        // postcondition of delete (OD-MP-3 G).
        await deleteMetaApiAccount(token, previous, this.deps.clientOptions);
        providerAccountDeleted = true;
      } catch (err) {
        throw this.toServiceError(err);
      }
    }

    const unbound = await this.deps.accounts.unbindMetaApiAccount!(accountId, actor.id, this.now());
    if (unbound === null) {
      // Lost a race with a concurrent disconnect. Nothing further to do, and
      // nothing was corrupted — report the same 409 as "not connected".
      throw new ProvisioningServiceError(
        409,
        "NOT_CONNECTED",
        "This account is not connected to MetaAPI.",
      );
    }

    await this.appendAudit(actor, {
      action: "ACCOUNT_BINDING_CHANGED",
      outcome: "success",
      tradingAccountId: accountId,
      // The transition is unambiguous: a concrete provider id -> none.
      beforeState: unbound,
      afterState: null,
    });

    return { accountId, status: "disconnected", providerAccountDeleted };
  }

  // --- internals -------------------------------------------------------------

  /**
   * Provision, honouring the documented 202 flow.
   *
   * On 202 the SAME transaction id is reused while polling, which is the only
   * documented retry semantic (D-7 §2E). Polling is BOUNDED. Provider-side
   * deduplication is never assumed: the poll asks "does an account carrying my
   * marker exist yet?", which is a question the documented read endpoint can
   * actually answer.
   */
  private async provision(
    token: string,
    req: {
      login: string;
      password: string;
      server: string;
      platform: "mt4" | "mt5";
      marker: string;
    },
    transactionId: string,
    marker: string,
  ): Promise<string> {
    const outcome = await createMetaApiAccount(token, req, transactionId, this.deps.clientOptions);
    if (outcome.kind === "created") return outcome.providerAccountId;

    // Accepted (202): the account may or may not exist yet.
    let delay = outcome.retryAfterMs ?? this.pollDelayMs;
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      await this.sleep(Math.max(0, Math.min(delay, 30_000)));
      const found = await findAccountByMarker(token, marker, this.deps.clientOptions);
      if (found !== null) return found;
      delay = this.pollDelayMs;
    }
    // Budget exhausted. The provider may still complete the creation, so this
    // is AMBIGUOUS, never "failed": the operation row keeps the marker and a
    // later attempt reconciles instead of creating a duplicate.
    throw new ProvisioningError(
      "PROVIDER_UNAVAILABLE",
      true,
      "provisioning not confirmed within the polling budget",
    );
  }

  /** Marker reconciliation. Translates a provider ambiguity into 409. */
  private async reconcile(token: string, marker: string): Promise<string | null> {
    try {
      return await findAccountByMarker(token, marker, this.deps.clientOptions);
    } catch (err) {
      if (err instanceof ProvisioningError && err.message === "marker matched multiple accounts") {
        throw new ProvisioningServiceError(
          409,
          "AMBIGUOUS_RECONCILIATION",
          "The provider returned more than one account for this connection.",
        );
      }
      throw this.toServiceError(err);
    }
  }

  /**
   * Bind + record, in the SHORT second transaction (no HTTP inside it).
   *
   * A local failure here does NOT discard the provider account: the operation
   * row already carries the marker and, on this path, the provider account id,
   * so the next attempt reconciles onto the same account.
   */
  private async completeBinding(
    actor: ProvisioningActor,
    account: AccountRecord,
    operationId: string,
    providerAccountId: string,
    reconciled: boolean,
  ): Promise<ConnectResult> {
    // Persist the provider outcome BEFORE attempting the binding. If the bind
    // fails, this row is what makes the provider account recoverable.
    await this.deps.operations.markStatus(operationId, "ACCEPTED", this.now(), {
      providerAccountId,
      incrementAttempts: true,
    });

    let bound: AccountRecord | null;
    try {
      bound = await this.deps.accounts.bindMetaApiAccount!(
        account.id,
        actor.id,
        providerAccountId,
        this.now(),
        // Reconciliation may re-assert the same id; a first bind must find the
        // column empty.
        !reconciled,
      );
    } catch (err) {
      if (err instanceof AccountBindingConflictError) {
        await this.deps.operations.markStatus(operationId, "FAILED", this.now(), {
          lastErrorCode: "DUPLICATE_BINDING",
        });
        throw new ProvisioningServiceError(409, "DUPLICATE_BINDING", err.message);
      }
      await this.deps.operations.markStatus(operationId, "AMBIGUOUS", this.now(), {
        lastErrorCode: "LOCAL_PERSISTENCE_FAILED",
      });
      throw new ProvisioningServiceError(
        503,
        "LOCAL_PERSISTENCE_FAILED",
        "The connection was created but could not be recorded. Retry to reconcile.",
      );
    }

    if (bound === null) {
      // Compare-and-set loss: someone bound this account first. Converge if it
      // is the same provider account, otherwise report the conflict.
      const current = await this.deps.accounts.getMetaApiBinding!(account.id, actor.id);
      if (current !== null && constantTimeEquals(current, providerAccountId)) {
        await this.deps.operations.markStatus(operationId, "COMPLETED", this.now(), {
          providerAccountId,
        });
        return {
          accountId: account.id,
          metaapiAccountId: current,
          status: "connected",
          alreadyConnected: true,
        };
      }
      await this.deps.operations.markStatus(operationId, "FAILED", this.now(), {
        lastErrorCode: "DUPLICATE_BINDING",
      });
      throw new ProvisioningServiceError(
        409,
        "DUPLICATE_BINDING",
        "This account is already connected to a different MetaAPI account.",
      );
    }

    await this.deps.operations.markStatus(operationId, "COMPLETED", this.now(), {
      providerAccountId,
    });

    await this.appendAudit(actor, {
      action: "ACCOUNT_BINDING_CHANGED",
      outcome: "success",
      tradingAccountId: account.id,
      beforeState: null,
      afterState: providerAccountId,
    });

    return {
      accountId: account.id,
      metaapiAccountId: providerAccountId,
      status: "connected",
      alreadyConnected: false,
    };
  }

  /** Record a provider failure as a NON-SECRET code. Never a message or body. */
  private async recordProviderFailure(operationId: string, err: unknown): Promise<void> {
    const code = err instanceof ProvisioningError ? err.code : "HANDLER_FAILED";
    const ambiguous = err instanceof ProvisioningError && err.ambiguous;
    await this.deps.operations.markStatus(
      operationId,
      // An ambiguous outcome must NEVER be recorded as FAILED: a later attempt
      // has to reconcile rather than create a second provider account.
      ambiguous ? "AMBIGUOUS" : "FAILED",
      this.now(),
      { lastErrorCode: code, incrementAttempts: true },
    );
  }

  /**
   * Map a provider failure onto the existing HTTP error vocabulary.
   * No provider message, body or raw error ever crosses this boundary.
   */
  private toServiceError(err: unknown): ProvisioningServiceError {
    if (err instanceof ProvisioningServiceError) return err;
    if (err instanceof ProvisioningError) {
      switch (err.code) {
        case "PROVIDER_REJECTED":
          return new ProvisioningServiceError(
            502,
            "PROVIDER_REJECTED",
            "The provider rejected the connection request.",
          );
        case "PROVIDER_UNAVAILABLE":
          return new ProvisioningServiceError(
            503,
            "PROVIDER_UNAVAILABLE",
            "The provider is temporarily unavailable. Retry to reconcile.",
          );
        case "PROVIDER_TIMEOUT":
          return new ProvisioningServiceError(
            504,
            "PROVIDER_TIMEOUT",
            "The provider did not respond in time. Retry to reconcile.",
          );
        case "PROVIDER_MALFORMED":
          return new ProvisioningServiceError(
            502,
            "PROVIDER_MALFORMED",
            "The provider returned an unexpected response.",
          );
        case "NOT_CONFIGURED":
          return new ProvisioningServiceError(503, "SERVICE_UNAVAILABLE", "MetaAPI is not configured.");
      }
    }
    // Unknown internal failure: no detail is echoed.
    return new ProvisioningServiceError(500, "INTERNAL", "Unexpected error.");
  }

  private async appendAudit(
    actor: ProvisioningActor,
    entry: {
      action: "CREDENTIAL_USED" | "ACCOUNT_BINDING_CHANGED";
      outcome: "success" | "denied";
      credentialId?: string | undefined;
      tradingAccountId: string;
      beforeState?: string | null | undefined;
      afterState?: string | null | undefined;
    },
  ): Promise<void> {
    await this.deps.audit.append({
      action: entry.action,
      actorUserId: actor.id,
      // Self-service: the actor IS the owner. OD-MP-1 rule 3 — there is no
      // path here on which these two differ.
      targetUserId: actor.id,
      beforeState: entry.beforeState ?? null,
      afterState: entry.afterState ?? null,
      outcome: entry.outcome,
      credentialId: entry.credentialId ?? null,
      provider: entry.credentialId !== undefined ? "METAAPI" : null,
      tradingAccountId: entry.tradingAccountId,
      requestId: actor.requestId ?? null,
      occurredAt: this.now(),
    });
  }

  /**
   * The binding methods are optional on the port (adapters predate OD-MP-1).
   * Fail closed rather than silently skipping the binding.
   */
  private requireBindingCapableStore(): void {
    const s = this.deps.accounts;
    if (
      s.bindMetaApiAccount === undefined ||
      s.unbindMetaApiAccount === undefined ||
      s.getMetaApiBinding === undefined
    ) {
      throw new ProvisioningServiceError(
        503,
        "SERVICE_UNAVAILABLE",
        "Account binding is not available on this deployment.",
      );
    }
  }

  private validate(body: Record<string, unknown>): {
    login: string;
    server: string;
    platform: "mt4" | "mt5";
    credentialId: string;
  } {
    const login = body["login"];
    if (typeof login !== "string" || !LOGIN_RE.test(login)) {
      throw new ProvisioningServiceError(400, "VALIDATION_FAILED", "Invalid login.", {
        login: "INVALID_FORMAT",
      });
    }
    const server = body["server"];
    if (typeof server !== "string" || !SERVER_RE.test(server)) {
      throw new ProvisioningServiceError(400, "VALIDATION_FAILED", "Invalid server.", {
        server: "INVALID_FORMAT",
      });
    }
    const platform = body["platform"];
    if (typeof platform !== "string" || !PLATFORMS.has(platform)) {
      throw new ProvisioningServiceError(400, "VALIDATION_FAILED", "Invalid platform.", {
        platform: "INVALID_PLATFORM",
      });
    }
    const credentialId = body["credentialId"];
    if (typeof credentialId !== "string" || !/^[0-9]{1,19}$/.test(credentialId)) {
      throw new ProvisioningServiceError(400, "VALIDATION_FAILED", "Invalid credential reference.", {
        credentialId: "INVALID_FORMAT",
      });
    }
    // NOTE: no `userId` is read from the body anywhere in this method. Even if
    // a client sends one it is ignored, so it cannot influence ownership.
    return { login, server, platform: platform as "mt4" | "mt5", credentialId };
  }
}

/** Length-safe comparison for identifiers read back from storage. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Exported for tests: the deterministic key/marker derivation. */
export const __testing = { operationKeyFor, markerFor, randomBytes };
