// API process entrypoint (dev/staging). Binds the kernel to a port with a
// REAL database probe when DATABASE_URL is set (via pg), else a failing probe
// (readiness must never lie — ADR-010 "fail-closed" posture).
import { createApp, listen } from "./kernel/server.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const allowedOrigins = (process.env.API_ALLOWED_ORIGINS ?? "http://127.0.0.1:8080").split(",").map((s) => s.trim());

  let dbProbe: () => Promise<"ok" | "fail">;
  if (process.env.DATABASE_URL) {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    dbProbe = async () => {
      try {
        await client.query("SELECT 1");
        return "ok";
      } catch {
        return "fail";
      }
    };
  } else {
    dbProbe = async () => "fail";
  }

  const app = createApp({ allowedOrigins, checks: { database: dbProbe } });
  const bound = await listen(app, port);
  console.log(JSON.stringify({ level: "info", service: "api", event: "startup", port: bound, db: process.env.DATABASE_URL ? "configured" : "missing" }));
}

void main();
