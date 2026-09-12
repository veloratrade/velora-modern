// Response envelope — external contract C-01/C-10 (ADR-006), Phase C port of the
// PHP 4-field envelope (VERIFIED: reference api/src/Core/Response.php:36-46):
//   { "status": "success"|"error", "data": …, "error": …|null, "timestamp": … }
// Every response carries all four fields. `timestamp` follows the observed PHP
// format (gmdate('c')): UTC, seconds precision, "+00:00" offset (OD-5).
import { z } from "zod";
import { phpUtcTimestamp } from "./time.js";

export const successEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    status: z.literal("success"),
    data,
    error: z.null(),
    timestamp: z.string(),
  });

export const errorEnvelope = z.object({
  status: z.literal("error"),
  data: z.null(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.record(z.union([z.string(), z.number()])).optional(),
  }),
  timestamp: z.string(),
});

export type SuccessEnvelope<T> = {
  status: "success";
  data: T;
  error: null;
  timestamp: string;
};

export type ErrorEnvelope = {
  status: "error";
  data: null;
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: Record<string, string | number>;
  };
  timestamp: string;
};

export function ok<T>(data: T, now: Date = new Date()): SuccessEnvelope<T> {
  return { status: "success", data, error: null, timestamp: phpUtcTimestamp(now) };
}

export function fail(
  code: string,
  message: string,
  requestId?: string,
  details?: Record<string, string | number>,
  now: Date = new Date(),
): ErrorEnvelope {
  return {
    status: "error",
    data: null,
    error: {
      code,
      message,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(details !== undefined ? { details } : {}),
    },
    timestamp: phpUtcTimestamp(now),
  };
}
