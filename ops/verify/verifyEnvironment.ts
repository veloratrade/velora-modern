// Environment verification core — MG-OPS-TOOLING (AC-36).
//
// The importable half of tools/ops-verify.mjs: pure query orchestration over
// an injected query function (pg pool OR PGlite engine), so drift detection is
// unit-testable. LAWS (test-pinned):
//   - READ-ONLY: every statement is SELECT/catalog metadata. No DML/DDL.
//   - No secrets, no DSN, no row payloads — counts and catalog rows only.

export type VerifyQuery = (sql: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>;

export interface OrphanedFk {
  readonly constraint: string;
  readonly child: string;
  readonly parent: string;
  readonly orphaned: number;
}

export interface EnvironmentVerification {
  readonly identity: {
    readonly version: string;
    readonly database: string;
    readonly dbUser: string;
  };
  /** Migration files present on disk but absent from the ledger (normalized names). */
  readonly unmigrated: readonly string[];
  /** Ledger entries whose file no longer exists. */
  readonly phantomLedgerEntries: readonly string[];
  /** Live row count per public table. */
  readonly tableCounts: Readonly<Record<string, number | string>>;
  /** Per-table grants of the CURRENT connection user (report-only). */
  readonly privileges: ReadonlyArray<{ readonly table: string; readonly privs: string }>;
  readonly fkOrphans: readonly OrphanedFk[];
  /** FK constraints whose rows this role may not read (least-privilege runs). */
  readonly fkUnverifiable: ReadonlyArray<{ readonly constraint: string; readonly reason: string }>;
  /** How many FK constraints the orphan scan actually evaluated. */
  readonly fkConstraintsChecked: number;
  readonly drift: boolean;
}

export async function runEnvironmentVerification(
  q: VerifyQuery,
  migrationFileNames: readonly string[],
): Promise<EnvironmentVerification> {
  // 1 — server identity
  const idRow = (
    await q("SELECT version() AS version, current_database() AS database, current_user AS db_user")
  )[0] as Record<string, string>;
  const identity = {
    version: String(idRow["version"]),
    database: String(idRow["database"]),
    dbUser: String(idRow["db_user"]),
  };

  // 2 — migration ledger diff (ledger names are stored without .sql; both
  // sides are normalized to bare names before diffing)
  const ledgerRows = await q("SELECT name FROM schema_migrations ORDER BY name");
  const ledger = new Set(ledgerRows.map((r) => String(r["name"]).replace(/\.sql$/, "")));
  const files = migrationFileNames.map((f) => f.replace(/\.sql$/, ""));
  const fileSet = new Set(files);
  const unmigrated = files.filter((f) => !ledger.has(f));
  const phantomLedgerEntries = [...ledger].filter((name) => !fileSet.has(name));

  // 3 — table inventory + exact row counts (pgboss internals skipped).
  // A table the connection may not count (42501) is recorded as "nopriv" —
  // that denial is itself privilege evidence, not a failure: the probe must
  // stay useful to a least-privilege role (legacy probe law: report what you
  // can see, surface what you cannot).
  const tables = await q(
    `SELECT c.relname AS table_name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  const tableCounts: Record<string, number | string> = {};
  for (const t of tables) {
    const name = String(t["table_name"]);
    if (name === "schema_migrations" || name.startsWith("pgboss")) {
      tableCounts[name] = "-";
      continue;
    }
    try {
      const exact = await q(`SELECT COUNT(*)::bigint AS n FROM "${name}"`);
      tableCounts[name] = Number((exact[0] as Record<string, unknown>)["n"]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "42501") {
        tableCounts[name] = "nopriv";
      } else {
        throw err;
      }
    }
  }

  // 4 — privilege audit (report-only)
  const grants = await q(
    `SELECT table_name, string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type) AS privs
       FROM information_schema.role_table_grants
      WHERE grantee = current_user AND table_schema = 'public'
      GROUP BY table_name ORDER BY table_name`,
  );

  // 5 — FK integrity: orphaned child rows per relationship (pairwise columns,
  // NULLs excluded on the child side — a NULL FK does not reference anything).
  // Columns come back as json_agg (NOT array_agg): node-postgres does not
  // deserialize name[] to a JS array, it returns the wire literal string —
  // which made every constraint silently skippable in the live-PG path while
  // PGlite (real arrays) hid the difference in tests. json is parsed by BOTH
  // drivers, and an unusable column payload now FAILS CLOSED instead of skip.
  const fks = await q(
    `SELECT conname,
            conrelid::regclass::text AS child,
            confrelid::regclass::text AS parent,
            (SELECT coalesce(json_agg(a.attname ORDER BY x.ord), '[]'::json)
               FROM unnest(conkey) WITH ORDINALITY AS x(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = x.attnum) AS child_cols,
            (SELECT coalesce(json_agg(a.attname ORDER BY x.ord), '[]'::json)
               FROM unnest(confkey) WITH ORDINALITY AS x(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = confrelid AND a.attnum = x.attnum) AS parent_cols
       FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
  );
  const fkOrphans: OrphanedFk[] = [];
  const fkUnverifiable: Array<{ readonly constraint: string; readonly reason: string }> = [];
  let fkConstraintsChecked = 0;
  for (const fk of fks) {
    const child = String(fk["child"]);
    const parent = String(fk["parent"]);
    const childCols = fk["child_cols"];
    const parentCols = fk["parent_cols"];
    if (!Array.isArray(childCols) || !Array.isArray(parentCols)) {
      // FAIL CLOSED: a constraint whose column payload is not an array means
      // the driver serialization changed — reporting "no orphans" without
      // having looked would be a fabricated finding.
      throw new Error(
        `verifyEnvironment: fk ${String(fk["conname"])} returned non-array column payload (${typeof childCols}/${typeof parentCols}) — refusing to report an unverified scan`,
      );
    }
    fkConstraintsChecked += 1;
    const predicate = (childCols as string[])
      .map((c, i) => `p."${(parentCols as string[])[i]!}" IS NOT DISTINCT FROM c."${c}"`)
      .join(" AND ");
    const notNull = (childCols as string[]).map((c) => `c."${c}" IS NOT NULL`).join(" AND ");
    try {
      const rows = await q(
        `SELECT COUNT(*)::bigint AS n FROM ${child} c
          WHERE (${notNull}) AND NOT EXISTS (SELECT 1 FROM ${parent} p WHERE ${predicate})`,
      );
      const n = Number((rows[0] as Record<string, unknown>)["n"]);
      if (n > 0) {
        fkOrphans.push({
          constraint: String(fk["conname"]),
          child,
          parent,
          orphaned: n,
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "42501") {
        // Least-privilege connection: the constraint exists in the catalog
        // but the rows are not readable to this role. Recorded, never a
        // silent skip and never counted as drift.
        fkUnverifiable.push({ constraint: String(fk["conname"]), reason: "nopriv" });
      } else {
        throw err;
      }
    }
  }

  const drift =
    unmigrated.length > 0 || phantomLedgerEntries.length > 0 || fkOrphans.length > 0;

  return {
    identity,
    unmigrated,
    phantomLedgerEntries,
    tableCounts,
    privileges: grants.map((g) => ({
      table: String(g["table_name"]),
      privs: String(g["privs"]),
    })),
    fkOrphans,
    fkUnverifiable,
    fkConstraintsChecked,
    drift,
  };
}
