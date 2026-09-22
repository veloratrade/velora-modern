// MetaApiWebhookService — the v0.2 "Webhook Ingestion Engine".
//
// ============================================================
// CAPABILITY (what the product needs, not what PHP wrote)
// ============================================================
// A broker-side event (a deal opening/closing/modifying) must reach Velora
// promptly, must be impossible to forge, must not be replayable, and must be
// recorded even when the rest of the system is degraded, so nothing is lost.
//
// ============================================================
// EXTRACTED BEHAVIOUR (Legacy `api/src/Webhooks/MetaApiWebhookController.php`)
// ============================================================
// Verified order of checks and their exact external codes:
//   413 PAYLOAD_TOO_LARGE           — empty body, or > 1 048 576 bytes
//   503 WEBHOOK_SECRET_MISSING      — no secret configured (fail-closed)
//   401 HMAC_FAILED                 — body signature missing/mismatched
//   422 INVALID_WEBHOOK_PAYLOAD     — body is not a JSON object
//   401 WEBHOOK_TIMESTAMP_HMAC_FAILED — timestamp header present, its signature missing/invalid
//   401 WEBHOOK_TIMESTAMP_INVALID   — timestamp missing/unparseable/stale (+30 s skew)
//   422 INVALID_WEBHOOK_IDENTIFIERS — accountId/type missing or malformed
// Signature is HMAC-SHA256 over the RAW body; the timestamp signature is
// HMAC-SHA256 over `<timestamp>.<rawBody>`; comparisons are timing-safe.
//
// ============================================================
// DELIBERATE ARCHITECTURAL DIVERGENCE (documented, not silent)
// ============================================================
// Legacy processed the payload INLINE: it wrote each deal into its own fill
// ledger and assembled trades inside the request. This platform already owns
// exactly one deal-ingestion implementation — the worker's
// `normalizeDeal` + `syncRepository` over `sync_fills` — and adding a second,
// request-path copy would create two ingestion implementations that will drift
// apart (the classic failure this migration exists to avoid).
//
// So the capability is preserved by a different, native mechanism:
//   verify → dedupe → RECORD DURABLY → resolve account → request a targeted sync
// The observable product behaviour ("the trade shows up") is preserved; the
// job of turning deals into trades stays with the single worker implementation.
// The response keeps the Legacy field names (account_id/inserted/skipped/fills)
// so an existing caller does not break, and adds `sync` to report what was
// actually requested.
import { WEBHOOK_SOURCES, type WebhookResult } from "@velora/contracts";
import type { WebhookEventStore } from "./webhookStore.js";
import type { SyncTrigger } from "./syncTrigger.js";
import {
  BODY_SIGNATURE_HEADERS,
  TIMESTAMP_HEADER,
  TIMESTAMP_SIGNATURE_HEADER,
  checkFreshness,
  hmacHex,
  normalizeSignature,
  signaturesMatch,
} from "./signature.js";

export const MAX_BODY_BYTES = 1_048_576; // Legacy constant, verbatim

const SOURCE = WEBHOOK_SOURCES[0]?.source ?? "metaapi";
const IDENTIFIER_RE = /^[a-z0-9._:-]+$/;

export type WebhookFailureCode =
  | "PAYLOAD_TOO_LARGE"
  | "WEBHOOK_SECRET_MISSING"
  | "HMAC_FAILED"
  | "INVALID_WEBHOOK_PAYLOAD"
  | "WEBHOOK_TIMESTAMP_HMAC_FAILED"
  | "WEBHOOK_TIMESTAMP_INVALID"
  | "INVALID_WEBHOOK_IDENTIFIERS";

export type WebhookOutcome =
  | {
      readonly result: Extract<WebhookResult, "accepted">;
      readonly status: 200;
      readonly body: Record<string, unknown>;
    }
  | {
      readonly result: Extract<WebhookResult, "deduplicated">;
      readonly status: 200;
      readonly body: Record<string, unknown>;
    }
  | {
      readonly result: Extract<WebhookResult, "rejected">;
      readonly status: number;
      readonly code: WebhookFailureCode;
      readonly message: string;
    }
  | {
      readonly result: Extract<WebhookResult, "quarantined">;
      readonly status: number;
      readonly code: WebhookFailureCode;
      readonly message: string;
    };

/** Account facts the ingress needs. Deliberately minimal: identifiers only. */
export interface WebhookAccountRef {
  readonly accountId: string;
  readonly userId: string;
  readonly metaapiAccountId: string;
  readonly syncCursor: string | null;
}

export interface MetaApiWebhookDeps {
  readonly store: WebhookEventStore;
  /**
   * The provider signing secret, read AT CALL TIME from a thunk so no
   * module-scope value ever holds it and so a rotated secret takes effect
   * without a restart. `null` ⇒ fail-closed 503 (never a silent accept).
   */
  readonly secret: () => string | null;
  /** Resolve a Velora account by its provider identifier. Null when unknown. */
  readonly resolveAccount: (metaapiAccountId: string) => Promise<WebhookAccountRef | null>;
  /** Mark the account as awaiting sync (durable, survives a lost queue). */
  readonly markSyncPending: (accountId: string) => Promise<void>;
  /** Best-effort immediate dispatch. Absent ⇒ the scheduled tick catches up. */
  readonly trigger: SyncTrigger;
  readonly maxAgeMs?: number;
  readonly now?: () => Date;
}

export interface WebhookRequest {
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null {
  const raw = headers[name];
  if (raw === undefined) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

export class MetaApiWebhookService {
  private readonly now: () => Date;

  constructor(private readonly deps: MetaApiWebhookDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async handle(input: WebhookRequest): Promise<WebhookOutcome> {
    // ---- 1. Size (before anything reads the secret) ------------------------
    if (input.rawBody.length === 0 || input.rawBody.length > MAX_BODY_BYTES) {
      return {
        result: "rejected",
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "Webhook payload is missing or too large.",
      };
    }

    // ---- 2. Secret presence (fail-closed) ---------------------------------
    const secret = this.deps.secret();
    if (secret === null || secret === "") {
      return {
        result: "rejected",
        status: 503,
        code: "WEBHOOK_SECRET_MISSING",
        message: "Webhook authentication is not configured.",
      };
    }

    // ---- 3. Body signature (timing-safe, over RAW bytes) ------------------
    const expectedBody = hmacHex(input.rawBody, secret);
    let presented: string | null = null;
    for (const name of BODY_SIGNATURE_HEADERS) {
      const candidate = normalizeSignature(headerValue(input.headers, name));
      if (candidate !== null) {
        presented = candidate;
        break;
      }
    }
    if (presented === null || !signaturesMatch(expectedBody, presented)) {
      return { result: "rejected", status: 401, code: "HMAC_FAILED", message: "HMAC verification failed." };
    }

    // ---- 4. Body must be a JSON object ------------------------------------
    let payload: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(input.rawBody.toString("utf8"));
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("not an object");
      }
      payload = decoded as Record<string, unknown>;
    } catch {
      return {
        result: "quarantined",
        status: 422,
        code: "INVALID_WEBHOOK_PAYLOAD",
        message: "Invalid webhook JSON.",
      };
    }

    // ---- 5. Delivery timestamp (a deal timestamp is NOT a delivery time) --
    const headerTimestamp = headerValue(input.headers, TIMESTAMP_HEADER);
    let timestampRaw: string | null;
    if (headerTimestamp !== null && headerTimestamp !== "") {
      const tsSignature = normalizeSignature(headerValue(input.headers, TIMESTAMP_SIGNATURE_HEADER));
      const expectedTs = hmacHex(`${headerTimestamp}.${input.rawBody.toString("utf8")}`, secret);
      if (tsSignature === null || !signaturesMatch(expectedTs, tsSignature)) {
        return {
          result: "rejected",
          status: 401,
          code: "WEBHOOK_TIMESTAMP_HMAC_FAILED",
          message: "Webhook timestamp signature failed.",
        };
      }
      timestampRaw = headerTimestamp;
    } else {
      const inBody = payload["webhookTimestamp"];
      timestampRaw = typeof inBody === "string" || typeof inBody === "number" ? String(inBody) : null;
    }
    const freshness = checkFreshness(timestampRaw, this.now(), this.deps.maxAgeMs);
    if (!freshness.ok) {
      return {
        result: "rejected",
        status: 401,
        code: "WEBHOOK_TIMESTAMP_INVALID",
        message: "Webhook timestamp is stale or invalid.",
      };
    }

    // ---- 6. Identifiers ----------------------------------------------------
    const metaapiAccountId = normalizeIdentifier(
      payload["accountId"] ?? payload["metaapi_account_id"] ?? null,
    );
    const eventType = normalizeEventType(payload["type"] ?? payload["event"] ?? null);
    if (metaapiAccountId === null || eventType === null) {
      return {
        result: "quarantined",
        status: 422,
        code: "INVALID_WEBHOOK_IDENTIFIERS",
        message: "Invalid webhook identifiers.",
      };
    }

    // ---- 7. Durable record + replay defence (DB-unique, not app-level) -----
    const explicitEventId = normalizeIdentifier(payload["eventId"] ?? payload["id"] ?? null);
    const eventId =
      explicitEventId ?? hmacHex(input.rawBody, "velora-event-id").slice(0, 64); // stable content hash
    const account = await this.deps.resolveAccount(metaapiAccountId);
    const { inserted, record } = await this.deps.store.record({
      source: SOURCE,
      eventId,
      payload,
      signatureAlgorithm: "hmac-sha256",
      signatureVerifiedAt: this.now().toISOString(),
    });

    if (!inserted) {
      // Replay: the event is already recorded. Ack without re-processing.
      return {
        result: "deduplicated",
        status: 200,
        body: {
          account_id: account === null ? null : account.accountId,
          inserted: 0,
          skipped: 0,
          fills: 0,
          duplicated: true,
          event_id: record.eventId,
        },
      };
    }

    // ---- 8. Ask for the trades this event implies --------------------------
    // Unknown account is ACCEPTED and recorded (Legacy parity: account_id null,
    // no error) — a provider retry storm must not be provoked by a Velora-side
    // mapping gap, and the event stays available for later reconciliation.
    let sync: "requested" | "deferred" | "unknown-account" = "unknown-account";
    if (account !== null) {
      await this.deps.markSyncPending(account.accountId);
      const dispatched = await this.deps.trigger.requestSync({
        accountId: account.accountId,
        metaapiAccountId: account.metaapiAccountId,
        from: account.syncCursor ?? new Date(this.now().getTime() - 86_400_000).toISOString(),
        to: this.now().toISOString(),
      });
      sync = dispatched ? "requested" : "deferred";
    }

    await this.deps.store.markProcessed(record.id);

    return {
      result: "accepted",
      status: 200,
      body: {
        account_id: account === null ? null : account.accountId,
        inserted: 0,
        skipped: 0,
        fills: 0,
        event_id: record.eventId,
        event_type: eventType,
        sync,
      },
    };
  }
}

/** Provider identifier: string, trimmed, bounded, conservative charset. */
export function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 128) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

/** Event type: lowercased, ≤ 50, [a-z0-9._:-] — Legacy rule verbatim. */
export function normalizeEventType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized.length > 50) return null;
  return IDENTIFIER_RE.test(normalized) ? normalized : null;
}
