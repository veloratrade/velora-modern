// Newsletter HTTP surface — Phase 3 feature (GAP-NL).
//
// Runs through the REAL kernel (`createApp` + `listen`) and the real
// `dispatchExtendedRoutes` dispatch, with an in-memory store double. Proves the
// route is registered, public, validated, and fail-closed when unwired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../kernel/server.js";
import type { NewsletterStore } from "./pgNewsletterStore.js";

interface Envelope<T = unknown> {
  status: "success" | "error";
  data: T;
  error: { code: string; message: string } | null;
  timestamp: string;
}

class MemoryNewsletterStore implements NewsletterStore {
  private emails = new Set<string>();
  async subscribe(email: string): Promise<{ id: string }> {
    this.emails.add(email.toLowerCase());
    return { id: String(this.emails.size) };
  }
  async subscribed(email: string): Promise<boolean> {
    return this.emails.has(email.toLowerCase());
  }
}

async function withStore(fn: (base: string) => Promise<void>): Promise<void> {
  const store = new MemoryNewsletterStore();
  const app = createApp({
    allowedOrigins: ["https://app.velora.example"],
    checks: { database: async () => "ok" as const },
    newsletter: store,
  });
  try {
    const addr = await new Promise<number>((resolve, reject) => {
      app.listen(0, "127.0.0.1", (err?: Error | null) =>
        err ? reject(err) : resolve((app.address() as { port: number }).port),
      );
    });
    const base = `http://127.0.0.1:${addr}`;
    await fn(base);
  } finally {
    app.close();
  }
}

test("POST /api/v1/newsletter/subscribe creates a subscription (201)", async () => {
  await withStore(async (base) => {
    const res = await fetch(`${base}/api/v1/newsletter/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    assert.equal(res.status, 201);
    const body: Envelope = await res.json();
    assert.equal(body.status, "success");
    assert.equal(body.data.subscribed, true);
    assert.ok(typeof body.data.id === "string" && body.data.id.length > 0);
  });
});

test("subscribe is idempotent: re-subscribing the same email is still 201", async () => {
  await withStore(async (base) => {
    const res1 = await fetch(`${base}/api/v1/newsletter/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com" }),
    });
    assert.equal(res1.status, 201);
    const res2 = await fetch(`${base}/api/v1/newsletter/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com" }),
    });
    assert.equal(res2.status, 201);
  });
});

test("invalid email is rejected (400 VALIDATION_FAILED)", async () => {
  await withStore(async (base) => {
    const res = await fetch(`${base}/api/v1/newsletter/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    assert.equal(res.status, 400);
    const body: Envelope = await res.json();
    assert.equal(body.status, "error");
    assert.equal(body.error.code, "VALIDATION_FAILED");
  });
});

test("missing email is rejected (400)", async () => {
  await withStore(async (base) => {
    const res = await fetch(`${base}/api/v1/newsletter/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("GET on the subscribe path is 404", async () => {
  await withStore(async (base) => {
    const res = await fetch(`${base}/api/v1/newsletter/subscribe`, {
      method: "GET",
    });
    assert.equal(res.status, 404);
  });
});

test("newsletter absent from config answers 503 SERVICE_UNAVAILABLE", async () => {
  const app = createApp({
    allowedOrigins: ["https://app.velora.example"],
    checks: { database: async () => "ok" as const },
  });
  try {
    const addr = await new Promise<number>((resolve, reject) => {
      app.listen(0, "127.0.0.1", (err?: Error | null) =>
        err ? reject(err) : resolve((app.address() as { port: number }).port),
      );
    });
    const base = `http://127.0.0.1:${addr}`;
    const res = await fetch(`${base}/api/v1/newsletter/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    assert.equal(res.status, 503);
    const body: Envelope = await res.json();
    assert.equal(body.status, "error");
    assert.equal(body.error.code, "SERVICE_UNAVAILABLE");
  } finally {
    app.close();
  }
});
