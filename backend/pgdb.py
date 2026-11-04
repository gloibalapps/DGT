"""Minimal Motor-compatible document store on Supabase Postgres (asyncpg).

Why: server.py / ue_guarantee.py make ~150 Motor calls. Re-implementing the
small subset of the Motor API they use on top of Postgres JSONB tables keeps
every route byte-for-byte identical (same document shapes, same ids) and makes
the Mongo -> Postgres move a data-layer swap instead of a rewrite.

Each table is ``(_pk bigint identity, doc jsonb, <generated key columns>)``;
see supabase/migrations/0001_init.sql. Supported subset:
  filters: equality (incl. None == missing/null), $in, $ne, $lt, $lte, $gt, $gte
  updates: $set, $setOnInsert, $addToSet (with $each)
  find(...).sort(field, dir).to_list(n) / async iteration, find_one(sort=...),
  insert_one/many, update_one/many(upsert), replace_one(upsert),
  delete_one/many.  Anything else raises NotImplementedError loudly.
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime
from typing import Optional

import asyncpg

COLLECTIONS = ("users", "user_sessions", "oauth_states", "waitlist", "profiles", "vehicles",
               "trips", "income", "expenses", "shifts", "drive_tokens", "ue_jobs")


def _default(o):
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    raise TypeError(f"not JSON serialisable: {type(o)}")


def dumps(doc: dict) -> str:
    return json.dumps(doc, default=_default)


class _Result:
    def __init__(self, n=0, upserted_id=None):
        self.modified_count = self.deleted_count = self.matched_count = n
        self.upserted_id = upserted_id
        self.inserted_id = upserted_id


def _field(f: str) -> str:
    if not f.replace("_", "").isalnum():
        raise ValueError(f"bad field {f!r}")
    return f"doc->'{f}'"


def _where(flt: dict, args: list) -> str:
    parts = []
    for f, cond in (flt or {}).items():
        if f == "_id":
            raise NotImplementedError("_id filters are not supported")
        j, t = _field(f), f"(doc->>'{f}')"
        if isinstance(cond, dict) and any(k.startswith("$") for k in cond):
            for op, v in cond.items():
                if op == "$in":
                    args.append(dumps(list(v)))
                    parts.append(f"{j} IN (SELECT jsonb_array_elements(${len(args)}::jsonb))")
                elif op == "$ne":
                    if v is None:
                        parts.append(f"({j} IS NOT NULL AND {j} <> 'null'::jsonb)")
                    else:
                        args.append(dumps(v))
                        parts.append(f"({j} IS NULL OR {j} <> ${len(args)}::jsonb)")
                elif op in ("$lt", "$lte", "$gt", "$gte"):
                    sym = {"$lt": "<", "$lte": "<=", "$gt": ">", "$gte": ">="}[op]
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        args.append(v)
                        parts.append(f"(jsonb_typeof({j}) = 'number' AND ({t})::float8 {sym} ${len(args)}::float8)")
                    else:
                        args.append(v.isoformat() if isinstance(v, (datetime, date)) else str(v))
                        parts.append(f"(jsonb_typeof({j}) = 'string' AND {t} COLLATE \"C\" {sym} ${len(args)}::text)")
                else:
                    raise NotImplementedError(f"filter operator {op}")
        elif cond is None:
            parts.append(f"({j} IS NULL OR {j} = 'null'::jsonb)")
        else:
            args.append(dumps(cond))
            parts.append(f"{j} = ${len(args)}::jsonb")
    return " AND ".join(parts) or "TRUE"


def _project(doc: dict, projection: Optional[dict]) -> dict:
    doc = dict(doc)
    if not projection:
        return doc
    p = {k: v for k, v in projection.items() if k != "_id"}
    if p and all(p.values()):
        return {k: doc[k] for k in p if k in doc}
    for k, v in p.items():
        if not v:
            doc.pop(k, None)
    return doc


def _apply_update(doc: dict, update: dict, inserting: bool) -> dict:
    doc = dict(doc)
    for op, vals in update.items():
        if op == "$set":
            doc.update(vals)
        elif op == "$setOnInsert":
            if inserting:
                doc.update(vals)
        elif op == "$addToSet":
            for k, v in vals.items():
                items = v["$each"] if isinstance(v, dict) and "$each" in v else [v]
                cur = list(doc.get(k) or [])
                for it in items:
                    if it not in cur:
                        cur.append(it)
                doc[k] = cur
        else:
            raise NotImplementedError(f"update operator {op}")
    return doc


def _order(sort) -> str:
    if not sort:
        return ""
    cols = []
    for f, d in sort:
        _field(f)
        cols.append(f"doc->>'{f}' COLLATE \"C\" {'ASC' if d >= 0 else 'DESC'} NULLS FIRST" if d >= 0
                    else f"doc->>'{f}' COLLATE \"C\" DESC NULLS LAST")
    return " ORDER BY " + ", ".join(cols)


class Cursor:
    def __init__(self, coll: "Collection", flt, projection):
        self._c, self._f, self._p, self._sort, self._limit = coll, flt, projection, [], None

    def sort(self, key, direction=1):
        self._sort = list(key) if isinstance(key, list) else [(key, direction)]
        return self

    def limit(self, n):
        self._limit = n
        return self

    async def to_list(self, length=None):
        n = length if length is not None else self._limit
        return await self._c._select(self._f, self._p, self._sort, n)

    def __aiter__(self):
        async def gen():
            for d in await self.to_list(None):
                yield d
        return gen()


class Collection:
    def __init__(self, db: "Database", name: str):
        self._db, self.name = db, name

    async def _select(self, flt, projection=None, sort=None, limit=None, conn=None):
        args: list = []
        sql = f"SELECT doc FROM public.{self.name} WHERE {_where(flt, args)}{_order(sort)}"
        if limit:
            sql += f" LIMIT {int(limit)}"
        rows = await (conn or await self._db.pool()).fetch(sql, *args)
        return [_project(json.loads(r["doc"]), projection) for r in rows]

    def find(self, flt=None, projection=None):
        return Cursor(self, flt or {}, projection)

    async def find_one(self, flt=None, projection=None, sort=None):
        r = await self._select(flt or {}, projection, sort, 1)
        return r[0] if r else None

    async def insert_one(self, doc: dict):
        doc.pop("_id", None)
        pool = await self._db.pool()
        await pool.execute(f"INSERT INTO public.{self.name}(doc) VALUES ($1::jsonb)", dumps(doc))
        return _Result(1)

    async def insert_many(self, docs):
        docs = [dumps({k: v for k, v in d.items() if k != "_id"}) for d in docs]
        if docs:
            pool = await self._db.pool()
            await pool.executemany(f"INSERT INTO public.{self.name}(doc) VALUES ($1::jsonb)",
                                   [(d,) for d in docs])
        return _Result(len(docs))

    async def _update(self, flt, update, upsert, many, replace=False):
        pool = await self._db.pool()
        async with pool.acquire() as conn, conn.transaction():
            args: list = []
            sql = f"SELECT _pk, doc FROM public.{self.name} WHERE {_where(flt, args)}"
            if not many:
                sql += " LIMIT 1"
            rows = await conn.fetch(sql + " FOR UPDATE", *args)
            for r in rows:
                new = dict(update) if replace else _apply_update(json.loads(r["doc"]), update, False)
                await conn.execute(f"UPDATE public.{self.name} SET doc=$1::jsonb WHERE _pk=$2",
                                   dumps(new), r["_pk"])
            if not rows and upsert:
                base = {k: v for k, v in (flt or {}).items() if not isinstance(v, dict)}
                new = dict(update) if replace else _apply_update(base, update, True)
                await conn.execute(f"INSERT INTO public.{self.name}(doc) VALUES ($1::jsonb)", dumps(new))
                return _Result(0, upserted_id=True)
            return _Result(len(rows))

    async def update_one(self, flt, update, upsert=False):
        return await self._update(flt, update, upsert, False)

    async def update_many(self, flt, update, upsert=False):
        return await self._update(flt, update, upsert, True)

    async def replace_one(self, flt, doc, upsert=False):
        doc = {k: v for k, v in doc.items() if k != "_id"}
        return await self._update(flt, doc, upsert, False, replace=True)

    async def _delete(self, flt, many):
        args: list = []
        w = _where(flt, args)
        sql = (f"DELETE FROM public.{self.name} WHERE {w}" if many else
               f"DELETE FROM public.{self.name} WHERE _pk = (SELECT _pk FROM public.{self.name} WHERE {w} LIMIT 1)")
        res = await (await self._db.pool()).execute(sql, *args)
        return _Result(int(res.split()[-1]))

    async def delete_one(self, flt):
        return await self._delete(flt, False)

    async def delete_many(self, flt):
        return await self._delete(flt, True)

    async def create_index(self, *a, **k):  # indexes live in the SQL migration
        return None


class Database:
    def __init__(self, dsn: Optional[str] = None):
        self._dsn = dsn or os.environ.get("SUPABASE_DB_URL", "")
        self._pool: Optional[asyncpg.Pool] = None
        for n in COLLECTIONS:
            setattr(self, n, Collection(self, n))

    def __getitem__(self, name: str) -> Collection:
        if name not in COLLECTIONS:
            raise KeyError(name)
        return getattr(self, name)

    async def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            if not self._dsn:
                raise RuntimeError("SUPABASE_DB_URL is not set")
            # statement_cache_size=0 keeps this safe behind Supavisor/pgbouncer
            # in transaction mode (port 6543).
            self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=10,
                                                   statement_cache_size=0)
        return self._pool

    async def close(self):
        if self._pool is not None:
            await self._pool.close()
            self._pool = None
