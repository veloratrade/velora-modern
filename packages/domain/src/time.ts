// Time utilities — ADR-004 (Accepted, D-11): UTC-only, injectable clock.
import { isTimestamptzString } from "@velora/contracts";

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export function toIsoUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function assertTimestamptz(value: string, field = "timestamp"): string {
  if (!isTimestamptzString(value)) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp with explicit offset (ADR-004): got ${JSON.stringify(value)}`);
  }
  return value;
}
