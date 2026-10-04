// Date-range helpers for the Reports hub. Australian financial year = 1 Jul–30 Jun.
const iso = (d: Date) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD, local

function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeekMon(d: Date) { const x = new Date(d); const dow = (x.getDay() + 6) % 7; return addDays(x, -dow); }

function fyStart(d: Date) { const y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1; return new Date(y, 6, 1); }
function fyEnd(d: Date) { const s = fyStart(d); return new Date(s.getFullYear() + 1, 5, 30); }

// BAS quarters aligned to the AU FY: Q Jul–Sep, Oct–Dec, Jan–Mar, Apr–Jun.
function quarterBounds(d: Date) {
  const m = d.getMonth(), y = d.getFullYear();
  let sm: number, sy: number;
  if (m >= 6 && m <= 8) { sm = 6; sy = y; }
  else if (m >= 9) { sm = 9; sy = y; }
  else if (m <= 2) { sm = 0; sy = y; }
  else { sm = 3; sy = y; }
  const start = new Date(sy, sm, 1);
  const end = new Date(sy, sm + 3, 0);
  return { start, end };
}

export type RangeKey =
  | "today" | "yesterday" | "this_week" | "last_week" | "this_month" | "last_month"
  | "this_quarter" | "last_quarter" | "fy_to_date" | "prev_fy" | "custom";

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This week" },
  { key: "last_week", label: "Last week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "last_quarter", label: "Last quarter" },
  { key: "fy_to_date", label: "FY to date" },
  { key: "prev_fy", label: "Previous FY" },
  { key: "custom", label: "Custom" },
];

export function rangeFor(key: RangeKey, customStart?: string, customEnd?: string): { start: string; end: string } {
  const now = new Date();
  switch (key) {
    case "today": return { start: iso(now), end: iso(now) };
    case "yesterday": { const y = addDays(now, -1); return { start: iso(y), end: iso(y) }; }
    case "this_week": { const s = startOfWeekMon(now); return { start: iso(s), end: iso(addDays(s, 6)) }; }
    case "last_week": { const s = addDays(startOfWeekMon(now), -7); return { start: iso(s), end: iso(addDays(s, 6)) }; }
    case "this_month": { const s = new Date(now.getFullYear(), now.getMonth(), 1); const e = new Date(now.getFullYear(), now.getMonth() + 1, 0); return { start: iso(s), end: iso(e) }; }
    case "last_month": { const s = new Date(now.getFullYear(), now.getMonth() - 1, 1); const e = new Date(now.getFullYear(), now.getMonth(), 0); return { start: iso(s), end: iso(e) }; }
    case "this_quarter": { const { start, end } = quarterBounds(now); return { start: iso(start), end: iso(end) }; }
    case "last_quarter": { const { start } = quarterBounds(now); const { start: s2, end: e2 } = quarterBounds(addDays(start, -1)); return { start: iso(s2), end: iso(e2) }; }
    case "fy_to_date": return { start: iso(fyStart(now)), end: iso(now) };
    case "prev_fy": { const prev = new Date(fyStart(now).getFullYear() - 1, 6, 1); return { start: iso(fyStart(prev)), end: iso(fyEnd(prev)) }; }
    case "custom": return { start: customStart || iso(fyStart(now)), end: customEnd || iso(now) };
  }
}
