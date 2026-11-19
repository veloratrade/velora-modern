// Newsletter service unit tests — Phase 3 feature (GAP-NL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NewsletterService } from "./newsletterService.js";

class StubStore {
  emails = new Set<string>();
  async subscribe(email: string): Promise<{ id: string }> {
    this.emails.add(email);
    return { id: "sub-1" };
  }
  async subscribed(email: string): Promise<boolean> {
    return this.emails.has(email);
  }
}

test("subscribe normalizes email (trim + lowercase) and delegates to store", async () => {
  const store = new StubStore();
  const svc = new NewsletterService(store);
  const { id } = await svc.subscribe({ email: "  ALICE@Example.Com  " });
  assert.equal(id, "sub-1");
  assert.ok(store.emails.has("alice@example.com"));
  assert.equal(store.emails.size, 1);
});

test("subscribe rejects invalid email (400 VALIDATION_FAILED)", async () => {
  const store = new StubStore();
  const svc = new NewsletterService(store);
  await assert.rejects(
    svc.subscribe({ email: "not-an-email" }),
    (err: { status: number; code: string }) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, "VALIDATION_FAILED");
      return true;
    },
  );
});

test("subscribe rejects empty email (400)", async () => {
  const store = new StubStore();
  const svc = new NewsletterService(store);
  await assert.rejects(
    svc.subscribe({ email: "" }),
    (err: { status: number }) => err.status === 400,
  );
});

test("subscribe rejects missing email (400)", async () => {
  const store = new StubStore();
  const svc = new NewsletterService(store);
  await assert.rejects(
    svc.subscribe({} as never),
    (err: { status: number }) => err.status === 400,
  );
});
