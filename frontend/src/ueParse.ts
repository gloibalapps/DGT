// Uber Eats guarantee — pure parsing/formatting helpers (no React).

export type UEType = "DELIVERY" | "Package" | "Promotion";
export const FOOD_PLATFORMS = ["Uber Eats", "DoorDash", "Menulog", "HungryPanda"];
export interface UEJob {
  id?: string;
  platform?: string;     // food app (only Uber Eats counts toward the guarantee)
  date: string;          // YYYY-MM-DD
  start_time: string;    // "12:03 PM" ("" for promotions)
  type: UEType;
  duration_sec: number;  // 0 for promotions
  amount: number | null;
  km: number | null;
}

/** Uber style: "1 hr 1 min", "38 min 36 sec"; totals "12 hr 5 min". Never decimals. */
export function fmtDur(sec: number): string {
  const s = Math.round(sec || 0);
  if (s <= 0) return "0 min";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return m ? `${h} hr ${m} min` : `${h} hr`;
  if (m) return r ? `${m} min ${r} sec` : `${m} min`;
  return `${r} sec`;
}

/**
 * Typed duration → seconds, or null if not recognised. Accepts:
 * "1 hr 1 min", "38 min 36 sec", "1h 5m", "38:36" (m:s), "1:01:00" (h:m:s),
 * plain number = minutes, "29.5" = 29 min 5 sec, "2.5.0" = 2 hr 5 min 0 sec.
 * Any part (other than the leading one) of 60 or more is invalid.
 */
export function parseDuration(input: string): number | null {
  const t = (input || "").trim().toLowerCase();
  if (!t) return null;
  const ok = (parts: number[]) => parts.slice(1).every((p) => p < 60) && parts.every((p) => Number.isInteger(p) && p >= 0);
  let m = t.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (m) { const p = [+m[1], +m[2], +m[3]]; return ok(p) ? p[0] * 3600 + p[1] * 60 + p[2] : null; }
  m = t.match(/^(\d+):(\d{1,2})$/);
  if (m) { const p = [+m[1], +m[2]]; return ok(p) && p[0] < 60 ? p[0] * 60 + p[1] : (ok(p) ? p[0] * 60 + p[1] : null); }
  m = t.match(/^(\d+)\.(\d{1,2})\.(\d{1,2})$/);
  if (m) { const p = [+m[1], +m[2], +m[3]]; return ok(p) ? p[0] * 3600 + p[1] * 60 + p[2] : null; }
  m = t.match(/^(\d+)\.(\d{1,2})$/);
  if (m) { const p = [+m[1], +m[2]]; return ok(p) ? p[0] * 60 + p[1] : null; }
  m = t.match(/^(\d+)$/);
  if (m) return +m[1] > 0 ? +m[1] * 60 : null;
  // unit words: h/hr/hrs/hour(s), m/min(s)/minute(s), s/sec(s)/second(s)
  const re = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?=\d|\s|,|$)/g;
  let h = 0, mi = 0, se = 0, any = false, used = "";
  let x: RegExpExecArray | null;
  while ((x = re.exec(t))) {
    any = true; used += x[0];
    const n = +x[1], u = x[2];
    if (u.startsWith("h")) h += n; else if (u.startsWith("m")) mi += n; else se += n;
  }
  if (!any) return null;
  if (t.replace(re, "").replace(/and|,|\s/g, "") !== "") return null;
  if (mi >= 60 && h > 0) return null;
  if (se >= 60) return null;
  const total = h * 3600 + mi * 60 + se;
  return total > 0 ? total : null;
}

export function durationPreview(input: string): string {
  if (!input.trim()) return "";
  const s = parseDuration(input);
  return s == null ? "Not recognised" : `= ${fmtDur(s)}`;
}

/** Seconds → editable text the parser accepts ("1 hr 1 min" style). */
export const durToText = (sec: number) => (sec > 0 ? fmtDur(sec) : "");

/** "12:03 PM" normaliser; returns "" if not a valid time. */
export function normTime(input: string): string {
  const t = (input || "").trim().toUpperCase().replace(/\./g, "");
  const m = t.match(/^(\d{1,2})(?::?(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return "";
  let h = +m[1]; const mi = m[2] ? +m[2] : 0;
  if (mi > 59 || h > 23) return "";
  let ap = m[3];
  if (!ap) {
    if (h >= 13) { ap = "PM"; h -= 12; } else if (h === 0) { ap = "AM"; h = 12; } else ap = h >= 7 && h <= 11 ? "AM" : "PM";
  } else if (h > 12 || h === 0) return "";
  return `${h}:${String(mi).padStart(2, "0")} ${ap}`;
}

export const auDate = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

/** Module is on if the driver switched it on — or, until they choose, if they drive for a food app. */
export const ueEnabled = (p: any): boolean =>
  p?.ue_guarantee_enabled ?? (p?.platforms || []).some((x: string) => FOOD_PLATFORMS.includes(x));

export function missingFields(j: UEJob): string[] {
  const miss: string[] = [];
  if (!j.date) miss.push("date");
  if (j.type === "Promotion") { if (j.amount == null) miss.push("amount"); return miss; }
  if (!j.start_time) miss.push("start time");
  if (!(j.duration_sec > 0)) miss.push("duration");
  return miss;
}

export const isDup = (a: UEJob, b: UEJob) =>
  a.type !== "Promotion" && b.type !== "Promotion" && missingFields(a).length === 0 && missingFields(b).length === 0 &&
  (a.platform || "Uber Eats") === (b.platform || "Uber Eats") &&
  a.date === b.date && (a.start_time || "") === (b.start_time || "") && Math.abs((a.amount || 0) - (b.amount || 0)) <= 0.02;

// ------------------------------------------------------------------ voice
const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ORD: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11,
  twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, thirtieth: 30,
};

/** "forty five" → "45", "twelve oh three" → "12 03", "twenty first" → "21st". */
export function wordsToDigits(text: string): string {
  const toks = text.toLowerCase().replace(/-/g, " ").split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    if (w in TENS) {
      const nx = toks[i + 1];
      if (nx && nx in UNITS && UNITS[nx] > 0 && UNITS[nx] < 10) { out.push(String(TENS[w] + UNITS[nx])); i++; continue; }
      if (nx && nx in ORD && ORD[nx] < 10) { out.push(`${TENS[w] + ORD[nx]}th`); i++; continue; }
      out.push(String(TENS[w])); continue;
    }
    if (w in ORD) { out.push(`${ORD[w]}th`); continue; }
    if (w === "oh" && out.length && /^\d+$/.test(out[out.length - 1])) {
      const nx = toks[i + 1];
      if (nx && nx in UNITS) { out.push(`0${UNITS[nx]}`); i++; continue; }
    }
    if (w in UNITS && w !== "oh") { out.push(String(UNITS[w])); continue; }
    if (w === "a" && /^(hour|minute)/.test(toks[i + 1] || "")) { out.push("1"); continue; }
    if (w === "an" && /^hour/.test(toks[i + 1] || "")) { out.push("1"); continue; }
    out.push(w);
  }
  return out.join(" ");
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Parse one spoken job. `fallbackDate` = previous line's date or "Date for new jobs". */
export function parseVoiceJob(raw: string, fallbackDate: string, now = new Date()): { job: UEJob; spokenDate: boolean } {
  let t = " " + wordsToDigits(raw).replace(/[,]/g, " ") + " ";
  // ignore spoken distances ("25 ks", "3.4 kilometres", "5 k")
  t = t.replace(/\d+(\.\d+)?\s*(ks|k|kms|km|kilometres|kilometers|kilometre|kilometer)\b/g, " ");

  // ---- platform (optional)
  let platform: string | undefined;
  if (/\buber\s*eats\b/.test(t)) platform = "Uber Eats";
  else if (/\bdoor\s*dash\b/.test(t)) platform = "DoorDash";
  else if (/\bmenu\s*log\b/.test(t)) platform = "Menulog";
  else if (/\bhungry\s*panda\b/.test(t)) platform = "HungryPanda";

  // ---- type
  let type: UEType = "DELIVERY";
  if (/\b(promotion|promo|quest|boost|incentive)\b/.test(t)) type = "Promotion";
  else if (/\bpackage\b/.test(t)) type = "Package";

  // ---- date
  let date = "", spokenDate = false;
  const year = now.getFullYear();
  const mk = (d: number, m: number) => { const dt = new Date(year, m, d); if (dt > now && dt.getMonth() === m) dt.setFullYear(year - 1); return iso(dt); };
  let m: RegExpMatchArray | null;
  if (/\btoday\b/.test(t)) { date = iso(now); t = t.replace(/\btoday\b/, " "); }
  else if (/\byesterday\b/.test(t)) { const d = new Date(now); d.setDate(d.getDate() - 1); date = iso(d); t = t.replace(/\byesterday\b/, " "); }
  else if ((m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join("|")})\\b`)))) {
    date = mk(+m[1], MONTHS.indexOf(m[2])); t = t.replace(m[0], " ");
  } else if ((m = t.match(new RegExp(`\\b(${MONTHS.join("|")})\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`)))) {
    date = mk(+m[2], MONTHS.indexOf(m[1])); t = t.replace(m[0], " ");
  } else if ((m = t.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/))) {
    date = mk(+m[1], +m[2] - 1); t = t.replace(m[0], " ");
  }
  if (date) spokenDate = true; else date = fallbackDate;
  t = t.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, " ");

  // ---- amount: "$24.59", "24 dollars 59", "24 dollars and 59 cents"
  let amount: number | null = null;
  if ((m = t.match(/\$\s*(\d+(?:\.\d{1,2})?)/))) { amount = +m[1]; t = t.replace(m[0], " "); }
  else if ((m = t.match(/\b(\d+)\s*dollars?(?:\s*(?:and\s*)?(\d{1,2})(?:\s*cents?)?)?/))) {
    amount = +m[1] + (m[2] ? +m[2] / 100 : 0); t = t.replace(m[0], " ");
  } else if ((m = t.match(/\b(\d{1,2})\s*cents?\b/))) { amount = +m[1] / 100; t = t.replace(m[0], " "); }
  if (amount != null) amount = Math.round(amount * 100) / 100;

  // ---- duration
  let dur = 0;
  if ((m = t.match(/\b1\s*hours?\s*and\s*a\s*half\b/))) { dur = 5400; t = t.replace(m[0], " "); }
  else if ((m = t.match(/\bhalf\s*(?:an|a|1)\s*hour\b/))) { dur = 1800; t = t.replace(m[0], " "); }
  else {
    const re = /\b(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/g;
    let x: RegExpExecArray | null; const hits: string[] = [];
    while ((x = re.exec(t))) {
      const n = +x[1], u = x[2];
      dur += u.startsWith("h") ? n * 3600 : u.startsWith("m") ? n * 60 : n; hits.push(x[0]);
    }
    hits.forEach((h) => { t = t.replace(h, " "); });
  }

  // ---- time
  let start = "";
  if (type !== "Promotion") {
    const ap = (h: number, mi: number, mer?: string) => normTime(`${h}:${String(mi).padStart(2, "0")}${mer ? " " + mer : ""}`);
    const mer = /\b(pm|p\s*m|arvo|afternoon|evening|tonight)\b/.test(t) ? "PM" : /\b(am|a\s*m|morning)\b/.test(t) ? "AM" : undefined;
    if (/\b(midday|noon)\b/.test(t)) start = "12:00 PM";
    else if ((m = t.match(/\bhalf\s*past\s*(\d{1,2})\b/))) start = ap(+m[1], 30, mer);
    else if ((m = t.match(/\bquarter\s*past\s*(\d{1,2})\b/))) start = ap(+m[1], 15, mer);
    else if ((m = t.match(/\bquarter\s*to\s*(\d{1,2})\b/))) start = ap(((+m[1] + 10) % 12) + 1, 45, mer);
    else if ((m = t.match(/\b(\d{1,2})[:.\s](\d{2})\b/))) start = ap(+m[1], +m[2], mer);
    else if ((m = t.match(/\b(\d{1,2})\s*(?:o'?clock|am|pm|a\s*m|p\s*m)\b/))) start = ap(+m[1], 0, mer);
  }
  return {
    job: { date, start_time: start, type, duration_sec: type === "Promotion" ? 0 : dur, amount, km: null, platform },
    spokenDate,
  };
}
