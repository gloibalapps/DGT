/** Port of backend/ue_guarantee.py (AU engaged-time guarantee). */
import { zipSync, strToU8 } from "fflate";
import type { Doc } from "./db.ts";

export const UE_PLATFORM = "Uber Eats";
const ANCHOR = Date.UTC(2026, 9, 19);
const DAY = 86400000;
/** Dated engaged-hour rates. 2027 figures are reported and not yet confirmed by Uber. */
export const RATE_TABLE: { from: string; car: number; motorbike: number; bicycle: number; note: "confirmed" | "reported, verify" }[] = [
  { from: "2026-08-17", car: 32, motorbike: 31.5, bicycle: 31.3, note: "confirmed" },
  { from: "2027-01-01", car: 32.5, motorbike: 32, bicycle: 31.8, note: "reported, verify" },
];
const FOUR_AM = 4 * 60;
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function parse(s: string): number {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function pyRound(n: number, digits = 0): number {
  const sign = n < 0 ? -1 : 1;
  const p = 10 ** digits;
  const x = Math.abs(n) * p;
  const floor = Math.floor(x + 1e-10);
  const diff = x - floor;
  const r = Math.abs(diff - 0.5) < 1e-8 ? (floor % 2 === 0 ? floor : floor + 1) : (diff > 0.5 ? floor + 1 : floor);
  return (sign * r) / p;
}

export function cycleStartFor(day: string): string {
  const d = parse(day);
  const steps = Math.floor((d - ANCHOR) / DAY / 21) * 21;
  return iso(ANCHOR + steps * DAY);
}

export function fmtDur(sec: number): string {
  sec = Math.round(sec || 0);
  if (sec <= 0) return "0 min";
  const h = Math.floor(sec / 3600);
  const rem = sec % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  if (h) return m ? `${h} hr ${m} min` : `${h} hr`;
  if (m) return s ? `${m} min ${s} sec` : `${m} min`;
  return `${s} sec`;
}

export function startMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(t.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3].toUpperCase();
  if (h < 1 || h > 12 || min > 59) return null;
  if (ap === "AM") h = h === 12 ? 0 : h;
  else h = h === 12 ? 12 : h + 12;
  return h * 60 + min;
}

export function isDup(a: Doc, b: Doc): boolean {
  if (a.type === "Promotion" || b.type === "Promotion") return false;
  return a.date === b.date && String(a.start_time ?? "") === String(b.start_time ?? "") &&
    String(a.platform ?? UE_PLATFORM) === String(b.platform ?? UE_PLATFORM) &&
    Math.abs(Number(a.amount ?? 0) - Number(b.amount ?? 0)) <= 0.02;
}

export function shiftDate(isoDay: string, days: number): string {
  return iso(parse(isoDay) + days * DAY);
}

/** A job accepted before 04:00 belongs to the previous calendar day for the period and the week. */
export function logicalDate(date: string, startTime?: string | null): string {
  const day = String(date || "").slice(0, 10);
  const mins = startTime ? startMinutes(String(startTime)) : null;
  if (mins != null && mins < FOUR_AM) return shiftDate(day, -1);
  return day;
}

export function jobPeriod(job: Doc): string {
  return cycleStartFor(logicalDate(String(job.date ?? ""), String(job.start_time ?? "")));
}

export function inWeek(job: Doc, weekStart: string): boolean {
  const logical = logicalDate(String(job.date ?? ""), String(job.start_time ?? ""));
  return logical >= weekStart && logical < shiftDate(weekStart, 7);
}

function vehicleKey(vehicleType?: string): "car" | "motorbike" | "bicycle" {
  const v = (vehicleType || "car").toLowerCase().replace(/[\s_-]/g, "");
  if (v.startsWith("motor") || v === "scooter") return "motorbike";
  if (v === "bicycle" || v === "ebike" || v === "ebicycle") return "bicycle";
  return "car";
}

function rateRow(onDate: string) {
  const day = (onDate || "2026-08-17").slice(0, 10);
  let chosen = RATE_TABLE[0];
  for (const row of RATE_TABLE) if (row.from <= day) chosen = row;
  return chosen;
}

export function rateFor(vehicleType: string | undefined, onDate = "2026-08-17"): number {
  return rateRow(onDate)[vehicleKey(vehicleType)];
}

export function rateNote(onDate: string): string | null {
  const note = rateRow(onDate).note;
  return note === "confirmed" ? null : note;
}

/** Half-up to the nearest minute, then back to seconds. */
export function nearestMinute(sec: number): number {
  return Math.floor(sec / 60 + 0.5) * 60;
}

function netAmount(j: Doc): number {
  const tip = Number(j.tip ?? 0);
  return Math.max(0, Number(j.amount ?? 0) - (Number.isFinite(tip) ? tip : 0));
}

function civilStartMs(date: string, mins: number): number {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60, 0);
}

/**
 * Engaged time is the union of [accept, accept+duration]. An engagement that
 * starts while another is still running counts only from when the earlier one
 * finishes, so stacked orders are not added twice. The total is then rounded
 * to the nearest minute. Tips are excluded from earnings. The rate follows
 * each job's calendar date.
 */
export function summarise(jobs: Doc[], vehicleType = "car"): Doc {
  const work = jobs.filter((j) => j.type !== "Promotion");
  const promos = jobs.filter((j) => j.type === "Promotion");
  const earnings = pyRound(jobs.reduce((a, j) => a + netAmount(j), 0), 2);
  const promo = pyRound(promos.reduce((a, j) => a + netAmount(j), 0), 2);
  const buckets = new Map<number, number>();
  const placed: { start: number; end: number; rate: number }[] = [];
  for (const j of work) {
    const dur = Number(j.duration_sec ?? 0);
    if (!(dur > 0)) continue;
    const rate = rateFor(vehicleType, String(j.date || "2026-08-17"));
    const mins = startMinutes(String(j.start_time ?? ""));
    if (mins == null) {
      buckets.set(rate, (buckets.get(rate) ?? 0) + dur);
      continue;
    }
    const start = civilStartMs(String(j.date), mins);
    placed.push({ start, end: start + dur * 1000, rate });
  }
  placed.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = Number.NEGATIVE_INFINITY;
  for (const iv of placed) {
    const from = Math.max(iv.start, cursor);
    if (iv.end > from) {
      buckets.set(iv.rate, (buckets.get(iv.rate) ?? 0) + (iv.end - from) / 1000);
      cursor = iv.end;
    }
  }
  let engaged = 0;
  let guaranteed = 0;
  for (const [rate, sec] of buckets) {
    const rounded = nearestMinute(sec);
    engaged += rounded;
    guaranteed += pyRound((rounded / 3600) * rate, 2);
  }
  guaranteed = pyRound(guaranteed, 2);
  const hrs = engaged / 3600;
  return {
    jobs: work.length, promotions: promos.length, earnings, promo_total: promo,
    engaged_sec: engaged, engaged_label: fmtDur(engaged), engaged_hours: pyRound(hrs, 4),
    effective_rate: hrs > 0 ? pyRound(earnings / hrs, 2) : null,
    guaranteed, top_up: pyRound(Math.max(0, guaranteed - earnings), 2),
    km: pyRound(work.reduce((a, j) => a + Number(j.km ?? 0), 0), 1),
  };
}

export function validateJob(raw: Doc): string | null {
  const type = raw.type ?? "DELIVERY";
  if (!["DELIVERY", "Package", "Promotion"].includes(String(type))) return "Invalid job: type";
  if (type === "Promotion") {
    if (raw.amount == null) return "Promotion needs an amount";
    raw.start_time = "";
    raw.duration_sec = 0;
  } else {
    if (!raw.start_time || startMinutes(String(raw.start_time)) == null) return "Job needs a start time like 12:03 PM";
    if (Number(raw.duration_sec ?? 0) <= 0) return "Job needs a duration";
  }
  raw.type = type;
  raw.platform = raw.platform || UE_PLATFORM;
  raw.date = String(raw.date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.date))) return "Invalid job: date";
  const tip = raw.tip == null || raw.tip === "" ? 0 : Number(raw.tip);
  if (!Number.isFinite(tip) || tip < 0) return "Invalid job: tip";
  raw.tip = pyRound(tip, 2);
  raw.verified = raw.verified === true;
  if (!raw.verified) raw.verified_at = null;
  return null;
}

export function mismatches(jobs: Doc[], income: Doc[]): Doc[] {
  const plats = [...new Set(jobs.map((j) => String(j.platform || UE_PLATFORM)))].sort();
  const logged: Record<string, number> = {};
  for (const i of income) {
    if (!plats.includes(String(i.platform))) continue;
    const k = `${String(i.date).slice(0, 10)}|${i.platform}`;
    logged[k] = pyRound((logged[k] ?? 0) + Number(i.amount ?? 0), 2);
  }
  const by: Record<string, number> = {};
  for (const j of jobs) {
    const k = `${j.date}|${j.platform || UE_PLATFORM}`;
    by[k] = pyRound((by[k] ?? 0) + Number(j.amount ?? 0), 2);
  }
  const out: Doc[] = [];
  for (const k of Object.keys(by).sort()) {
    const [date, platform] = k.split("|");
    const jt = by[k];
    const lt = logged[k] ?? 0;
    if (Math.abs(jt - lt) > 0.05) out.push({ date, platform, jobs_total: jt, income_logged: lt, difference: pyRound(lt - jt, 2) });
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Header dates have no year. Never return a date after `today`. */
export function inferJobDate(raw: string, today: string): string | null {
  const t = raw.trim();
  const todayDay = today.slice(0, 10);
  const yearOf = (month: number, day: number): string | null => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const y = Number(todayDay.slice(0, 4));
    const isoDay = (year: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    let candidate = isoDay(y);
    if (candidate > todayDay) candidate = isoDay(y - 1);
    return candidate <= todayDay ? candidate : null;
  };
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) {
    let isoDay = `${m[1]}-${m[2]}-${m[3]}`;
    if (isoDay > todayDay) {
      const rolled = `${Number(m[1]) - 1}-${m[2]}-${m[3]}`;
      if (rolled <= todayDay) isoDay = rolled;
      else return null;
    }
    return isoDay;
  }
  m = /([A-Za-z]{3,})\s+(\d{1,2})\b/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return yearOf(mi + 1, Number(m[2]));
  }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) return yearOf(Number(m[2]), Number(m[1]));
  return null;
}

function normClock(raw: string): string {
  const t = raw.trim().toUpperCase().replace(/\./g, "");
  let m = /^(\d{1,2}):(\d{2})\s*([AP]M)$/.exec(t);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 1 || h > 12 || min > 59) return "";
    return `${h}:${String(min).padStart(2, "0")} ${m[3]}`;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return "";
    const ap = h >= 12 ? "PM" : "AM";
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return `${h}:${String(min).padStart(2, "0")} ${ap}`;
  }
  return "";
}

function asJobType(raw: unknown): "DELIVERY" | "Package" | "Promotion" | null {
  const t = String(raw ?? "").toLowerCase();
  if (/quest|promo|boost|referral|incentive/.test(t)) return "Promotion";
  if (/package/.test(t)) return "Package";
  if (t === "" || /deliver/.test(t)) return "DELIVERY";
  return null;
}

function durationSeconds(row: Doc): number {
  const n = Number(row.duration_sec ?? 0);
  if (n > 0) return Math.round(n);
  const text = String(row.duration ?? "");
  let sec = 0;
  const re = /(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)/gi;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(text))) {
    any = true;
    const v = Number(m[1]);
    const u = m[2].toLowerCase();
    sec += u.startsWith("h") ? v * 3600 : u.startsWith("m") ? v * 60 : v;
  }
  return any ? sec : 0;
}

/**
 * Turn a vision-model reply into jobs. A printed top-up, guarantee, or trip
 * count is ignored. A row missing its amount, or a delivery missing its accept
 * time or duration, is rejected rather than guessed.
 */
export function parseGuaranteeJobs(text: string, today: string): { jobs: Doc[]; rejected: number } {
  let body = text.trim();
  if (body.startsWith("```")) {
    body = body.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  let parsed: Doc = {};
  try {
    const s = body.indexOf("{");
    const en = body.lastIndexOf("}");
    if (s < 0 || en < s) return { jobs: [], rejected: 0 };
    parsed = JSON.parse(body.slice(s, en + 1));
  } catch {
    return { jobs: [], rejected: 0 };
  }
  const rows = Array.isArray(parsed.jobs) ? parsed.jobs as Doc[] : [];
  const jobs: Doc[] = [];
  let rejected = 0;
  for (const row of rows) {
    const type = asJobType(row.type);
    const date = inferJobDate(String(row.date ?? ""), today);
    const amount = row.amount == null || row.amount === "" ? null : Number(row.amount);
    const tipRaw = row.tip == null || row.tip === "" ? 0 : Number(row.tip);
    if (!type || !date || amount == null || !Number.isFinite(amount)) { rejected++; continue; }
    const tip = Number.isFinite(tipRaw) && tipRaw > 0 ? pyRound(tipRaw, 2) : 0;
    if (type === "Promotion") {
      jobs.push({ date, start_time: "", type, duration_sec: 0, amount: pyRound(amount, 2), km: null, tip, platform: UE_PLATFORM, verified: false });
      continue;
    }
    const start = normClock(String(row.start_time ?? ""));
    const dur = durationSeconds(row);
    const km = row.km == null || row.km === "" ? null : Number(row.km);
    if (!start || !(dur > 0)) { rejected++; continue; }
    jobs.push({
      date, start_time: start, type, duration_sec: dur,
      amount: pyRound(amount, 2),
      km: km != null && Number.isFinite(km) ? pyRound(km, 2) : null,
      tip, platform: UE_PLATFORM, verified: false,
    });
  }
  return { jobs, rejected };
}

function au(s: string): string {
  const [y, m, d] = s.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function xmlEscape(v: unknown): string {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function sheetXml(rows: unknown[][]): string {
  const body = rows.map((row, i) => {
    const cells = row.map((c, j) => {
      const col = String.fromCharCode(65 + j);
      const ref = `${col}${i + 1}`;
      if (typeof c === "number" && Number.isFinite(c)) return `<c r="${ref}"><v>${c}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(c)}</t></is></c>`;
    }).join("");
    return `<row r="${i + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

export function xlsx(sheets: { name: string; rows: unknown[][] }[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
</Types>`);
  files["_rels/.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
</Relationships>`);
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows));
  });
  return zipSync(files);
}

export function guaranteeWorkbook(cycle: Doc): Uint8Array {
  const weeks = cycle.weeks as Doc[];
  const total = cycle.total as Doc;
  const summary: unknown[][] = [
    ["Uber Eats Engaged-Time Guarantee — Cycle Summary"],
    [],
    ["Driver name", ""],
    ["Contact (phone / email)", ""],
    ["Vehicle", String(cycle.vehicle_type ?? "").replace(/^./, (c) => c.toUpperCase())],
    ["Guarantee rate", `A$${Number(cycle.rate).toFixed(2)} per engaged hour`],
    ["Cycle", `${au(String(cycle.cycle_start))} – ${au(String(cycle.cycle_end))}`],
    [],
    ["Week", "Jobs", "Earnings (A$)", "Promotions (A$)", "Engaged time", "Effective rate", "Guaranteed (A$)"],
  ];
  for (const w of weeks) {
    summary.push([`Week ${Number(w.index) + 1} (${au(String(w.start))} – ${au(String(w.end))})`, w.jobs, w.earnings, w.promo_total, w.engaged_label, w.effective_rate, w.guaranteed]);
  }
  summary.push(["Cycle total", total.jobs, total.earnings, total.promo_total, total.engaged_label, total.effective_rate, total.guaranteed]);
  summary.push([]);
  const owed = Number(total.top_up) > 0;
  summary.push([owed ? "Top-up owed" : "Guarantee met", owed ? `A$${Number(total.top_up).toFixed(2)}` : "No top-up due"]);
  summary.push(["Estimate only. Uber calculates the final top-up. Overlapping jobs count once. Tips are excluded."]);
  const jobs = cycle.jobs as Doc[];
  const details: unknown[][] = [["Date", "Day", "Start", "Type", "Duration", "Duration (hrs)", "Amount (A$)", "Km", "Overlap with previous job (min)"]];
  let prevEnd: number | null = null;
  for (const w of weeks) {
    const wj = jobs.filter((j) => String(w.start) <= String(j.date) && String(j.date) <= String(w.end));
    for (const j of wj) {
      let overlap = 0;
      if (j.type !== "Promotion") {
        const sm = startMinutes(String(j.start_time ?? "")) ?? 0;
        const startAbs = parse(String(j.date)) + sm * 60000;
        if (prevEnd != null && prevEnd > startAbs) overlap = pyRound((prevEnd - startAbs) / 60000, 1);
        const endAbs = startAbs + Number(j.duration_sec ?? 0) * 1000;
        prevEnd = Math.max(prevEnd ?? startAbs, endAbs);
      }
      const d = parse(String(j.date));
      details.push([
        au(String(j.date)), DAY_NAMES[new Date(d).getUTCDay() === 0 ? 6 : new Date(d).getUTCDay() - 1],
        j.start_time ?? "", j.type,
        j.type !== "Promotion" ? fmtDur(Number(j.duration_sec ?? 0)) : "",
        j.type !== "Promotion" ? pyRound(Number(j.duration_sec ?? 0) / 3600, 4) : "",
        j.amount, j.km, overlap,
      ]);
    }
    details.push([`Week ${Number(w.index) + 1} subtotal`, "", "", `${w.jobs} jobs`, w.engaged_label, w.engaged_hours, w.earnings, w.km || "", ""]);
  }
  details.push(["Cycle total", "", "", `${total.jobs} jobs`, total.engaged_label, total.engaged_hours, total.earnings, total.km || "", ""]);
  return xlsx([{ name: "Summary", rows: summary }, { name: "Job Details", rows: details }]);
}
