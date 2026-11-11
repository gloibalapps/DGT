/** Document store used by the edge API. Postgres implementation talks to schema gigtax. */

export type Doc = Record<string, unknown>;
export type Filter = Record<string, unknown>;
export type Update = Record<string, Record<string, unknown>>;

export interface WriteResult {
  modified_count: number;
  deleted_count: number;
  matched_count: number;
}

export interface Cursor {
  sort(key: string | [string, number][], dir?: number): Cursor;
  toList(n?: number): Promise<Doc[]>;
}

export interface Collection {
  find(flt?: Filter): Cursor;
  findOne(flt?: Filter): Promise<Doc | null>;
  insertOne(doc: Doc): Promise<WriteResult>;
  insertMany(docs: Doc[]): Promise<WriteResult>;
  updateOne(flt: Filter, update: Update, upsert?: boolean): Promise<WriteResult>;
  updateMany(flt: Filter, update: Update): Promise<WriteResult>;
  deleteOne(flt: Filter): Promise<WriteResult>;
  deleteMany(flt: Filter): Promise<WriteResult>;
}

export interface Db {
  users: Collection;
  user_sessions: Collection;
  oauth_states: Collection;
  waitlist: Collection;
  profiles: Collection;
  vehicles: Collection;
  trips: Collection;
  income: Collection;
  expenses: Collection;
  shifts: Collection;
  drive_tokens: Collection;
  ue_jobs: Collection;
  trial_claims: Collection;
  col(name: string): Collection;
}

const NAMES = [
  "users", "user_sessions", "oauth_states", "waitlist", "profiles", "vehicles",
  "trips", "income", "expenses", "shifts", "drive_tokens", "ue_jobs", "trial_claims",
] as const;

export function matchDoc(doc: Doc, flt: Filter | undefined): boolean {
  for (const [key, cond] of Object.entries(flt ?? {})) {
    const val = doc[key];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, expected] of Object.entries(cond as Record<string, unknown>)) {
        if (op === "$lt" || op === "$lte" || op === "$gt" || op === "$gte") {
          if (val == null) return false;
          const left = val instanceof Date ? val.toISOString() : val;
          const right = expected instanceof Date ? expected.toISOString() : expected;
          if (typeof left === "number" && typeof right === "number") {
            if (op === "$lt" && !(left < right)) return false;
            if (op === "$lte" && !(left <= right)) return false;
            if (op === "$gt" && !(left > right)) return false;
            if (op === "$gte" && !(left >= right)) return false;
          } else {
            const ls = String(left);
            const rs = String(right);
            if (op === "$lt" && !(ls < rs)) return false;
            if (op === "$lte" && !(ls <= rs)) return false;
            if (op === "$gt" && !(ls > rs)) return false;
            if (op === "$gte" && !(ls >= rs)) return false;
          }
        } else if (op === "$in") {
          if (!(expected as unknown[]).includes(val)) return false;
        } else if (op === "$ne") {
          if (expected == null) {
            if (val == null) return false;
          } else if (val === expected) return false;
        } else {
          throw new Error(`filter operator ${op}`);
        }
      }
    } else if (cond == null) {
      if (val != null) return false;
    } else if (val !== cond) return false;
  }
  return true;
}

function applyUpdate(doc: Doc, update: Update, inserting: boolean): Doc {
  const next = { ...doc };
  for (const [op, vals] of Object.entries(update)) {
    if (op === "$set") Object.assign(next, vals);
    else if (op === "$setOnInsert") {
      if (inserting) Object.assign(next, vals);
    } else throw new Error(`update operator ${op}`);
  }
  return next;
}

class MemCursor implements Cursor {
  private rows: Doc[];
  constructor(rows: Doc[]) {
    this.rows = rows;
  }
  sort(key: string | [string, number][], dir = 1): Cursor {
    const spec: [string, number][] = Array.isArray(key) ? key : [[key, dir]];
    this.rows.sort((a, b) => {
      for (const [k, d] of spec) {
        const av = String(a[k] ?? "");
        const bv = String(b[k] ?? "");
        if (av < bv) return d >= 0 ? -1 : 1;
        if (av > bv) return d >= 0 ? 1 : -1;
      }
      return 0;
    });
    return this;
  }
  toList(n?: number): Promise<Doc[]> {
    const rows = n == null ? this.rows : this.rows.slice(0, n);
    return Promise.resolve(rows.map((d) => ({ ...d })));
  }
}

class MemColl implements Collection {
  docs: Doc[] = [];
  find(flt?: Filter): Cursor {
    return new MemCursor(this.docs.filter((d) => matchDoc(d, flt)).map((d) => ({ ...d })));
  }
  findOne(flt?: Filter): Promise<Doc | null> {
    const hit = this.docs.find((d) => matchDoc(d, flt));
    return Promise.resolve(hit ? { ...hit } : null);
  }
  insertOne(doc: Doc): Promise<WriteResult> {
    this.docs.push({ ...doc });
    return Promise.resolve({ modified_count: 1, deleted_count: 1, matched_count: 1 });
  }
  insertMany(docs: Doc[]): Promise<WriteResult> {
    for (const d of docs) this.docs.push({ ...d });
    return Promise.resolve({ modified_count: docs.length, deleted_count: docs.length, matched_count: docs.length });
  }
  updateOne(flt: Filter, update: Update, upsert = false): Promise<WriteResult> {
    return this.update(flt, update, upsert, false);
  }
  updateMany(flt: Filter, update: Update): Promise<WriteResult> {
    return this.update(flt, update, false, true);
  }
  private update(flt: Filter, update: Update, upsert: boolean, many: boolean): Promise<WriteResult> {
    const hits = this.docs.filter((d) => matchDoc(d, flt));
    const chosen = many ? hits : hits.slice(0, 1);
    for (const d of chosen) Object.assign(d, applyUpdate(d, update, false));
    if (!chosen.length && upsert) {
      const base: Doc = {};
      for (const [k, v] of Object.entries(flt)) {
        if (v == null || typeof v !== "object") base[k] = v;
      }
      this.docs.push(applyUpdate(base, update, true));
    }
    const n = chosen.length;
    return Promise.resolve({ modified_count: n, deleted_count: n, matched_count: n });
  }
  deleteOne(flt: Filter): Promise<WriteResult> {
    const i = this.docs.findIndex((d) => matchDoc(d, flt));
    if (i >= 0) this.docs.splice(i, 1);
    const n = i >= 0 ? 1 : 0;
    return Promise.resolve({ modified_count: n, deleted_count: n, matched_count: n });
  }
  deleteMany(flt: Filter): Promise<WriteResult> {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matchDoc(d, flt));
    const n = before - this.docs.length;
    return Promise.resolve({ modified_count: n, deleted_count: n, matched_count: n });
  }
}

export class MemoryDb implements Db {
  private cols = new Map<string, MemColl>();
  constructor() {
    for (const n of NAMES) this.cols.set(n, new MemColl());
  }
  col(name: string): Collection {
    const c = this.cols.get(name);
    if (!c) throw new Error(`unknown collection ${name}`);
    return c;
  }
  get users() { return this.col("users"); }
  get user_sessions() { return this.col("user_sessions"); }
  get oauth_states() { return this.col("oauth_states"); }
  get waitlist() { return this.col("waitlist"); }
  get profiles() { return this.col("profiles"); }
  get vehicles() { return this.col("vehicles"); }
  get trips() { return this.col("trips"); }
  get income() { return this.col("income"); }
  get expenses() { return this.col("expenses"); }
  get shifts() { return this.col("shifts"); }
  get drive_tokens() { return this.col("drive_tokens"); }
  get ue_jobs() { return this.col("ue_jobs"); }
  get trial_claims() { return this.col("trial_claims"); }
}

/** Live store. Uses SUPABASE_DB_URL and schema gigtax. Not imported by tests. */
export async function openPostgres(dsn: string): Promise<Db> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(dsn, { prepare: false, max: 1 }) as {
    unsafe: (q: string, args?: unknown[]) => Promise<Record<string, unknown>[]>;
  };
  const coll = (name: string): Collection => ({
    find(flt?: Filter) {
      let order = "";
      const cursor: Cursor = {
        sort(key, dir = 1) {
          const spec: [string, number][] = Array.isArray(key) ? key : [[key, dir]];
          order = spec.map(([k, d]) => `doc->>'${safeField(k)}' collate "C" ${d >= 0 ? "asc" : "desc"}`).join(", ");
          return cursor;
        },
        async toList(n?: number) {
          const where = whereSql(flt);
          const q = `select doc from gigtax.${safeField(name)} where ${where.sql}${order ? " order by " + order : ""}${n ? " limit " + Number(n) : ""}`;
          const rows = await sql.unsafe(q, where.args);
          return rows.map((r) => r.doc as Doc);
        },
      };
      return cursor;
    },
    async findOne(flt?: Filter) {
      const rows = await this.find(flt).toList(1);
      return rows[0] ?? null;
    },
    async insertOne(doc: Doc) {
      await sql.unsafe(`insert into gigtax.${safeField(name)}(doc) values ($1::jsonb)`, [JSON.stringify(doc)]);
      return { modified_count: 1, deleted_count: 1, matched_count: 1 };
    },
    async insertMany(docs: Doc[]) {
      for (const d of docs) await this.insertOne(d);
      return { modified_count: docs.length, deleted_count: docs.length, matched_count: docs.length };
    },
    updateOne(flt: Filter, update: Update, upsert = false) {
      return updateRows(sql, name, flt, update, upsert, false);
    },
    updateMany(flt: Filter, update: Update) {
      return updateRows(sql, name, flt, update, false, true);
    },
    async deleteOne(flt: Filter) {
      const where = whereSql(flt);
      const rows = await sql.unsafe(
        `delete from gigtax.${safeField(name)} where _pk = (select _pk from gigtax.${safeField(name)} where ${where.sql} limit 1) returning _pk`,
        where.args,
      );
      const n = rows.length;
      return { modified_count: n, deleted_count: n, matched_count: n };
    },
    async deleteMany(flt: Filter) {
      const where = whereSql(flt);
      const rows = await sql.unsafe(`delete from gigtax.${safeField(name)} where ${where.sql} returning _pk`, where.args);
      const n = rows.length;
      return { modified_count: n, deleted_count: n, matched_count: n };
    },
  });
  const db = {} as Db;
  for (const n of NAMES) (db as unknown as Record<string, Collection>)[n] = coll(n);
  db.col = (name) => coll(name);
  return db;
}

function safeField(f: string): string {
  if (!/^[a-z_]+$/i.test(f)) throw new Error(`bad field ${f}`);
  return f;
}

function whereSql(flt: Filter | undefined): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  for (const [f, cond] of Object.entries(flt ?? {})) {
    const field = safeField(f);
    const j = `doc->'${field}'`;
    if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
      for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
        if (op === "$in") {
          args.push(JSON.stringify(v));
          parts.push(`${j} in (select jsonb_array_elements($${args.length}::jsonb))`);
        } else if (op === "$ne") {
          if (v == null) parts.push(`(${j} is not null and ${j} <> 'null'::jsonb)`);
          else {
            args.push(JSON.stringify(v));
            parts.push(`(${j} is null or ${j} <> $${args.length}::jsonb)`);
          }
        } else if (op === "$lt" || op === "$lte" || op === "$gt" || op === "$gte") {
          const sym = { $lt: "<", $lte: "<=", $gt: ">", $gte: ">=" }[op];
          args.push(v instanceof Date ? v.toISOString() : String(v));
          parts.push(`(doc->>'${field}') collate "C" ${sym} $${args.length}::text`);
        } else throw new Error(`filter operator ${op}`);
      }
    } else if (cond == null) parts.push(`(${j} is null or ${j} = 'null'::jsonb)`);
    else {
      args.push(JSON.stringify(cond));
      parts.push(`${j} = $${args.length}::jsonb`);
    }
  }
  return { sql: parts.join(" and ") || "true", args };
}

async function updateRows(
  sql: { unsafe: (q: string, args?: unknown[]) => Promise<Record<string, unknown>[]> },
  name: string,
  flt: Filter,
  update: Update,
  upsert: boolean,
  many: boolean,
): Promise<WriteResult> {
  const where = whereSql(flt);
  const limit = many ? "" : " limit 1";
  const rows = await sql.unsafe(
    `select _pk, doc from gigtax.${safeField(name)} where ${where.sql}${limit}`,
    where.args,
  );
  for (const r of rows) {
    const next = applyUpdate(r.doc as Doc, update, false);
    await sql.unsafe(`update gigtax.${safeField(name)} set doc = $1::jsonb where _pk = $2`, [JSON.stringify(next), r._pk]);
  }
  if (!rows.length && upsert) {
    const base: Doc = {};
    for (const [k, v] of Object.entries(flt)) {
      if (v == null || typeof v !== "object") base[k] = v;
    }
    await sql.unsafe(`insert into gigtax.${safeField(name)}(doc) values ($1::jsonb)`, [JSON.stringify(applyUpdate(base, update, true))]);
  }
  const n = rows.length;
  return { modified_count: n, deleted_count: n, matched_count: n };
}
