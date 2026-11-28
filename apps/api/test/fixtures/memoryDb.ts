/**
 * The Supabase clients, kept in memory, for tests of code that reads and writes a few rows: tables
 * of rows that the usual filters narrow, with insert, upsert, update and delete, and database
 * functions acted out by the test (`rpc`). One world is shared by the signed-in person's client and
 * the server's, so nothing here stands in for row-level security: supabase/tests does that.
 */
export type Row = Record<string, any>;

export interface MemoryDb {
  tables: Record<string, Row[]>;
  /** The columns that make a row unique, for upsert. */
  keys: Record<string, string[]>;
  rpc: Record<string, (args: Row, db: MemoryDb) => unknown>;
  /** Every function called, in order. */
  rpcs: Array<{ fn: string; args: Row }>;
  /** Files in storage, by path. */
  files: Record<string, Uint8Array>;
}

export const memoryDb = (tables: Record<string, Row[]> = {}, keys: Record<string, string[]> = {}): MemoryDb => ({ tables, keys, rpc: {}, rpcs: [], files: {} });

/** `source` and `claims` may be functions, read at each use: a test can swap the world, or who is signed in, between requests. */
export function memoryClient(source: MemoryDb | (() => MemoryDb), who: Row | (() => Row) = { sub: "viewer" }) {
  const world = () => (typeof source === "function" ? source() : source);
  return {
    auth: { getClaims: async () => ({ data: { claims: typeof who === "function" ? who() : who }, error: null }) },
    storage: {
      from: () => ({
        download: async (path: string) => (world().files[path] ? { data: new Blob([world().files[path]!]), error: null } : { data: null, error: { message: "not found" } }),
      }),
    },
    rpc: async (fn: string, args: Row = {}) => {
      const db = world();
      db.rpcs.push({ fn, args });
      // Rate limits have room unless the test says otherwise.
      const run = db.rpc[fn] ?? (fn === "rate_limit_hit" ? () => true : fn === "xero_ai_blocked" ? () => false : null);
      return run ? { data: await run(args, db), error: null } : { data: null, error: { message: `no function ${fn}` } };
    },
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
      let payload: Row | Row[] = {};
      let options: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      let returning = false;
      let limit = Infinity;
      const rows = () => (world().tables[table] ??= []);
      const run = (): Row[] => {
        const db = world();
        if (op === "select") return rows().filter((row) => filters.every((keep) => keep(row))).slice(0, limit).map((row) => ({ ...row }));
        if (op === "insert") {
          const added = (Array.isArray(payload) ? payload : [payload]).map((row) => ({ ...row }));
          rows().push(...added);
          return added;
        }
        if (op === "upsert") {
          const key = options.onConflict?.split(",").map((k) => k.trim()) ?? db.keys[table] ?? [];
          return (Array.isArray(payload) ? payload : [payload]).map((row) => {
            const existing = rows().find((r) => key.length > 0 && key.every((k) => r[k] === row[k]));
            if (existing && !options.ignoreDuplicates) Object.assign(existing, row);
            if (!existing) rows().push({ ...row });
            return { ...(existing ?? row) };
          });
        }
        const hit = rows().filter((row) => filters.every((keep) => keep(row)));
        if (op === "update") for (const row of hit) Object.assign(row, payload);
        else db.tables[table] = rows().filter((row) => !hit.includes(row));
        return hit.map((row) => ({ ...row }));
      };
      const builder: Row = {
        select: () => ((returning = true), builder),
        order: () => builder,
        limit: (n: number) => ((limit = n), builder),
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), builder),
        gt: (column: string, value: any) => (filters.push((row) => row[column] > value), builder),
        lt: (column: string, value: any) => (filters.push((row) => row[column] != null && row[column] < value), builder),
        // not(column, "in", "(a,b)"), as PostgREST spells it.
        not: (column: string, _op: string, list: string) => (filters.push((row) => !list.replace(/^\(|\)$/g, "").split(",").includes(String(row[column]))), builder),
        match: (want: Row) => (filters.push((row) => Object.entries(want).every(([k, v]) => row[k] === v)), builder),
        insert: (value: Row | Row[]) => ((op = "insert"), (payload = value), builder),
        upsert: (value: Row | Row[], o: typeof options = {}) => ((op = "upsert"), (payload = value), (options = o), builder),
        update: (value: Row) => ((op = "update"), (payload = value), builder),
        delete: () => ((op = "delete"), builder),
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        single: async () => {
          const found = run();
          return found.length === 1 ? { data: found[0], error: null } : { data: null, error: { message: "not one row" } };
        },
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => {
          const found = run();
          return Promise.resolve({ data: op === "select" || returning ? found : null, error: null, count: found.length }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}
