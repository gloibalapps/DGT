/**
 * Ready-to-apply port for PR #2 (branch cursor/supabase-edge-api-bc8b).
 *
 * The Edge app is not on migrate-off-emergent, so this PR does not edit
 * supabase/functions/_shared/app.ts. Copy this file to
 * supabase/functions/_shared/receipt_dupes.ts and wire it as follows.
 *
 * app.ts scan(), after the image is decoded and BEFORE the Anthropic fetch:
 *   const bytes = base64ToBytes(img);
 *   const rows = await deps.db.expenses.find({ profile_id: owner.profileId }).toList(2000);
 *   const plan = await planPaidScan(bytes, rows);
 *   if (plan.skip) return json({ ...fieldsFrom(plan.duplicate.match), scan_skipped: true, duplicate: plan.duplicate });
 *   // only then fetch https://api.anthropic.com/v1/messages
 * Extend the vision prompt with txn_time, receipt_number, abn, card_last4, pump.
 *
 * route(), before the crud regex (otherwise /api/expenses/check is treated as an id):
 *   if (method === "POST" && path === "/api/expenses/check") return check route
 *   if (method === "POST" && path === "/api/expenses/backfill") return backfill route
 *
 * resource() POST and PUT for name === "expenses":
 *   const stored = enrichExpense(doc);
 *   const report = matchExpense(stored, existingRows, keepWith);
 *   insert/update stored, then return { ...stored, duplicate: report.level ? report : null };
 *   never respond 409 for a likely or possible match.
 *
 * SQL, new migration (0003 is already gigtax_api_schema on that branch):
 *   alter table gigtax.expenses add column if not exists amount_cents integer
 *     generated always as (
 *       case when coalesce(doc->>'amount_cents','') ~ '^-?[0-9]+$'
 *         then (doc->>'amount_cents')::integer else null end) stored;
 *   create index if not exists expenses_profile_date_amount_idx
 *     on gigtax.expenses (profile_id, date collate "C", amount_cents);
 *
 * Image bytes are hashed here with Web Crypto. Perceptual hashes need pixels;
 * pass rgba from a decoder, or store the phone's client_dhash / client_ahash.
 * The one-off image backfill is `python -m receipt_backfill --schema gigtax`.
 * No new secret.
 */

export const PHASH_STRONG_MAX = 8;
export const LIKELY_MINUTES = 5;
export const FUEL_DISTINCT_MINUTES = 10;

export type Doc = Record<string, unknown>;

const RANK: Record<string, number> = {
  exact_image: 70, perceptual: 60, receipt_abn: 50, receipt_merchant: 40,
  amount_date_merchant_time: 30, amount_date_merchant_card: 20, amount_merchant_day_off: 10,
};
const TRACKED = [
  "image_sha256", "image_dhash", "image_dhash_rots", "image_ahash", "image_ahash_rots",
  "client_dhash", "client_dhash_rots", "client_ahash", "client_ahash_rots",
  "amount_cents", "norm_date", "norm_time", "norm_abn", "norm_receipt_number",
  "merchant_key", "norm_card_last4", "norm_litres", "norm_pump",
];

export function hammingHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let n = 0;
  const x = BigInt("0x" + a) ^ BigInt("0x" + b);
  const bits = x.toString(2);
  for (const ch of bits) if (ch === "1") n++;
  return n;
}

function usable(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/.test(value)) return false;
  const bits = hammingHex(value, "0000000000000000");
  return bits >= 8 && bits <= 56;
}

export function resizeBox(luma: number[], width: number, height: number, tw: number, th: number): number[] {
  const out = new Array<number>(tw * th);
  let n = 0;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * height) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * width) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / tw));
      let acc = 0, count = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx < x1; xx++) { acc += luma[row + xx]; count++; }
      }
      out[n++] = Math.floor(acc / count);
    }
  }
  return out;
}

function bitsToHex(bits: number[]): string {
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) nibble = (nibble << 1) | (bits[i + b] ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

export function dhashLuma(luma: number[], width: number, height: number): string {
  const small = resizeBox(luma, width, height, 9, 8);
  const bits: number[] = [];
  for (let row = 0; row < 8; row++) {
    const base = row * 9;
    for (let col = 0; col < 8; col++) bits.push(small[base + col] > small[base + col + 1] ? 1 : 0);
  }
  return bitsToHex(bits);
}

export function ahashLuma(luma: number[], width: number, height: number): string {
  const small = resizeBox(luma, width, height, 8, 8);
  const avg = Math.floor(small.reduce((s, p) => s + p, 0) / 64);
  return bitsToHex(small.map((p) => (p > avg ? 1 : 0)));
}

function rot90(luma: number[], width: number, height: number) {
  const nw = height;
  const out = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[x * nw + (height - 1 - y)] = luma[y * width + x];
  }
  return { luma: out, width: nw, height: width };
}

export function hashLuma(luma: number[], width: number, height: number) {
  const dhashRots: string[] = [];
  const ahashRots: string[] = [];
  let cur = luma, w = width, h = height;
  for (let i = 0; i < 4; i++) {
    dhashRots.push(dhashLuma(cur, w, h));
    ahashRots.push(ahashLuma(cur, w, h));
    const next = rot90(cur, w, h);
    cur = next.luma; w = next.width; h = next.height;
  }
  return { image_dhash: dhashRots[0], image_dhash_rots: dhashRots, image_ahash: ahashRots[0], image_ahash_rots: ahashRots };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function amountCents(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function normDate(value: unknown): string | null {
  const s = String(value ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) {
    const au = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (!au) return null;
    m = [s, au[3], au[2], au[1]];
  }
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseMins(value: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?$/i.exec(String(value ?? "").trim());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59) return null;
  const ap = m[3]?.toUpperCase();
  if (ap) {
    if (hour < 1 || hour > 12) return null;
    if (ap === "AM") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) return null;
  return hour * 60 + minute;
}

function hhmm(mins: number | null): string | null {
  if (mins == null) return null;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function normAbn(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

function normReceipt(value: unknown): string | null {
  const alnum = String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return alnum || null;
}

function merchantKey(value: unknown): string | null {
  const stop = new Set(["PTY", "LTD", "LIMITED", "THE", "AND", "CO"]);
  const tokens = String(value ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t && !stop.has(t));
  return tokens.join("") || null;
}

function normCard(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function normLitres(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function normPump(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits) return digits.replace(/^0+/, "") || "0";
  const alnum = String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return alnum || null;
}

export function isRefund(doc: Doc): boolean {
  if (doc.refund === true) return true;
  const cents = typeof doc.amount_cents === "number" ? doc.amount_cents : amountCents(doc.amount);
  if (typeof cents === "number" && cents < 0) return true;
  return /\brefunds?\b/i.test(`${doc.merchant ?? ""} ${doc.note ?? ""} ${doc.category ?? ""}`);
}

export function normaliseFields(doc: Doc): Doc {
  const mins = parseMins(doc.txn_time ?? doc.time ?? doc.norm_time);
  const litres = doc.liters != null ? normLitres(doc.liters) : doc.litres != null ? normLitres(doc.litres) : normLitres(doc.norm_litres);
  return {
    amount_cents: amountCents(doc.amount),
    norm_date: normDate(doc.date ?? doc.norm_date),
    norm_time: hhmm(mins),
    norm_abn: normAbn(doc.abn ?? doc.norm_abn),
    norm_receipt_number: normReceipt(doc.receipt_number ?? doc.norm_receipt_number),
    merchant_key: merchantKey(doc.merchant ?? doc.merchant_key),
    norm_card_last4: normCard(doc.card_last4 ?? doc.norm_card_last4),
    norm_litres: litres,
    norm_pump: normPump(doc.pump != null ? doc.pump : doc.norm_pump),
    _time_mins: mins,
  };
}

export function enrichExpense(doc: Doc, hashes?: Doc | null): Doc {
  const out: Doc = { ...doc, ...(hashes || {}) };
  Object.assign(out, normaliseFields(out));
  return out;
}

function family(doc: Doc, key: string, rots: string): string[] {
  const found: string[] = [];
  if (usable(doc[key])) found.push(doc[key]);
  const list = doc[rots];
  if (Array.isArray(list)) for (const item of list) if (usable(item) && !found.includes(item)) found.push(item);
  return found;
}

function perceptualDistance(a: Doc, b: Doc): number | null {
  let best: number | null = null;
  for (const [key, rots] of [
    ["image_dhash", "image_dhash_rots"], ["image_ahash", "image_ahash_rots"],
    ["client_dhash", "client_dhash_rots"], ["client_ahash", "client_ahash_rots"],
  ] as const) {
    const left = family(a, key, rots);
    const right = family(b, key, rots);
    if (!left.length || !right.length) continue;
    let dist = 64;
    for (const x of left) for (const y of right) dist = Math.min(dist, hammingHex(x, y));
    best = best == null ? dist : Math.min(best, dist);
  }
  return best;
}

function minutesApart(a: Doc, b: Doc): number | null {
  const ta = a._time_mins, tb = b._time_mins;
  if (typeof ta !== "number" || typeof tb !== "number") return null;
  const diff = Math.abs(ta - tb);
  return Math.min(diff, 1440 - diff);
}

function sameAmount(a: Doc, b: Doc): boolean {
  return typeof a.amount_cents === "number" && a.amount_cents > 0 && a.amount_cents === b.amount_cents;
}

function daysApart(a: Doc, b: Doc): number | null {
  if (typeof a.norm_date !== "string" || typeof b.norm_date !== "string") return null;
  const da = Date.parse(a.norm_date + "T00:00:00Z");
  const db = Date.parse(b.norm_date + "T00:00:00Z");
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.abs(Math.round((da - db) / 86400000));
}

function fuelDistinct(a: Doc, b: Doc): boolean {
  if (a.category !== "fuel" && b.category !== "fuel") return false;
  if (!a.norm_date || a.norm_date !== b.norm_date) return false;
  const apart = minutesApart(a, b);
  if (apart != null && apart > FUEL_DISTINCT_MINUTES) return true;
  if (a.norm_pump && b.norm_pump && a.norm_pump !== b.norm_pump) return true;
  if (typeof a.norm_litres === "number" && typeof b.norm_litres === "number" && Math.abs(a.norm_litres - b.norm_litres) > 0.009) return true;
  if (a.norm_receipt_number && b.norm_receipt_number && a.norm_receipt_number !== b.norm_receipt_number) return true;
  return false;
}

function hasKey(doc: Doc): boolean {
  if (doc.image_sha256 || family(doc, "image_dhash", "image_dhash_rots").length || family(doc, "image_ahash", "image_ahash_rots").length) return true;
  if (doc.client_dhash || doc.client_ahash) return true;
  if (doc.norm_receipt_number && (doc.norm_abn || doc.merchant_key)) return true;
  if (sameAmount(doc, doc) && doc.merchant_key && doc.norm_date) return true;
  return false;
}

function kept(cand: Doc, other: Doc, keepWith?: string[]): boolean {
  const oid = other.id != null ? String(other.id) : "";
  const cid = cand.id != null ? String(cand.id) : "";
  if (oid && (keepWith || []).map(String).includes(oid)) return true;
  if (!oid || !cid) return false;
  const a = Array.isArray(cand.dupe_keep_with) ? cand.dupe_keep_with.map(String) : [];
  const b = Array.isArray(other.dupe_keep_with) ? other.dupe_keep_with.map(String) : [];
  return a.includes(oid) || b.includes(cid);
}

function view(other: Doc) {
  return {
    id: other.id ?? null,
    merchant: other.merchant || "",
    date: other.norm_date || String(other.date || "").slice(0, 10),
    txn_time: other.norm_time || "",
    amount: other.amount ?? null,
    category: other.category ?? null,
    has_receipt: Boolean(other.receipt_image || other.has_receipt),
  };
}

function compare(a: Doc, b: Doc) {
  if (a.image_sha256 && a.image_sha256 === b.image_sha256) return { rank: RANK.exact_image, level: "strong", reason: "exact_image", match: view(b) };
  const dist = perceptualDistance(a, b);
  if (dist != null && dist <= PHASH_STRONG_MAX) return { rank: RANK.perceptual, level: "strong", reason: "perceptual", distance: dist, match: view(b) };
  if (a.norm_receipt_number && a.norm_receipt_number === b.norm_receipt_number) {
    if (a.norm_abn && a.norm_abn === b.norm_abn) return { rank: RANK.receipt_abn, level: "strong", reason: "receipt_abn", match: view(b) };
    if (a.merchant_key && a.merchant_key === b.merchant_key) return { rank: RANK.receipt_merchant, level: "strong", reason: "receipt_merchant", match: view(b) };
  }
  if (fuelDistinct(a, b)) return null;
  if (sameAmount(a, b) && a.norm_date && a.norm_date === b.norm_date && a.merchant_key && a.merchant_key === b.merchant_key) {
    const apart = minutesApart(a, b);
    if (apart != null && apart <= LIKELY_MINUTES) return { rank: RANK.amount_date_merchant_time, level: "likely", reason: "amount_date_merchant_time", match: view(b) };
    if (a.norm_card_last4 && a.norm_card_last4 === b.norm_card_last4) return { rank: RANK.amount_date_merchant_card, level: "likely", reason: "amount_date_merchant_card", match: view(b) };
  }
  if (sameAmount(a, b) && a.merchant_key && a.merchant_key === b.merchant_key && daysApart(a, b) === 1) {
    return { rank: RANK.amount_merchant_day_off, level: "possible", reason: "amount_merchant_day_off", match: view(b) };
  }
  return null;
}

function empty(skipped: boolean, reason: string | null = null) {
  return { skipped, level: null as string | null, reason, match: null };
}

export function matchExpense(candidate: Doc, existing: Doc[], keepWith?: string[], excludeId?: string) {
  const cand = enrichExpense(candidate);
  if (isRefund(cand)) return empty(false, "refund");
  if (!hasKey(cand)) return empty(true);
  let best: ReturnType<typeof compare> = null;
  for (const raw of existing || []) {
    const other = enrichExpense(raw);
    if (excludeId && other.id != null && String(other.id) === String(excludeId)) continue;
    if (cand.profile_id && other.profile_id && String(cand.profile_id) !== String(other.profile_id)) continue;
    if (isRefund(other)) continue;
    if (kept(cand, other, keepWith)) continue;
    const hit = compare(cand, other);
    if (hit && (!best || hit.rank > best.rank)) best = hit;
  }
  if (!best) return empty(false);
  return { skipped: false, level: best.level, reason: best.reason, match: best.match };
}

export async function planPaidScan(bytes: Uint8Array, existing: Doc[], rgba?: { luma: number[]; width: number; height: number }) {
  const image_sha256 = await sha256Hex(bytes);
  const candidate: Doc = { image_sha256 };
  if (rgba) Object.assign(candidate, hashLuma(rgba.luma, rgba.width, rgba.height));
  const report = matchExpense(candidate, existing);
  const skip = report.level === "strong" && (report.reason === "exact_image" || report.reason === "perceptual");
  return { skip, image_sha256, duplicate: skip ? report : empty(Boolean(report.skipped), report.reason) };
}

export function backfillDocuments(docs: Doc[]): { documents: Doc[]; updated: number; unchanged: number } {
  const out: Doc[] = [];
  let updated = 0;
  for (const doc of docs || []) {
    if (!doc || !doc.receipt_image) { out.push(doc); continue; }
    const next = enrichExpense(doc);
    delete next._time_mins;
    const changed = TRACKED.some((key) => next[key] !== doc[key]);
    if (changed) { updated++; out.push(next); } else out.push(doc);
  }
  return { documents: out, updated, unchanged: out.length - updated };
}
