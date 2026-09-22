// Webhook ingestion contract — ADR-008 (Accepted, D-05).
export const WEBHOOK_TOLERANCE_MS_DEFAULT = 5 * 60 * 1000; // ±5 minutes (D-05)

export type WebhookResult =
  | "accepted"
  | "rejected" // bad signature / stale timestamp → 4xx, no retry expected
  | "deduplicated" // event-id seen → 2xx fast-path, no double effect
  | "quarantined" // unknown/malformed payload → 4xx + alert
  | "failed"; // internal projection failure → 5xx retriable

export interface WebhookSourceConfig {
  source: string; // e.g. "metaapi", "n8n"
  /** HMAC secret: env-only, never in code/logs (name only in config). */
  secretEnvName: string;
  toleranceMs: number; // per-source configurable (D-05)
}

export const WEBHOOK_SOURCES: readonly WebhookSourceConfig[] = [
  { source: "metaapi", secretEnvName: "METAAPI_WEBHOOK_SECRET", toleranceMs: WEBHOOK_TOLERANCE_MS_DEFAULT },
];
