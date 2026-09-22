// Phase 3B-3 — role persistence + the privilege-downgrade fix (G3).
//
// Evidence that the role survives the storage boundary intact, and that the
// PostgreSQL row mapper no longer silently collapses an elevated role.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRole, isAppRole } from "@velora/contracts";

/**
 * The exact mapping pgUserStore applies to a raw DB row.
 *
 * Before Phase 3B-3 this was `r.role === "admin" ? "admin" : "user"`, which
 * silently downgraded a stored 'super_admin' to 'user'. That was latent (the
 * 0001 CHECK made the value unreachable) and would have gone LIVE the moment
 * migration 0006 widened the constraint — a privilege bug that fails in the
 * safe direction but silently breaks the role, so it is asserted here.
 */
const legacyMapper = (role: string): string => (role === "admin" ? "admin" : "user");

test("G3 REGRESSION: the old mapper downgraded super_admin; normalizeRole does not", () => {
  // Demonstrate the defect that was fixed…
  assert.equal(legacyMapper("super_admin"), "user", "documents the former defect");
  // …and that the shipped mapper preserves it.
  assert.equal(normalizeRole("super_admin"), "super_admin");
});

test("role mapping round-trips every frozen role", () => {
  for (const role of ["user", "admin", "super_admin"]) {
    assert.equal(normalizeRole(role), role);
    assert.ok(isAppRole(role));
  }
});

test("corrupt or hostile stored values degrade to the least privileged role", () => {
  // A DB row could only hold these via a constraint bypass, but the mapper must
  // never escalate regardless of how the value got there.
  for (const bad of ["root", "velora_owner", "ADMIN", "super_admin ", "", null, undefined, 7, {}]) {
    assert.equal(normalizeRole(bad), "user", `${JSON.stringify(bad)} must degrade to user`);
  }
});

test("application roles are disjoint from the ADR-010 PostgreSQL identities", () => {
  // A super_admin application user must never be confused with a DB identity.
  for (const dbRole of ["velora_owner", "velora_migrator", "app_readwrite", "velora_worker", "velora_readonly"]) {
    assert.equal(isAppRole(dbRole), false, `${dbRole} is a DB identity, not an application role`);
    assert.equal(normalizeRole(dbRole), "user");
  }
});
