// API kernel — thin delivery shell (ADR-010: apps are thin; domain/contracts
// own the logic). Implements the frozen external tier: health envelope (C-01),
// locale routing + headers (C-02/C-03/D-14), cache classes, origin guard.
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { ok, fail, resolvePublicRoute, CACHE_POLICY, LOCALE_HEADER } from "@velora/contracts";
import { newSecurityContext, buildCsp, SECURITY_HEADERS, originAllowed } from "./security.js";

export interface HealthChecks {
  database(): Promise<"ok" | "fail">;
}

export interface ApiConfig {
  allowedOrigins: readonly string[];
  checks: HealthChecks;
}

type RouteResult = { status: number; body: unknown; headers?: Record<string, string> };

async function route(req: IncomingMessage, config: ApiConfig, sec: { requestId: string; nonce: string }): Promise<RouteResult> {
  const url = new URL(req.url ?? "/", "http://internal");
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/health") {
    const db = await config.checks.database();
    if (db === "ok") return { status: 200, body: ok({ status: "ok", checks: { database: "ok" } }) };
    return { status: 503, body: fail("INTERNAL", "unhealthy", sec.requestId) };
  }

  if (method === "GET" && path === "/ready") {
    const db = await config.checks.database();
    const ready = db === "ok";
    return {
      status: ready ? 200 : 503,
      body: ok({ status: ready ? "ready" : "not_ready", checks: { database: db } }),
    };
  }

  // Public routes: locale routing + per-class cache policy (ADR-009)
  if (method === "GET") {
    const pub = resolvePublicRoute(path);
    if (pub) {
      return {
        status: 200,
        body: ok({ locale: pub.locale, routeClass: pub.routeClass }),
        headers: {
          [LOCALE_HEADER]: pub.locale,
          "Cache-Control": CACHE_POLICY[pub.routeClass],
        },
      };
    }
  }

  // State-changing routes: same-origin guard (verified PHP behavior parity)
  if (method === "POST" && path === "/api/v1/auth/logout") {
    const origin = req.headers.origin;
    if (!originAllowed(origin, config.allowedOrigins)) {
      return { status: 403, body: fail("ORIGIN_REJECTED", "origin not allowed", sec.requestId) };
    }
    return { status: 200, body: ok({ loggedOut: true }) };
  }

  return { status: 404, body: fail("NOT_FOUND", "no such route", sec.requestId) };
}

export function createApp(config: ApiConfig): Server {
  return httpCreateServer((req: IncomingMessage, res: ServerResponse) => {
    const sec = newSecurityContext();
    void route(req, config, sec)
      .then((r) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json; charset=utf-8",
          "X-Request-Id": sec.requestId,
          "Content-Security-Policy": buildCsp(sec.nonce),
          ...SECURITY_HEADERS,
          ...r.headers,
        };
        res.writeHead(r.status, headers);
        res.end(JSON.stringify(r.body));
      })
      .catch(() => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "X-Request-Id": sec.requestId });
        res.end(JSON.stringify(fail("INTERNAL", "internal error", sec.requestId)));
      });
  });
}

export function listen(app: Server, port = 0): Promise<number> {
  return new Promise((resolvePromise) => {
    app.listen(port, "127.0.0.1", () => {
      const addr = app.address();
      resolvePromise(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
