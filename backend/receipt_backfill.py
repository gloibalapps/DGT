"""One-off fill of receipt hashes and normalised fields.

Safe to run twice. The second run updates nothing. It does not call the vision
model and it does not deploy anything.

  SUPABASE_DB_URL=... python -m receipt_backfill
  SUPABASE_DB_URL=... python -m receipt_backfill --schema gigtax

``public`` is the FastAPI schema on this branch. ``gigtax`` is the schema the
Edge Function in PR #2 uses. There is no new secret: this uses SUPABASE_DB_URL.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

import receipt_dupes

SCHEMAS = ("public", "gigtax")


def qualify_schema(schema: str) -> str:
    if schema not in SCHEMAS:
        raise ValueError("schema must be public or gigtax")
    return schema


async def backfill_schema(dsn: str, schema: str) -> dict:
    import asyncpg

    schema = qualify_schema(schema)
    conn = await asyncpg.connect(dsn)
    updated = 0
    seen = 0
    try:
        rows = await conn.fetch(
            f"select _pk, doc from {schema}.expenses where coalesce(doc->>'receipt_image', '') <> ''")
        for row in rows:
            seen += 1
            doc = json.loads(row["doc"])
            result = receipt_dupes.backfill_documents([doc])
            if not result["updated"]:
                continue
            new = result["documents"][0]
            new.pop("_time_mins", None)
            await conn.execute(
                f"update {schema}.expenses set doc = $1::jsonb where _pk = $2",
                json.dumps(new), row["_pk"])
            updated += 1
    finally:
        await conn.close()
    return {"seen": seen, "updated": updated, "unchanged": seen - updated}


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(description="Backfill receipt duplicate fields")
    parser.add_argument("--schema", default="public", choices=SCHEMAS)
    args = parser.parse_args(argv)
    dsn = os.environ.get("SUPABASE_DB_URL", "")
    if not dsn:
        print("SUPABASE_DB_URL is not set", file=sys.stderr)
        return 2
    result = asyncio.run(backfill_schema(dsn, args.schema))
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
