// Response envelope — frozen external contract C-01/C-10 (ADR-006).
// Exact shape: { "status": "success"|"error", "data": ... } on the external tier.
import { z } from "zod";

export const successEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ status: z.literal("success"), data });

export const errorEnvelope = z.object({
  status: z.literal("error"),
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelope>;

export function ok<T>(data: T): { status: "success"; data: T } {
  return { status: "success", data };
}

export function fail(
  code: string,
  message: string,
  requestId?: string,
): ErrorEnvelope {
  return { status: "error", error: { code, message, ...(requestId !== undefined ? { requestId } : {}) } };
}
