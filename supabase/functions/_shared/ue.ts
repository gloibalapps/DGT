/** Port of backend/ue_guarantee.py (AU engaged-time guarantee). */
import { zipSync, strToU8 } from "fflate";
import type { Doc } from "./db.ts";

export const UE_PLATFORM = "Uber Eats";
const ANCHOR = Date.UTC(2026, 9, 19);
const DAY = 86400000;
const RATES: Record<string, number> = { car: 32, motorbike: 31.5, bicycle: 31.3 };
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

export function summarise(jobs: Doc[], rate: number): Doc {
  const work = jobs.filter((j) => j.type !== "Promotion");
  const promos = jobs.filter((j) => j.type === "Promotion");
  const earnings = pyRound(jobs.reduce((a, j) => a + Number(j.amount ?? 0), 0), 2);
  const promo = pyRound(promos.reduce((a, j) => a + Number(j.amount ?? 0), 0), 2);
  const sec = work.reduce((a, j) => a + Number(j.duration_sec ?? 0), 0);
  const hrs = sec / 3600;
  const guaranteed = pyRound(hrs * rate, 2);
  return {
    jobs: work.length, promotions: promos.length, earnings, promo_total: promo,
    engaged_sec: sec, engaged_label: fmtDur(sec), engaged_hours: pyRound(hrs, 4),
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

export function rateFor(vehicleType: string | undefined): number {
  return RATES[vehicleType || "car"] ?? RATES.car;
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
