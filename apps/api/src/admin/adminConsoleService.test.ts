// AdminConsoleService — validation, ranges, and the two properties that must NOT
// be left to the route layer's discretion: what the health report is allowed to
// claim, and what an operator without `audit.view_sensitive` is allowed to see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError } from "../auth/authService.js";
import { AdminUserService } from "../auth/adminUserService.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";
import type { AuthorityContext } from "@velora/contracts";
import {
  AdminConsoleService,
  MAX_RANGE_DAYS,
  rankComponents,
  type ComponentStatus,
} from "./adminConsoleService.js";
import { MemoryAdminConsoleStore, type HealthFacts } from "./adminConsoleStore.js";

const ADMIN: AuthorityContext = { role: "admin", isSystemOwner: false };
const SUPER: AuthorityContext = { role: "super_admin", isSystemOwner: false };
const OWNER: AuthorityContext = { role: "user", isSystemOwner: true };

const NOW = new Date("2026-10-04T12:00:00.000Z");

function service(
  data: ConstructorParameters<typeof MemoryAdminConsoleStore>[0] = {},
  now: Date = NOW,
): AdminConsoleService {
  const store = new MemoryUserStore();
  const users = new AdminUserService({
    store,
    audit: new MemoryAuditStore(),
    getSystemOwnerUserId: async () => null,
  });
  return new AdminConsoleService({
    store: new MemoryAdminConsoleStore(data),
    users,
    now: () => now,
  });
}

const params = (query: string): URLSearchParams => new URLSearchParams(query);

// ── Ranges ──────────────────────────────────────────────────────────────────

test("RANGE: presets resolve to the documented windows and default to 30d", () => {
  const svc = service();
  assert.deepEqual(svc.resolveRange(params("")), {
    from: new Date(NOW.getTime() - 30 * 86_400_000),
    to: NOW,
    preset: "30d",
  });
  assert.equal(svc.resolveRange(params("range=7d")).preset, "7d");
  assert.equal(svc.resolveRange(params("range=90d")).preset, "90d");
  const today = svc.resolveRange(params("range=today"));
  assert.equal(today.from.toISOString(), "2026-10-04T00:00:00.000Z", "today starts at UTC midnight");
  assert.equal(svc.resolveRange(params("range=all")).preset, "all");
});

test("RANGE: an unknown preset is rejected, not silently defaulted", () => {
  const svc = service();
  for (const preset of ["lastYear", "7", "30D", "yesterday"]) {
    assert.throws(
      () => svc.resolveRange(params(`range=${preset}`)),
      (err: unknown) => err instanceof AuthError && err.code === "RANGE_INVALID",
      preset,
    );
  }
});

test("RANGE: an explicit range beats the preset, and a reversed range is refused", () => {
  const svc = service();
  const explicit = svc.resolveRange(params("range=7d&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z"));
  assert.equal(explicit.preset, null, "from/to state exactly what the caller wants");
  assert.equal(explicit.from.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(explicit.to.toISOString(), "2026-02-01T00:00:00.000Z");

  assert.throws(
    () => svc.resolveRange(params("from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z")),
    (err: unknown) => err instanceof AuthError && err.status === 422 && err.code === "RANGE_INVALID",
  );
  assert.throws(
    () => svc.resolveRange(params("from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:00Z")),
    (err: unknown) => err instanceof AuthError && err.code === "RANGE_INVALID",
    "an empty window is not a window",
  );
});

test("RANGE: an unbounded window is refused — a growing table is not a query plan", () => {
  const svc = service();
  assert.throws(
    () => svc.resolveRange(params("from=2020-01-01T00:00:00Z&to=2026-10-04T00:00:00Z")),
    (err: unknown) => err instanceof AuthError && err.code === "RANGE_TOO_WIDE",
  );
  const atLimit = service();
  const to = new Date("2026-10-04T00:00:00.000Z");
  const from = new Date(to.getTime() - MAX_RANGE_DAYS * 86_400_000);
  // Exactly the limit is allowed; one millisecond more is not.
  assert.equal(atLimit.resolveRange(params(`from=${from.toISOString()}&to=${to.toISOString()}`)).preset, null);
  assert.throws(
    () =>
      atLimit.resolveRange(
        params(`from=${new Date(from.getTime() - 1).toISOString()}&to=${to.toISOString()}`),
      ),
    (err: unknown) => err instanceof AuthError && err.code === "RANGE_TOO_WIDE",
  );
});

test("RANGE: a malformed instant is a named validation error, never a coerced date", () => {
  const svc = service();
  for (const bad of ["notadate", "2026-13-45", "1700000000"]) {
    assert.throws(
      () => svc.resolveRange(params(`from=${bad}`)),
      (err: unknown) =>
        err instanceof AuthError && err.code === "VALIDATION_FAILED" && err.details?.["from"] === "must be an ISO-8601 instant",
      bad,
    );
  }
});

// ── Health ──────────────────────────────────────────────────────────────────

const FACTS: HealthFacts = {
  databaseLatencyMs: 2.5,
  appliedMigrations: 27,
  migrationHead: "0027_admin_console.sql",
  expectedMigrations: 27,
  tables: 44,
  rateLimitBuckets: 3,
  auditRows: 12,
  authEvents: 40,
  processUptimeSeconds: 120,
  nodeVersion: "v22.0.0",
};

test("HEALTH: a healthy installation reports healthy, with measured detail", async () => {
  const report = await service({ health: FACTS }).health();
  assert.equal(report.overall, "healthy");
  assert.equal(report.checkedAt, NOW.toISOString());
  const db = report.components.find((c) => c.key === "database")!;
  assert.equal(db.status, "healthy");
  assert.equal(db.latencyMs, 2.5);
  const migrations = report.components.find((c) => c.key === "migrations")!;
  assert.equal(migrations.status, "healthy");
  assert.match(migrations.detail ?? "", /27 applied, head 0027_admin_console\.sql/);
});

test("HEALTH: slow is degraded, very slow is unhealthy, and a missing migration is degraded", async () => {
  const slow = await service({ health: { ...FACTS, databaseLatencyMs: 400 } }).health();
  assert.equal(slow.components.find((c) => c.key === "database")!.status, "degraded");
  assert.equal(slow.overall, "degraded");

  const verySlow = await service({ health: { ...FACTS, databaseLatencyMs: 2000 } }).health();
  assert.equal(verySlow.components.find((c) => c.key === "database")!.status, "unhealthy");
  assert.equal(verySlow.overall, "unhealthy");

  const behind = await service({ health: { ...FACTS, appliedMigrations: 26 } }).health();
  assert.equal(behind.components.find((c) => c.key === "migrations")!.status, "degraded");
  assert.match(behind.components.find((c) => c.key === "migrations")!.detail ?? "", /1 migration\(s\) not applied/);

  const empty = await service({ health: { ...FACTS, appliedMigrations: 0 } }).health();
  assert.equal(empty.components.find((c) => c.key === "migrations")!.status, "unhealthy");
});

test("HEALTH: a database AHEAD of the build is reported, not treated as current", async () => {
  const ahead = await service({ health: { ...FACTS, appliedMigrations: 30 } }).health();
  const migrations = ahead.components.find((c) => c.key === "migrations")!;
  assert.equal(migrations.status, "degraded");
  assert.match(migrations.detail ?? "", /3 migration\(s\) this build does not know/);
});

test("HEALTH: an unreadable migration manifest is UNKNOWN — never a green guess", async () => {
  const report = await service({ health: { ...FACTS, expectedMigrations: null } }).health();
  const migrations = report.components.find((c) => c.key === "migrations")!;
  assert.equal(migrations.status, "unknown");
  assert.equal(report.overall, "unknown", "an unknown component outranks a healthy one");
});

test("HEALTH: every component that is not built yet says so, with a reason and no green", async () => {
  const report = await service({ health: FACTS }).health();
  const notBuilt = report.components.filter((c) =>
    ["worker", "email", "ai_provider", "metaapi", "n8n_relay"].includes(c.key),
  );
  assert.equal(notBuilt.length, 5);
  for (const component of notBuilt) {
    assert.equal(component.status, "not_applicable", component.key);
    assert.ok((component.detail ?? "").length > 20, `${component.key} needs a real reason`);
    assert.match(component.detail ?? "", /phase[- ](7|8)/, `${component.key} must name the phase that builds it`);
  }
});

test("HEALTH: not_applicable never upgrades a report, and never downgrades one either", () => {
  const only = (list: ComponentStatus[]): ComponentStatus[] => list;
  assert.equal(
    rankComponents(only([{ key: "a", status: "healthy", detail: null }, { key: "b", status: "not_applicable", detail: "x" }])),
    "healthy",
  );
  assert.equal(
    rankComponents(only([{ key: "a", status: "unhealthy", detail: null }, { key: "b", status: "not_applicable", detail: "x" }])),
    "unhealthy",
  );
  assert.equal(rankComponents(only([{ key: "a", status: "unknown", detail: null }])), "unknown");
  assert.equal(rankComponents(only([])), "healthy", "no components means nothing is wrong — and nothing is claimed");
});

// ── Sensitive fields ────────────────────────────────────────────────────────

const SECURITY_ROW = {
  id: "1",
  occurredAt: "2026-10-04T11:00:00.000Z",
  userId: "7",
  email: "person@velora.example",
  eventType: "login" as const,
  result: "success",
  reason: null,
  ipAddress: "203.0.113.9",
  userAgent: "Mozilla/5.0",
};

test("SENSITIVE: an admin receives no ip/user-agent KEYS at all (not nulls)", async () => {
  const svc = service({ security: { items: [SECURITY_ROW], total: 1 } });
  const page = await svc.securityFeed("login", params(""), ADMIN);
  assert.equal(page.sensitive, false);
  assert.equal("ipAddress" in page.items[0]!, false);
  assert.equal("userAgent" in page.items[0]!, false);
  // The rest of the row is intact: redaction must not degrade the feed itself.
  assert.equal(page.items[0]!.email, "person@velora.example");
  assert.equal(page.items[0]!.result, "success");
});

test("SENSITIVE: a super_admin and the System Owner both receive the raw values", async () => {
  for (const authority of [SUPER, OWNER]) {
    const svc = service({ security: { items: [SECURITY_ROW], total: 1 } });
    const page = await svc.securityFeed("signup", params(""), authority);
    assert.equal(page.sensitive, true);
    assert.equal(page.items[0]!.ipAddress, "203.0.113.9");
  }
});

test("SENSITIVE: the feed's own filters are validated before the store is consulted", async () => {
  const svc = service({ security: { items: [SECURITY_ROW], total: 1 } });
  // `securityFeed` is async, so a bad filter REJECTS rather than throws; both
  // cases below therefore go through assert.rejects.
  await assert.rejects(
    () => svc.securityFeed("login", params("result=maybe"), ADMIN),
    (err: unknown) => err instanceof AuthError && err.code === "VALIDATION_FAILED",
  );
  await assert.rejects(
    () => svc.securityFeed("login", params("limit=100000"), ADMIN),
    (err: unknown) => err instanceof AuthError && err.code === "VALIDATION_FAILED",
  );
});

// ── Platform lists ──────────────────────────────────────────────────────────

test("PLATFORM LISTS: paging is bounded and a bad filter is named", async () => {
  const svc = service();
  for (const bad of ["page=0", "page=-1", "perPage=0", "perPage=101", "perPage=2.5"]) {
    await assert.rejects(
      () => svc.platformTrades(params(bad)),
      (err: unknown) => err instanceof AuthError && err.code === "VALIDATION_FAILED",
      bad,
    );
  }
  await assert.rejects(
    () => svc.platformTrades(params("status=PARTIAL")),
    (err: unknown) => err instanceof AuthError && err.details?.["status"] === "must be 'OPEN' or 'CLOSED'",
  );
  await assert.rejects(
    () => svc.platformAccounts(params("syncStatus=MAYBE")),
    (err: unknown) => err instanceof AuthError && err.code === "VALIDATION_FAILED",
  );
  const ok = (await svc.platformTrades(params("status=OPEN&page=2&perPage=10"))) as {
    page: number;
    perPage: number;
    offset: number;
    total: number;
  };
  assert.equal(ok.page, 2);
  assert.equal(ok.perPage, 10);
  assert.equal(ok.offset, 10);
});

test("PLATFORM LISTS: a window that ends before it starts is refused", async () => {
  const svc = service();
  await assert.rejects(
    () => svc.platformTrades(params("since=2026-10-04T00:00:00Z&until=2026-10-01T00:00:00Z")),
    (err: unknown) => err instanceof AuthError && err.code === "RANGE_INVALID",
  );
});
