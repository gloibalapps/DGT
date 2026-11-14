import { handle } from "../_shared/app.ts";
import { openPostgres } from "../_shared/db.ts";
import type { Db } from "../_shared/db.ts";

let dbPromise: Promise<Db> | null = null;

function database(): Promise<Db> {
  const dsn = Deno.env.get("SUPABASE_DB_URL") ?? "";
  if (!dsn) return Promise.reject(new Error("SUPABASE_DB_URL is not set"));
  dbPromise ??= openPostgres(dsn);
  return dbPromise;
}

Deno.serve(async (req) => {
  try {
    const db = await database();
    return await handle(req, { db });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ detail: "Database is not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
