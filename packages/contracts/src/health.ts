// Health contract — frozen external contract C-01 (verified PHP behavior):
// GET /health → HTTP 200, envelope {"status":"success","data":{"status":"ok"}}
// and it must prove DB connectivity in a real deployment (readiness probe).
import { z } from "zod";

export const healthOkSchema = z.object({
  status: z.literal("ok"),
  checks: z
    .object({
      database: z.enum(["ok", "fail"]),
    })
    .partial()
    .optional(),
});

export type HealthOk = z.infer<typeof healthOkSchema>;

export const readinessSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  checks: z.object({
    database: z.enum(["ok", "fail"]),
  }),
});
