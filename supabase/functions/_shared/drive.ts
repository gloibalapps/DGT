/** Google Drive backup. Tokens are Fernet tokens, compatible with cryptography.fernet. */
import { fernetDecrypt, fernetEncrypt } from "./fernet.ts";
import type { Db, Doc } from "./db.ts";

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export class HttpError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

export async function encryptToken(key: string, value: string): Promise<string> {
  return await fernetEncrypt(key, value);
}
export async function decryptToken(key: string, value: string): Promise<string> {
  return await fernetDecrypt(key, value);
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function backupCsv(income: Doc[], expenses: Doc[], trips: Doc[]): Uint8Array {
  const lines: unknown[][] = [["Type", "Date", "Amount / Distance", "Category / Platform", "Merchant / Note", "Vehicle"]];
  for (const i of income) lines.push(["Income", i.date, i.amount, i.platform ?? "", i.note ?? "", i.vehicle_id ?? ""]);
  for (const e of expenses) lines.push(["Expense", e.date, e.amount, e.category ?? "", e.merchant || e.note || "", e.vehicle_id ?? ""]);
  for (const t of trips) lines.push(["Trip", t.date, t.distance_km, t.type ?? "", t.purpose ?? "", t.vehicle_id ?? ""]);
  return new TextEncoder().encode(lines.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n");
}

export async function saveDriveTokens(db: Db, key: string, profileId: string, tok: Doc, email: string, now: string): Promise<void> {
  if (!key) return;
  const upd: Doc = {
    profile_id: profileId, email,
    access_token: await encryptToken(key, String(tok.access_token ?? "")),
    access_expires_at: Date.now() / 1000 + Number(tok.expires_in ?? 3600),
    scopes: String(tok.scope ?? "").split(" ").filter(Boolean),
    needs_reauth: false, updated_at: now,
  };
  if (tok.refresh_token) upd.refresh_token = await encryptToken(key, String(tok.refresh_token));
  await db.drive_tokens.updateOne({ profile_id: profileId }, { $set: upd }, true);
}

async function accessToken(db: Db, key: string, profileId: string, env: Record<string, string | undefined>, fetch: FetchFn): Promise<string> {
  const row = await db.drive_tokens.findOne({ profile_id: profileId });
  if (!row?.refresh_token) throw new HttpError(409, "Google Drive not connected");
  if (!key) throw new HttpError(503, "Backups aren't configured on the server (DRIVE_ENCRYPTION_KEY missing)");
  if (Number(row.access_expires_at ?? 0) > Date.now() / 1000 + 60) return await decryptToken(key, String(row.access_token));
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? "", client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: await decryptToken(key, String(row.refresh_token)), grant_type: "refresh_token",
    }),
  });
  if (!r.ok) {
    let err = "";
    try { err = (await r.json()).error; } catch { /* ignore */ }
    if (r.status === 400 && err === "invalid_grant") {
      await db.drive_tokens.updateOne({ profile_id: profileId }, { $set: { needs_reauth: true } });
    }
    throw new HttpError(502, "Google Drive access expired — tap Connect Google Drive again");
  }
  const neu = await r.json();
  await db.drive_tokens.updateOne({ profile_id: profileId }, { $set: {
    access_token: await encryptToken(key, neu.access_token),
    access_expires_at: Date.now() / 1000 + Number(neu.expires_in ?? 3600),
    updated_at: new Date().toISOString(), needs_reauth: false,
  } });
  return neu.access_token as string;
}

async function driveGet(fetch: FetchFn, token: string, params: Record<string, string>): Promise<Doc> {
  const url = `${DRIVE_API}?${new URLSearchParams(params)}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new HttpError(502, `Google Drive error ${r.status}`);
  return await r.json();
}

async function folder(fetch: FetchFn, token: string, name: string, parent?: string): Promise<string> {
  const parentClause = parent ? `'${parent}' in parents` : "'root' in parents";
  const q = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and ${parentClause} and trashed = false`;
  const found = await driveGet(fetch, token, { q, spaces: "drive", pageSize: "1", fields: "files(id)" });
  const files = (found.files as Doc[]) ?? [];
  if (files.length) return String(files[0].id);
  const meta: Doc = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parent) meta.parents = [parent];
  const r = await fetch(`${DRIVE_API}?fields=id`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(meta),
  });
  if (!r.ok) throw new HttpError(502, `Google Drive error ${r.status}`);
  return String((await r.json()).id);
}

async function findFile(fetch: FetchFn, token: string, folderId: string, name: string): Promise<string | null> {
  const safe = name.replaceAll("'", "\\'");
  const q = `name = '${safe}' and '${folderId}' in parents and trashed = false`;
  const found = await driveGet(fetch, token, { q, spaces: "drive", pageSize: "1", fields: "files(id)" });
  const files = (found.files as Doc[]) ?? [];
  return files.length ? String(files[0].id) : null;
}

async function upload(fetch: FetchFn, token: string, content: Uint8Array, filename: string, mime: string, parent: string, fileId?: string | null): Promise<void> {
  const boundary = `===${crypto.randomUUID().replaceAll("-", "")}`;
  const meta: Doc = { name: filename };
  if (parent && !fileId) meta.parents = [parent];
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const h = new TextEncoder().encode(head);
  const t = new TextEncoder().encode(tail);
  const body = new Uint8Array(h.length + content.length + t.length);
  body.set(h, 0);
  body.set(content, h.length);
  body.set(t, h.length + content.length);
  const url = fileId ? `${DRIVE_UPLOAD}/${fileId}` : DRIVE_UPLOAD;
  const r = await fetch(`${url}?uploadType=multipart&fields=id,name`, {
    method: fileId ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary="${boundary}"` },
    body,
  });
  if (!r.ok) throw new HttpError(502, `Google Drive error ${r.status}`);
}

function b64(s: string): Uint8Array {
  const raw = s.includes(",") && s.trim().startsWith("data:") ? s.split(",", 2)[1] : s;
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export async function backupProfile(db: Db, key: string, profileId: string, env: Record<string, string | undefined>, fetch: FetchFn, now: string): Promise<Doc> {
  const token = await accessToken(db, key, profileId, env, fetch);
  const root = await folder(fetch, token, "GigTax Backups");
  const list = async (name: string, n = 10000) => await db.col(name).find({ profile_id: profileId }).toList(n);
  const income = await list("income");
  const expenses = await list("expenses");
  const trips = await list("trips");
  const vehicles = await list("vehicles");
  const shifts = await list("shifts");
  const ue = await list("ue_jobs", 20000);
  const payload = new TextEncoder().encode(JSON.stringify({ version: 2, exported_at: now, income, expenses, trips, vehicles, shifts, ue_jobs: ue }));
  await upload(fetch, token, payload, "gigtax-data.json", "application/json", root, await findFile(fetch, token, root, "gigtax-data.json"));
  await upload(fetch, token, backupCsv(income, expenses, trips), "gigtax-data.csv", "text/csv", root, await findFile(fetch, token, root, "gigtax-data.csv"));
  const row = await db.drive_tokens.findOne({ profile_id: profileId });
  const done = new Set<string>((row?.uploaded_receipts as string[]) ?? []);
  const todo = expenses.filter((e) => e.receipt_image && !done.has(String(e.id)));
  const months = new Map<string, string>();
  const uploaded: string[] = [];
  for (const e of todo) {
    let data: Uint8Array;
    try { data = b64(String(e.receipt_image)); } catch { continue; }
    const month = String(e.date ?? "").slice(0, 7) || "undated";
    if (!months.has(month)) months.set(month, await folder(fetch, token, month, root));
    const fname = `receipt-${e.date ?? ""}-${String(e.id ?? "").slice(0, 8)}.jpg`;
    const folderId = months.get(month)!;
    await upload(fetch, token, data, fname, "image/jpeg", folderId, await findFile(fetch, token, folderId, fname));
    uploaded.push(String(e.id));
  }
  if (uploaded.length) await db.drive_tokens.updateOne({ profile_id: profileId }, { $addToSet: { uploaded_receipts: { $each: uploaded } } });
  const receipts = [...done].filter((id) => expenses.some((e) => String(e.id) === id)).length + uploaded.length;
  await db.drive_tokens.updateOne({ profile_id: profileId }, { $set: { last_backup_at: now, last_backup_count: receipts, backup_state: "done", last_error: null } });
  return { backed_up_at: now, receipts, records: income.length + expenses.length + trips.length };
}

export async function restoreProfile(db: Db, key: string, profileId: string, env: Record<string, string | undefined>, fetch: FetchFn): Promise<Doc> {
  const token = await accessToken(db, key, profileId, env, fetch);
  const root = await folder(fetch, token, "GigTax Backups");
  const fid = await findFile(fetch, token, root, "gigtax-data.json");
  if (!fid) throw new HttpError(404, "No restorable backup found in Drive. Back up on your old device first.");
  const r = await fetch(`${DRIVE_API}/${fid}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new HttpError(502, `Google Drive error ${r.status}`);
  let payload: Doc;
  try { payload = JSON.parse(await r.text()); } catch { throw new HttpError(422, "Backup file is unreadable"); }
  const counts: Record<string, number> = { income: 0, expenses: 0, trips: 0, vehicles: 0, shifts: 0, ue_jobs: 0 };
  for (const name of Object.keys(counts)) {
    const col = db.col(name);
    for (const it of (payload[name] as Doc[]) ?? []) {
      if (!it || typeof it !== "object" || !it.id) continue;
      const doc: Doc = { ...it, profile_id: profileId };
      delete doc._id;
      const cur = await col.findOne({ id: doc.id });
      if (cur && cur.profile_id !== profileId) continue;
      if (cur) await col.deleteOne({ id: doc.id, profile_id: profileId });
      await col.insertOne(doc);
      counts[name] += 1;
    }
  }
  return { restored: counts, exported_at: payload.exported_at, total: Object.values(counts).reduce((a, n) => a + n, 0) };
}

export function backupErrorText(e: unknown): string {
  if (e instanceof HttpError) return e.detail;
  return "Backup failed — check your connection and try again";
}
