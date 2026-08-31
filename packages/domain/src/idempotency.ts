// Idempotency keys — ADR-002 (external trade identity) + ADR-007 (job keys) + ADR-008 (webhook dedupe).
export function jobKey(...parts: (string | number)[]): string {
  return parts.join(":");
}

export function webhookDedupeKey(source: string, eventId: string): string {
  return `webhook:${source}:${eventId}`;
}

export function syncCursorKey(accountId: string, cursor: string): string {
  return jobKey("sync", accountId, cursor);
}

export function outboxKey(notificationId: string): string {
  return jobKey("outbox", notificationId);
}
