// Readiness probe tests — exercise the REAL makeDbProbe used by server-main.ts.
//
// Deploy-safety context: `/health` is liveness-only and is what the platform
// healthcheck hits, so a reachable-but-unmigrated database used to pass every
// automated check while every capability failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDbProbe, SCHEMA_MISSING_MESSAGE, type ProbeClient } from "./dbProbe.js";

type Row = Record<string, unknown>;

/** Scriptable fake client: maps a SQL fragment to its result. */
function fakeClient(script: {
  connect?: () => Promise<void>;
  hasTable?: boolean;
  appliedRows?: number;
  failQuery?: boolean;
}): { client: ProbeClient; queries: string[] } {
  const queries: string[] = [];
  const client: ProbeClient = {
    connect: script.connect ?? (async () => {}),
    query: async (sql: string) => {
      queries.push(sql);
      if (script.failQuery === true) throw new Error("connection lost");
      if (sql.includes("to_regclass")) {
        const rows: Row[] = [{ has_table: script.hasTable ?? true }];
        return { rows, rowCount: 1 };
      }
      const n = script.appliedRows ?? 1;
      return { rows: Array.from({ length: n }, () => ({})) as Row[], rowCount: n };
    },
    end: async () => {},
  };
  return { client, queries };
}

test("readiness: no durable store configured → fail (never fabricates ok)", async () => {
  const probe = makeDbProbe(undefined);
  assert.equal(await probe(), "fail");
});

test("readiness: reachable AND migrated → ok", async () => {
  const { client, queries } = fakeClient({ hasTable: true, appliedRows: 1 });
  const probe = makeDbProbe("postgresql://x/y", { createClient: async () => client, warn: () => {} });
  assert.equal(await probe(), "ok");
  // It must actually verify the schema, not just connectivity.
  assert.ok(queries.some((q) => q.includes("to_regclass")), "must check the tracking table");
  assert.ok(queries.some((q) => q.includes("FROM schema_migrations")), "must check applied rows");
});

test("readiness: reachable but tracking table MISSING → fail (the deploy-safety case)", async () => {
  const warnings: Record<string, unknown>[] = [];
  const { client } = fakeClient({ hasTable: false });
  const probe = makeDbProbe("postgresql://x/y", {
    createClient: async () => client,
    warn: (e) => warnings.push(e),
  });
  assert.equal(await probe(), "fail");
  assert.equal(warnings[0]?.event, "readiness.schema_missing");
  assert.equal(warnings[0]?.message, SCHEMA_MISSING_MESSAGE);
});

test("readiness: tracking table present but EMPTY → fail", async () => {
  const { client } = fakeClient({ hasTable: true, appliedRows: 0 });
  const probe = makeDbProbe("postgresql://x/y", { createClient: async () => client, warn: () => {} });
  assert.equal(await probe(), "fail");
});

test("readiness: connection failure → fail", async () => {
  const { client } = fakeClient({
    connect: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const probe = makeDbProbe("postgresql://x/y", { createClient: async () => client, warn: () => {} });
  assert.equal(await probe(), "fail");
});

test("readiness: driver unavailable → fail closed", async () => {
  const probe = makeDbProbe("postgresql://x/y", {
    createClient: async () => {
      throw new Error("pg not installed");
    },
    warn: () => {},
  });
  assert.equal(await probe(), "fail");
});

test("readiness: a lost connection is recoverable — fail then ok once the store returns", async () => {
  let attempt = 0;
  const probe = makeDbProbe("postgresql://x/y", {
    createClient: async () => {
      attempt += 1;
      return fakeClient(attempt === 1 ? { failQuery: true } : { hasTable: true, appliedRows: 1 })
        .client;
    },
    warn: () => {},
  });
  assert.equal(await probe(), "fail", "first probe sees a dead connection");
  assert.equal(await probe(), "ok", "probe self-heals on the next call");
});

test("readiness: the schema warning is emitted once, not on every probe", async () => {
  const warnings: Record<string, unknown>[] = [];
  const { client } = fakeClient({ hasTable: false });
  const probe = makeDbProbe("postgresql://x/y", {
    createClient: async () => client,
    warn: (e) => warnings.push(e),
  });
  await probe();
  await probe();
  await probe();
  assert.equal(warnings.length, 1, "operators must not be spammed on every healthcheck");
});
