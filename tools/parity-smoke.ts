// Parity smoke: boots the API kernel on an ephemeral port and runs the parity
// spec runner IN-PROCESS against it. Exit code = parity result.
//
// Why in-process: this dev sandbox drops child→parent loopback TCP connections
// (verified: parent-process fetch → 200; child-process fetch → timeout), so the
// parity runner is imported rather than spawned. In CI/staging, use
// `node parity/run.mjs --target URL` as a real cross-process check.
import { createApp, listen } from "../apps/api/src/kernel/server.js";
import { runSpecs } from "../parity/run.mjs";

const app = createApp({
  allowedOrigins: ["https://veloratrade.ir"],
  checks: { database: async () => "ok" }, // kernel-level smoke; the real DB probe runs in the app process
});
try {
  const port = await listen(app);
  const { fail } = await runSpecs(`http://127.0.0.1:${port}`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  await new Promise<void>((r) => app.close(() => r()));
}
