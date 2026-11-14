/** Port of backend/tax.py. Dates are UTC calendar dates. round() matches Python 3. */

// deno-lint-ignore no-explicit-any
export type Rec = Record<string, any>;
const AU_DELIVERY_GST_THRESHOLD = 75000;
const CYCLE: Record<string, number> = { weekly: 7, fortnightly: 14, monthly: 365 / 12 };
const AU_CPK: Record<number, number> = { 2024: 0.88, 2025: 0.88, 2026: 0.91 };
const AU_CPK_MAX_KM = 5000;
const US_SE_TAX_RATE = 0.153;
const US_SE_NET_FACTOR = 0.9235;
const US_SS_RATE = 0.124;
const US_MEDICARE_RATE = 0.029;
const US_SS_WAGE_BASE: Record<number, number> = { 2024: 168600, 2025: 176100, 2026: 184500 };
const US_QUARTER_DUE: Record<number, string> = { 1: "15 Apr", 2: "15 Jun", 3: "15 Sep", 4: "15 Jan" };
const US_STD: Record<number, number> = { 2024: 14600, 2025: 15000, 2026: 16100 };
const US_BRACKETS: Record<number, [number, number][]> = {
  2025: [[11925, 0.1], [48475, 0.12], [103350, 0.22], [197300, 0.24], [250525, 0.32], [626350, 0.35], [Infinity, 0.37]],
  2026: [[12400, 0.1], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
};
const AU_BRACKETS: [number, number][] = [[18200, 0], [45000, 0.16], [135000, 0.3], [190000, 0.37], [Infinity, 0.45]];
const AU_MEDICARE_LEVY = 0.02;
const AU_MEDICARE_THRESHOLD = 27222;
const LOGBOOK_WINDOW_DAYS = 84;
const US_STATE: Record<string, number> = {
  AK: 0, FL: 0, NV: 0, NH: 0, SD: 0, TN: 0, TX: 0, WA: 0, WY: 0,
  AZ: 0.025, CO: 0.044, GA: 0.0539, IL: 0.0495, IN: 0.03, KY: 0.04, LA: 0.03, MI: 0.0425, MS: 0.044, NC: 0.0425,
  PA: 0.0307, UT: 0.0455, ID: 0.05695, IA: 0.038, MA: 0.05, AL: 0.045, AR: 0.039, CA: 0.04, CT: 0.05, DE: 0.05,
  DC: 0.06, HI: 0.075, ME: 0.0675, MD: 0.0475, MN: 0.068, MO: 0.047, MT: 0.059, NE: 0.052, NJ: 0.055, NM: 0.049,
  NY: 0.0585, ND: 0.02, OH: 0.035, OK: 0.0475, OR: 0.0875, RI: 0.0475, SC: 0.062, VT: 0.066, VA: 0.0575, WV: 0.045, WI: 0.053,
};
const WD_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WD_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PERIOD_WORD: Record<string, string> = { today: "today", week: "this week", month: "this month", year: "this FY" };

let frozenToday: Date | null = null;

/** Pins date.today() for tests. Production uses the UTC calendar date. */
export function setTaxToday(d: Date | null): void {
  frozenToday = d;
}

export function taxToday(): Date {
  if (frozenToday) return frozenToday;
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** CPython 3 round: half-to-even on the float's exact decimal expansion. */
export function pyRound(n: number, digits = 0): number {
  if (!Number.isFinite(n)) return n;
  const neg = n < 0;
  const abs = Math.abs(n);
  if (abs === 0) return 0;
  const [mant, expRaw] = abs.toExponential(20).split("e");
  const exp = Number(expRaw);
  const coef = mant.replace(".", "");
  const scale = exp - (coef.length - 1);
  const drop = -(scale + digits);
  const bumpDigits = (keep: string[]): string[] => {
    let i = keep.length - 1;
    while (i >= 0 && keep[i] === "9") {
      keep[i] = "0";
      i--;
    }
    if (i < 0) return ["1", ...keep];
    keep[i] = String(Number(keep[i]) + 1);
    return keep;
  };
  let keep: string[];
  let next = "0";
  let rest = false;
  if (drop <= 0) keep = [...coef, ..."0".repeat(-drop)];
  else if (drop > coef.length) return 0;
  else if (drop === coef.length) {
    keep = [];
    next = coef[0] ?? "0";
    rest = coef.slice(1).split("").some((c) => c !== "0");
  } else {
    keep = coef.slice(0, coef.length - drop).split("");
    next = coef[coef.length - drop] ?? "0";
    rest = coef.slice(coef.length - drop + 1).split("").some((c) => c !== "0");
  }
  const half = next === "5" && !rest;
  const up = next > "5" || (next === "5" && rest) || (half && Number(keep[keep.length - 1] ?? "0") % 2 === 1);
  if (up) keep = bumpDigits(keep);
  const text = keep.join("") || "0";
  const out = Number(text) / 10 ** digits;
  return neg ? -out : out;
}

export function parseDate(s: string): Date {
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function addDays(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function weekday(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}
function fmtDM(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function fmtFull(d: Date, us = false): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = d.getUTCFullYear();
  return us ? `${mm}/${dd}/${yy}` : `${dd}/${mm}/${yy}`;
}
function num(v: unknown): number {
  return Number(v ?? 0);
}

function titleCase(s: string): string {
  return s.replace(/(^|[^a-zA-Z0-9])([a-z])/g, (_m, a, b) => a + String(b).toUpperCase());
}

export function usTaxYear(ref: Date): number {
  const y = ref.getUTCFullYear();
  if (US_BRACKETS[y]) return y;
  return y < 2025 ? 2025 : Math.max(...Object.keys(US_BRACKETS).map(Number));
}
export function usStdDeduction(year: number): number {
  const latest = Math.max(...Object.keys(US_STD).map(Number));
  return US_STD[year] ?? US_STD[latest];
}
function bracketTax(taxable: number, brackets: [number, number][]): number {
  let tax = 0;
  let prev = 0;
  for (const [cap, rate] of brackets) {
    if (taxable > prev) {
      tax += (Math.min(taxable, cap) - prev) * rate;
      prev = cap;
    } else break;
  }
  return pyRound(tax, 2);
}
export function usFederalIncomeTax(taxable: number, year?: number): number {
  const y = year ?? Math.max(...Object.keys(US_BRACKETS).map(Number));
  return bracketTax(Math.max(0, taxable), US_BRACKETS[y] ?? US_BRACKETS[2026]);
}
export function usSeTax(netProfit: number, year?: number): number {
  const net = Math.max(0, netProfit) * US_SE_NET_FACTOR;
  const latest = Math.max(...Object.keys(US_SS_WAGE_BASE).map(Number));
  const base = US_SS_WAGE_BASE[year ?? latest] ?? US_SS_WAGE_BASE[latest];
  return pyRound(Math.min(net, base) * US_SS_RATE + net * US_MEDICARE_RATE, 2);
}
export function auIncomeTax(taxable: number): number {
  taxable = Math.max(0, taxable);
  const tax = bracketTax(taxable, AU_BRACKETS);
  const levy = taxable > AU_MEDICARE_THRESHOLD ? taxable * AU_MEDICARE_LEVY : 0;
  return pyRound(tax + levy, 2);
}
export function usStateTax(state: string | null | undefined, taxable: number): [string, number, number] {
  const st = (state || "").toUpperCase();
  const rate = US_STATE[st] ?? 0.05;
  return [st, rate, pyRound(Math.max(0, taxable) * rate, 2)];
}
export function usMileageRate(d: Date): number {
  const y = d.getUTCFullYear();
  if (y <= 2024) return 0.67;
  if (y === 2025) return 0.7;
  if (y === 2026) return d.getUTCMonth() + 1 <= 6 ? 0.725 : 0.76;
  return 0.76;
}
export function tripBusinessKm(t: Rec): number {
  const typ = t.type ?? "business";
  const d = num(t.distance_km);
  if (typ === "personal") return 0;
  if (typ === "mixed") {
    const pct = t.business_pct == null ? 100 : num(t.business_pct);
    return pyRound(d * Math.max(0, Math.min(100, pct)) / 100, 3);
  }
  return d;
}
export function tripPersonalKm(t: Rec): number {
  return pyRound(num(t.distance_km) - tripBusinessKm(t), 3);
}
export function usStandardMileageDeduction(trips: Rec[]): number {
  let total = 0;
  for (const t of trips) total += tripBusinessKm(t) * usMileageRate(parseDate(t.date));
  return pyRound(total, 2);
}
function cpkRate(fyStartYear: number): number {
  return AU_CPK[fyStartYear] ?? AU_CPK[Math.max(...Object.keys(AU_CPK).map(Number))];
}
export function auFyStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCMonth() + 1 >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1, 6, 1));
}
export function auBasQuarter(d: Date): [Date, Date] {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (m >= 7 && m <= 9) return [new Date(Date.UTC(y, 6, 1)), new Date(Date.UTC(y, 9, 1))];
  if (m >= 10) return [new Date(Date.UTC(y, 9, 1)), new Date(Date.UTC(y + 1, 0, 1))];
  if (m <= 3) return [new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 3, 1))];
  return [new Date(Date.UTC(y, 3, 1)), new Date(Date.UTC(y, 6, 1))];
}
export function usCalendarQuarter(d: Date): [Date, Date] {
  const q = Math.floor(d.getUTCMonth() / 3);
  const sm = q * 3;
  const start = new Date(Date.UTC(d.getUTCFullYear(), sm, 1));
  const end = sm === 9 ? new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1)) : new Date(Date.UTC(d.getUTCFullYear(), sm + 3, 1));
  return [start, end];
}
export function fyStart(d: Date, country = "AU"): Date {
  return country === "US" ? new Date(Date.UTC(d.getUTCFullYear(), 0, 1)) : auFyStart(d);
}
function addMonth(d: Date): Date {
  return d.getUTCMonth() === 11 ? new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1)) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}
export function startOfWeek(ref: Date, weekStart = 0): Date {
  return addDays(ref, -((weekday(ref) - weekStart + 7) % 7));
}
export function periodRange(period: string, ref: Date, country = "AU", weekStart = 0): [Date, Date] {
  if (period === "day" || period === "today") return [ref, addDays(ref, 1)];
  if (period === "week") {
    const start = startOfWeek(ref, weekStart);
    return [start, addDays(start, 7)];
  }
  if (period === "month") {
    const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
    return [start, addMonth(start)];
  }
  if (period === "quarter") return country === "US" ? usCalendarQuarter(ref) : auBasQuarter(ref);
  const start = fyStart(ref, country);
  return [start, country === "US" ? new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1)) : new Date(Date.UTC(start.getUTCFullYear() + 1, 6, 1))];
}
export function fmtPeriodLabel(_period: string, start: Date, end: Date, country = "AU"): string {
  const last = addDays(end, -1);
  return `${fmtFull(start, country === "US")} – ${fmtFull(last, country === "US")}`;
}
export function recurringOwed(rec: Rec | null | undefined, start: Date, end: Date, today: Date, disposal?: Date | null): number {
  if (!rec || !rec.amount || !rec.anchor_date) return 0;
  const cycle = CYCLE[rec.frequency ?? "weekly"] ?? 7;
  const daily = num(rec.amount) / cycle;
  const anchor = parseDate(rec.anchor_date);
  let cap = end < addDays(today, 1) ? end : addDays(today, 1);
  if (disposal) cap = cap < disposal ? cap : disposal;
  const ovStart = start > anchor ? start : anchor;
  const days = Math.round((cap.getTime() - ovStart.getTime()) / 86400000);
  if (days <= 0) return 0;
  return pyRound(daily * days, 2);
}
function vehEnd(v?: Rec | null): Date | null {
  if (!v || !v.disposal_date) return null;
  return parseDate(v.disposal_date);
}
function vehDisposedBy(v: Rec | null | undefined, on: Date): boolean {
  const end = vehEnd(v);
  return end != null && end.getTime() <= on.getTime();
}
function addMonthKeepDay(d: Date): Date {
  const y = d.getUTCFullYear() + (d.getUTCMonth() === 11 ? 1 : 0);
  const m = d.getUTCMonth() === 11 ? 0 : d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}
function nextDueDate(rec: Rec | null | undefined, today: Date): string | null {
  if (!rec?.anchor_date) return null;
  const freq = rec.frequency ?? "weekly";
  const step = freq === "fortnightly" ? 14 : freq === "monthly" ? 30 : 7;
  let d = parseDate(rec.anchor_date);
  while (d.getTime() <= today.getTime()) d = freq === "monthly" ? addMonthKeepDay(d) : addDays(d, step);
  return iso(d);
}

function inPeriod(row: Rec, start: Date, end: Date): boolean {
  const d = parseDate(row.date);
  return d.getTime() >= start.getTime() && d.getTime() < end.getTime();
}

export function computeReport(profile: Rec, trips: Rec[], incomes: Rec[], expenses: Rec[], period: string, ref: Date, vehicles?: Rec[] | null): Rec {
  const today = taxToday();
  if (profile.country === "US") return computeReportUs(profile, trips, incomes, expenses, period, ref, vehicles);
  const [start, end] = periodRange(period, ref, "AU", num(profile.week_start));
  const pTrips = trips.filter((t) => inPeriod(t, start, end));
  const pIncome = incomes.filter((i) => inPeriod(i, start, end));
  const pExp = expenses.filter((e) => inPeriod(e, start, end));
  const businessKm = pyRound(pTrips.reduce((a, t) => a + tripBusinessKm(t), 0), 2);
  const personalKm = pyRound(pTrips.reduce((a, t) => a + tripPersonalKm(t), 0), 2);
  const totalKm = pyRound(businessKm + personalKm, 2);
  const fallback = num(profile.business_use_fallback ?? 100) / 100;
  const businessUse = totalKm > 0 ? businessKm / totalKm : fallback;
  const totalIncome = pyRound(pIncome.reduce((a, i) => a + num(i.amount), 0), 2);
  const inclusiveIncome = pyRound(pIncome.filter((i) => (i.tax_treatment ?? "inclusive") === "inclusive").reduce((a, i) => a + num(i.amount), 0), 2);
  const catTotals: Record<string, number> = { fuel: 0, tolls: 0, vehicle: 0, phone: 0, other: 0 };
  for (const e of pExp) {
    const c = e.category ?? "other";
    catTotals[c] = (catTotals[c] ?? 0) + num(e.amount);
  }
  for (const k of Object.keys(catTotals)) catTotals[k] = pyRound(catTotals[k], 2);
  const vehList = vehicles && vehicles.length ? vehicles : [{ id: "__default__", ownership: profile.vehicle_ownership ?? "own", recurring_payment: profile.recurring_payment }];
  const periodUse = (vid: string) => {
    const vt = pTrips.filter((t) => (t.vehicle_id || "__default__") === vid);
    const b = vt.reduce((a, t) => a + tripBusinessKm(t), 0);
    const tot = vt.reduce((a, t) => a + num(t.distance_km), 0);
    return tot > 0 ? b / tot : businessUse;
  };
  const uses: Record<string, number> = {};
  for (const v of vehList) uses[v.id] = periodUse(v.id);
  let fuelDed = 0, vehicleDed = 0, recurringDed = 0, recurringGross = 0;
  for (const e of pExp) {
    const c = e.category ?? "other";
    if (c !== "fuel" && c !== "vehicle") continue;
    const use = uses[e.vehicle_id || "__default__"] ?? businessUse;
    if (c === "fuel") fuelDed += num(e.amount) * use;
    else vehicleDed += num(e.amount) * use;
  }
  for (const v of vehList) {
    const rg = recurringOwed(v.recurring_payment, start, end, today, vehEnd(v));
    recurringGross += rg;
    recurringDed += rg * uses[v.id];
  }
  fuelDed = pyRound(fuelDed, 2);
  vehicleDed = pyRound(vehicleDed, 2);
  recurringDed = pyRound(recurringDed, 2);
  recurringGross = pyRound(recurringGross, 2);
  const vehicleDeductionTotal = pyRound(fuelDed + vehicleDed + recurringDed, 2);
  const tollsDed = catTotals.tolls;
  const phoneDed = catTotals.phone;
  const otherDed = catTotals.other;
  const fullClaimTotal = pyRound(tollsDed + phoneDed + otherDed, 2);
  const totalDeductions = pyRound(vehicleDeductionTotal + fullClaimTotal, 2);
  const netProfit = pyRound(totalIncome - totalDeductions, 2);
  const workType = profile.work_type ?? "delivery";
  const registered = profile.registration_status === "registered";
  const gstRequired = workType === "passengers" || workType === "both";
  const gstApplicable = registered || gstRequired;
  const g1 = inclusiveIncome;
  const oneA = pyRound(g1 / 11, 2);
  let oneBBase = 0;
  for (const e of pExp) {
    if ((e.tax_treatment ?? "inclusive") !== "inclusive") continue;
    const c = e.category ?? "other";
    if (c === "fuel" || c === "vehicle") oneBBase += num(e.amount) * (uses[e.vehicle_id || "__default__"] ?? businessUse);
    else oneBBase += num(e.amount);
  }
  for (const v of vehList) {
    if (["lease", "rental", "loan"].includes(v.ownership ?? profile.vehicle_ownership)) {
      const rg = recurringOwed(v.recurring_payment, start, end, today, vehEnd(v));
      oneBBase += rg * uses[v.id];
    }
  }
  const oneB = pyRound(oneBBase / 11, 2);
  const netGst = pyRound(oneA - oneB, 2);
  let regWarning: string | null = null;
  let gstNote: string | null = null;
  if ((workType === "passengers" || workType === "both") && !registered) {
    regWarning = "You carry passengers — ride-sourcing requires GST registration from your first dollar. Register with the ATO.";
    gstNote = "Ride-sourcing must be GST-registered from your first dollar. These are the GST amounts you're liable for — register your ABN for GST with the ATO to lodge them.";
  } else if (workType === "delivery" && !registered) {
    const fy = auFyStart(today);
    const fyIncome = pyRound(incomes.filter((i) => parseDate(i.date).getTime() >= fy.getTime()).reduce((a, i) => a + num(i.amount), 0), 2);
    if (fyIncome >= AU_DELIVERY_GST_THRESHOLD) {
      regWarning = "Your delivery turnover has passed $75,000 this financial year — you now need to register for GST.";
    }
  }
  return {
    period, period_start: iso(start), period_end: iso(end), period_label: fmtPeriodLabel(period, start, end),
    currency: "AUD", symbol: "$", distance_unit: "km",
    business_km: businessKm, personal_km: personalKm, total_km: totalKm,
    business_use_pct: pyRound(businessUse * 100, 1), business_use_is_fallback: totalKm === 0,
    total_income: totalIncome, total_deductions: totalDeductions, net_profit: netProfit, category_totals: catTotals,
    vehicle_deduction: { fuel: fuelDed, vehicle_costs: vehicleDed, recurring_payment: recurringDed, recurring_payment_gross: recurringGross, business_use_pct: pyRound(businessUse * 100, 1), total: vehicleDeductionTotal },
    full_claim: { tolls: tollsDed, phone: phoneDed, other: otherDed, total: fullClaimTotal },
    show_bas: gstApplicable, gst_required: gstRequired, gst_registered: registered, gst_note: gstNote,
    bas: { G1: pyRound(g1, 2), "1A": oneA, "1B": oneB, net_gst: netGst, sanity_ok: Math.abs(oneA - pyRound(g1 / 11, 2)) < 0.01 },
    work_type: workType, registered, registration_warning: regWarning, vehicle_ownership: profile.vehicle_ownership,
  };
}

export function computeReportUs(profile: Rec, trips: Rec[], incomes: Rec[], expenses: Rec[], period: string, ref: Date, vehicles?: Rec[] | null): Rec {
  const today = taxToday();
  const [start, end] = periodRange(period, ref, "US", num(profile.week_start));
  const pTrips = trips.filter((t) => inPeriod(t, start, end));
  const pIncome = incomes.filter((i) => inPeriod(i, start, end));
  const pExp = expenses.filter((e) => inPeriod(e, start, end));
  const businessKm = pyRound(pTrips.reduce((a, t) => a + tripBusinessKm(t), 0), 2);
  const personalKm = pyRound(pTrips.reduce((a, t) => a + tripPersonalKm(t), 0), 2);
  const totalKm = pyRound(businessKm + personalKm, 2);
  const fallback = num(profile.business_use_fallback ?? 100) / 100;
  const businessUse = totalKm > 0 ? businessKm / totalKm : fallback;
  const totalIncome = pyRound(pIncome.reduce((a, i) => a + num(i.amount), 0), 2);
  const catTotals: Record<string, number> = { fuel: 0, tolls: 0, vehicle: 0, phone: 0, other: 0 };
  for (const e of pExp) catTotals[e.category ?? "other"] = (catTotals[e.category ?? "other"] ?? 0) + num(e.amount);
  for (const k of Object.keys(catTotals)) catTotals[k] = pyRound(catTotals[k], 2);
  const vehList = vehicles && vehicles.length ? vehicles : [{ id: "__default__", ownership: profile.vehicle_ownership ?? "own", recurring_payment: profile.recurring_payment }];
  const uses: Record<string, number> = {};
  for (const v of vehList) {
    const vt = pTrips.filter((t) => (t.vehicle_id || "__default__") === v.id);
    const b = vt.reduce((a, t) => a + tripBusinessKm(t), 0);
    const tot = vt.reduce((a, t) => a + num(t.distance_km), 0);
    uses[v.id] = tot > 0 ? b / tot : businessUse;
  }
  let fuelDed = 0, vehicleDed = 0, recurringDed = 0, recurringGross = 0;
  for (const e of pExp) {
    const c = e.category ?? "other";
    if (c !== "fuel" && c !== "vehicle") continue;
    const use = uses[e.vehicle_id || "__default__"] ?? businessUse;
    if (c === "fuel") fuelDed += num(e.amount) * use;
    else vehicleDed += num(e.amount) * use;
  }
  for (const v of vehList) {
    const rg = recurringOwed(v.recurring_payment, start, end, today, vehEnd(v));
    recurringGross += rg;
    recurringDed += rg * uses[v.id];
  }
  const actualExpense = pyRound(fuelDed + vehicleDed + recurringDed, 2);
  const standardMileage = usStandardMileageDeduction(pTrips);
  const carAndTruck = pyRound(Math.max(standardMileage, actualExpense), 2);
  const carMethod = standardMileage >= actualExpense ? "standard_mileage" : "actual";
  const otherExpenses = pyRound(catTotals.tolls + catTotals.phone + catTotals.other, 2);
  const totalDeductions = pyRound(carAndTruck + otherExpenses, 2);
  const netProfit = pyRound(totalIncome - totalDeductions, 2);
  const taxYear = usTaxYear(ref);
  const netSe = pyRound(Math.max(0, netProfit) * US_SE_NET_FACTOR, 2);
  const seTax = usSeTax(netProfit, taxYear);
  const [stCode, stRate, stTax] = usStateTax(profile.region, Math.max(0, netProfit));
  const qDue = period === "quarter" ? US_QUARTER_DUE[Math.floor(start.getUTCMonth() / 3) + 1] : null;
  return {
    country: "US", period, period_start: iso(start), period_end: iso(end), period_label: fmtPeriodLabel(period, start, end, "US"),
    currency: "USD", symbol: "$", distance_unit: "mi",
    business_km: businessKm, personal_km: personalKm, total_km: totalKm,
    business_use_pct: pyRound(businessUse * 100, 1), business_use_is_fallback: totalKm === 0,
    total_income: totalIncome, total_deductions: totalDeductions, net_profit: netProfit, category_totals: catTotals,
    vehicle_deduction: { fuel: pyRound(fuelDed, 2), vehicle_costs: pyRound(vehicleDed, 2), recurring_payment: pyRound(recurringDed, 2), recurring_payment_gross: pyRound(recurringGross, 2), business_use_pct: pyRound(businessUse * 100, 1), total: actualExpense },
    full_claim: { tolls: catTotals.tolls, phone: catTotals.phone, other: catTotals.other, total: otherExpenses },
    schedule_c: { gross_receipts: totalIncome, standard_mileage: standardMileage, actual_expenses: actualExpense, car_and_truck: carAndTruck, car_method: carMethod, car_method_label: carMethod === "standard_mileage" ? "Standard mileage" : "Actual expenses", other_expenses: otherExpenses, total_expenses: totalDeductions, net_profit: netProfit },
    se_tax: { net_earnings: netSe, rate: US_SE_TAX_RATE, amount: seTax, tax_year: taxYear, state: stCode, state_rate: stRate, state_tax: stTax, state_has_tax: stRate > 0, quarter_due: qDue, note: "Self-employment tax is ~15.3% of 92.35% of net profit. Set this aside and pay quarterly estimated taxes (Form 1040-ES). This is an estimate, not tax advice." },
    show_bas: false, registration_warning: null, work_type: profile.work_type ?? "delivery", vehicle_ownership: profile.vehicle_ownership,
  };
}

export function performance(profile: Rec, trips: Rec[], incomes: Rec[], expenses: Rec[], ref: Date, shifts: Rec[] = []): Rec {
  const monday = startOfWeek(ref, num(profile.week_start));
  const weeks = [];
  let totInc = 0, totExp = 0, totKm = 0, totHours = 0, totOnline = 0;
  for (let i = 3; i >= 0; i--) {
    const ws = addDays(monday, -7 * i);
    const we = addDays(ws, 7);
    const inc = incomes.filter((x) => inPeriod(x, ws, we)).reduce((a, x) => a + num(x.amount), 0);
    const exp = expenses.filter((x) => inPeriod(x, ws, we)).reduce((a, x) => a + num(x.amount), 0);
    const wt = trips.filter((t) => inPeriod(t, ws, we));
    const bkm = wt.reduce((a, t) => a + tripBusinessKm(t), 0);
    const mins = wt.filter((t) => tripBusinessKm(t) > 0).reduce((a, t) => a + num(t.duration_min), 0);
    const onlineH = shifts.filter((s) => inPeriod(s, ws, we)).reduce((a, s) => a + num(s.hours), 0);
    const wkHours = onlineH > 0 ? onlineH : mins / 60;
    weeks.push({ label: fmtDM(ws), start: iso(ws), income: pyRound(inc, 2), expenses: pyRound(exp, 2), profit: pyRound(inc - exp, 2), business_km: pyRound(bkm, 2), hours: pyRound(wkHours, 2) });
    totInc += inc; totExp += exp; totKm += bkm; totHours += wkHours; totOnline += onlineH;
  }
  return {
    weeks, total_income: pyRound(totInc, 2), total_expenses: pyRound(totExp, 2), total_profit: pyRound(totInc - totExp, 2),
    total_km: pyRound(totKm, 2), total_hours: pyRound(totHours, 2), hours_source: totOnline > 0 ? "online" : "driving",
    per_km: totKm > 0 ? pyRound(totInc / totKm, 2) : null, per_hour: totHours > 0 ? pyRound(totInc / totHours, 2) : null,
    symbol: "$", distance_unit: "km",
  };
}

function fyBounds(ref: Date, country = "AU"): [Date, Date] {
  const start = fyStart(ref, country);
  const end = country === "US" ? new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1)) : new Date(Date.UTC(start.getUTCFullYear() + 1, 6, 1));
  return [start, end];
}
function fyLabel(start: Date, country = "AU"): string {
  return country === "US" ? String(start.getUTCFullYear()) : `${start.getUTCFullYear()}–${String(start.getUTCFullYear() + 1).slice(2)}`;
}

export function taxJar(profile: Rec, report: Rec, ref: Date): Rec {
  const country = profile.country ?? "AU";
  const net = report.net_profit;
  const income = report.total_income;
  const fyS = fyStart(ref, country);
  if (country === "US") {
    const taxYear = usTaxYear(ref);
    const se = report.se_tax.amount;
    const taxable = Math.max(0, net - se / 2 - usStdDeduction(taxYear));
    const fed = usFederalIncomeTax(taxable, taxYear);
    const stTax = report.se_tax.state_tax ?? 0;
    const setAside = pyRound(se + fed + stTax, 2);
    const components: Rec[] = [{ label: "Self-employment tax", amount: se }, { label: "Federal income tax (est.)", amount: fed }];
    if (report.se_tax.state_has_tax) components.push({ label: `State income tax (est. · ${report.se_tax.state || ""})`, amount: stTax });
    return { set_aside: Math.max(0, setAside), rate_pct: net > 0 ? pyRound(setAside / net * 100, 1) : 0, net_profit: net, income, tax_year_label: fyLabel(fyS, country), components, symbol: report.symbol ?? "$", note: "Estimate for a single filer with gig income only, after the standard deduction. Includes federal, self-employment and approximate state income tax. Save this for SE tax and quarterly 1040-ES payments. Not tax advice." };
  }
  const it = auIncomeTax(Math.max(0, net));
  const gstOwed = report.show_bas ? Math.max(0, report.bas.net_gst) : 0;
  const setAside = pyRound(it + gstOwed, 2);
  const components: Rec[] = [{ label: "Income tax (est.)", amount: it }];
  if (report.show_bas) components.push({ label: "GST to remit", amount: pyRound(gstOwed, 2) });
  return { set_aside: Math.max(0, setAside), rate_pct: net > 0 ? pyRound(setAside / net * 100, 1) : 0, net_profit: net, income, tax_year_label: fyLabel(fyS, country), components, symbol: report.symbol ?? "$", note: "Estimate based on this financial year's net profit as your only income, resident rates incl. Medicare levy. Not tax advice." };
}

export function dashboard(profile: Rec, trips: Rec[], incomes: Rec[], expenses: Rec[], today: Date, vehicles?: Rec[] | null): Rec {
  const tIso = iso(today);
  const incomeToday = pyRound(incomes.filter((i) => String(i.date).slice(0, 10) === tIso).reduce((a, i) => a + num(i.amount), 0), 2);
  const expenseToday = pyRound(expenses.filter((e) => String(e.date).slice(0, 10) === tIso).reduce((a, e) => a + num(e.amount), 0), 2);
  const businessToday = pyRound(trips.filter((t) => String(t.date).slice(0, 10) === tIso).reduce((a, t) => a + tripBusinessKm(t), 0), 2);
  const country = profile.country ?? "AU";
  const [qStart, qEnd] = periodRange("quarter", today, country);
  const vehList = vehicles && vehicles.length ? vehicles : (profile.recurring_payment ? [{ recurring_payment: profile.recurring_payment }] : []);
  const recOwed = pyRound(vehList.reduce((a, v) => a + recurringOwed(v.recurring_payment, qStart, qEnd, today, vehEnd(v)), 0), 2);
  const activeRecs = vehList.filter((v) => v.recurring_payment && !vehDisposedBy(v, today)).map((v) => v.recurring_payment);
  const recEnabled = activeRecs.some((r) => r && r.amount);
  const recAmount = recEnabled ? pyRound(activeRecs.reduce((a, r) => a + num(r.amount), 0), 2) : null;
  const nextDues = activeRecs.map((r) => nextDueDate(r, today)).filter(Boolean) as string[];
  const nextDue = nextDues.length ? nextDues.sort()[0] : null;
  const freq = activeRecs.length === 1 ? activeRecs[0].frequency : activeRecs.length > 1 ? "mixed" : null;
  const items: Rec[] = [];
  for (const i of incomes) items.push({ kind: "income", id: i.id, date: String(i.date).slice(0, 10), created_at: i.created_at ?? "", title: i.platform ?? "Income", subtitle: "Income", amount: i.amount });
  for (const e of expenses) items.push({ kind: "expense", id: e.id, date: String(e.date).slice(0, 10), created_at: e.created_at ?? "", title: e.merchant || titleCase(String(e.category ?? "Expense")), subtitle: titleCase(String(e.category ?? "other")), amount: -num(e.amount) });
  for (const t of trips) items.push({ kind: "trip", id: t.id, date: String(t.date).slice(0, 10), created_at: t.created_at ?? "", title: `${t.distance_km} km trip`, subtitle: (t.type ?? "business") !== "personal" ? "Business" : "Personal", amount: null });
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : String(a.created_at) < String(b.created_at) ? 1 : -1));
  const taxSetup = country === "US" ? Boolean(profile.legal_name) : Boolean(profile.legal_name) && ["registered", "not_registered"].includes(profile.registration_status);
  const yearReport = computeReport(profile, trips, incomes, expenses, "year", today, vehicles);
  return {
    date: tIso, income_today: incomeToday, expense_today: expenseToday, net_today: pyRound(incomeToday - expenseToday, 2),
    business_distance_today: businessToday, currency: country === "US" ? "USD" : "AUD", symbol: "$", distance_unit: country === "US" ? "mi" : "km",
    recurring: { enabled: recEnabled, amount: recAmount, frequency: freq, owed_this_quarter: recOwed, next_due: nextDue, quarter_label: fmtPeriodLabel("quarter", qStart, qEnd, country) },
    recent: items.slice(0, 8), tax_setup_complete: taxSetup, tax_jar: taxJar(profile, yearReport, today),
  };
}

export function insights(profile: Rec, incomes: Rec[], expenses: Rec[], shifts: Rec[], ref: Date, weeksBack = 8, weekdayWeeks = 12): Rec {
  shifts = shifts ?? [];
  const monday = startOfWeek(ref, num(profile.week_start));
  const weekly = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const ws = addDays(monday, -7 * i);
    const we = addDays(ws, 7);
    const inc = incomes.filter((x) => inPeriod(x, ws, we)).reduce((a, x) => a + num(x.amount), 0);
    const exp = expenses.filter((x) => inPeriod(x, ws, we)).reduce((a, x) => a + num(x.amount), 0);
    const onlineH = shifts.filter((s) => inPeriod(s, ws, we)).reduce((a, s) => a + num(s.hours), 0);
    weekly.push({ label: fmtDM(ws), start: iso(ws), income: pyRound(inc, 2), expenses: pyRound(exp, 2), profit: pyRound(inc - exp, 2), hours: pyRound(onlineH, 2), per_hour: onlineH > 0 ? pyRound(inc / onlineH, 2) : null });
  }
  const wdStart = addDays(monday, -7 * (weekdayWeeks - 1));
  const wdEnd = addDays(monday, 7);
  const by = WD_SHORT.map((short, k) => ({ weekday: k, short, name: WD_LONG[k], income: 0, hours: 0, sessions: 0, per_hour: null as number | null }));
  for (const x of incomes) if (inPeriod(x, wdStart, wdEnd)) by[weekday(parseDate(x.date))].income += num(x.amount);
  let totalHours = 0;
  for (const s of shifts) if (inPeriod(s, wdStart, wdEnd)) {
    const k = weekday(parseDate(s.date));
    by[k].hours += num(s.hours);
    by[k].sessions += 1;
    totalHours += num(s.hours);
  }
  for (const d of by) {
    d.income = pyRound(d.income, 2);
    d.hours = pyRound(d.hours, 2);
    d.per_hour = d.hours > 0 ? pyRound(d.income / d.hours, 2) : null;
  }
  const totalIncome = pyRound(by.reduce((a, d) => a + d.income, 0), 2);
  const earners = by.filter((d) => d.income > 0);
  const bestEarning = earners.length ? earners.reduce((a, b) => a.income >= b.income ? a : b) : null;
  const hourly = by.filter((d) => d.per_hour != null);
  const bestHourly = hourly.length ? hourly.reduce((a, b) => (a.per_hour ?? 0) >= (b.per_hour ?? 0) ? a : b) : null;

  const dayIncome: Record<string, number> = {};
  const dayHours: Record<string, number> = {};
  for (const x of incomes) if (inPeriod(x, wdStart, wdEnd)) {
    const d = String(x.date).slice(0, 10);
    dayIncome[d] = (dayIncome[d] ?? 0) + num(x.amount);
  }
  for (const s of shifts) if (inPeriod(s, wdStart, wdEnd)) {
    const d = String(s.date).slice(0, 10);
    dayHours[d] = (dayHours[d] ?? 0) + num(s.hours);
  }
  const slots = [
    { key: "morning", label: "Morning", sub: "5am–11am", income: 0, hours: 0, per_hour: null as number | null },
    { key: "midday", label: "Midday", sub: "11am–3pm", income: 0, hours: 0, per_hour: null as number | null },
    { key: "evening", label: "Evening", sub: "3pm–9pm", income: 0, hours: 0, per_hour: null as number | null },
    { key: "late", label: "Late night", sub: "9pm–5am", income: 0, hours: 0, per_hour: null as number | null },
  ];
  const slotIdx: Record<string, number> = { morning: 0, midday: 1, evening: 2, late: 3 };
  const slotKey = (hhmm: string) => {
    const h = Number(String(hhmm).split(":")[0]);
    if (!Number.isFinite(h)) return null;
    if (h >= 5 && h < 11) return "morning";
    if (h >= 11 && h < 15) return "midday";
    if (h >= 15 && h < 21) return "evening";
    return "late";
  };
  const timed: Rec[] = [];
  for (const s of shifts) {
    if (!inPeriod(s, wdStart, wdEnd)) continue;
    const h = num(s.hours);
    const st = s.start_time;
    if (h <= 0 || !st) continue;
    const d = String(s.date).slice(0, 10);
    const dh = dayHours[d] ?? 0;
    const earned = dh > 0 ? (dayIncome[d] ?? 0) * (h / dh) : 0;
    const sk = slotKey(String(st));
    if (sk) {
      slots[slotIdx[sk]].income += earned;
      slots[slotIdx[sk]].hours += h;
    }
    timed.push({ id: s.id, date: d, start_time: st, end_time: s.end_time, hours: pyRound(h, 2), income: pyRound(earned, 2), per_hour: h > 0 ? pyRound(earned / h, 2) : null, platform: s.platform });
  }
  for (const sl of slots) {
    sl.income = pyRound(sl.income, 2);
    sl.hours = pyRound(sl.hours, 2);
    sl.per_hour = sl.hours > 0 ? pyRound(sl.income / sl.hours, 2) : null;
  }
  const ratedSlots = slots.filter((s) => s.per_hour != null);
  const bestTime = ratedSlots.length ? ratedSlots.reduce((a, b) => (a.per_hour ?? 0) >= (b.per_hour ?? 0) ? a : b) : null;
  const ratedShifts = timed.filter((t) => t.per_hour != null);
  const bestShift = ratedShifts.length ? ratedShifts.reduce((a, b) => a.per_hour >= b.per_hour ? a : b) : null;
  const worstShift = ratedShifts.length > 1 ? ratedShifts.reduce((a, b) => a.per_hour <= b.per_hour ? a : b) : null;
  const plat: Record<string, { income: number; hours: number }> = {};
  for (const x of incomes) if (inPeriod(x, wdStart, wdEnd)) {
    const name = x.platform || "Other";
    plat[name] = plat[name] ?? { income: 0, hours: 0 };
    plat[name].income += num(x.amount);
  }
  for (const s of shifts) if (inPeriod(s, wdStart, wdEnd)) {
    const name = s.platform || "Other";
    plat[name] = plat[name] ?? { income: 0, hours: 0 };
    plat[name].hours += num(s.hours);
  }
  const byPlatform = Object.entries(plat).map(([name, v]) => {
    const h = pyRound(v.hours, 2);
    const inc = pyRound(v.income, 2);
    return { name, income: inc, hours: h, per_hour: h > 0 ? pyRound(inc / h, 2) : null };
  }).sort((a, b) => b.income - a.income || b.hours - a.hours);
  return {
    symbol: "$", weeks_back: weeksBack, weekday_weeks: weekdayWeeks, weekly, by_weekday: by, by_platform: byPlatform,
    best_earning_day: bestEarning ? { short: bestEarning.short, name: bestEarning.name, income: bestEarning.income } : null,
    best_hourly_day: bestHourly ? { short: bestHourly.short, name: bestHourly.name, per_hour: bestHourly.per_hour } : null,
    has_income: totalIncome > 0, has_hours: totalHours > 0, avg_per_hour: totalHours > 0 ? pyRound(totalIncome / totalHours, 2) : null,
    by_timeofday: slots, best_timeofday: bestTime, best_shift: bestShift, worst_shift: worstShift, has_timed: ratedShifts.length > 0,
  };
}

export function moneyOverview(profile: Rec, trips: Rec[], incomes: Rec[], expenses: Rec[], shifts: Rec[], ref: Date, period = "week", vehicles?: Rec[] | null): Rec {
  const country = profile.country ?? "AU";
  const weekStart = num(profile.week_start);
  shifts = shifts ?? [];
  const [start, end] = period === "today" || period === "day" ? [ref, addDays(ref, 1)] : periodRange(period, ref, country, weekStart);
  const yearReport = computeReport(profile, trips, incomes, expenses, "year", ref, vehicles);
  const jar = taxJar(profile, yearReport, ref);
  const ytdNet = yearReport.net_profit;
  const ytdTax = jar.set_aside;
  const eff = Math.min(Math.max(ytdNet > 0 ? ytdTax / ytdNet : 0, 0), 0.6);
  const vehList = vehicles && vehicles.length ? vehicles : [{ id: "__default__", recurring_payment: profile.recurring_payment }];
  const rentFor = (s: Date, e: Date) => pyRound(vehList.reduce((a, v) => a + recurringOwed(v.recurring_payment, s, e, ref, vehEnd(v)), 0), 2);
  const core = (s: Date, e: Date) => {
    const gross = incomes.filter((i) => inPeriod(i, s, e)).reduce((a, i) => a + num(i.amount), 0);
    const exp = expenses.filter((x) => inPeriod(x, s, e)).reduce((a, x) => a + num(x.amount), 0) + rentFor(s, e);
    const profit = gross - exp;
    const tax = Math.max(0, profit) * eff;
    return [pyRound(gross, 2), pyRound(exp, 2), pyRound(profit, 2), pyRound(tax, 2), pyRound(profit - tax, 2)] as const;
  };
  const [gross, expensesTotal, profitBeforeTax, estimatedTax, moneyAfterTax] = core(start, end);
  const recurringRent = rentFor(start, end);
  const bizKm = pyRound(trips.filter((t) => inPeriod(t, start, end)).reduce((a, t) => a + tripBusinessKm(t), 0), 2);
  const hours = pyRound(shifts.filter((s) => inPeriod(s, start, end)).reduce((a, s) => a + num(s.hours), 0), 2);
  const activeHours = pyRound(shifts.filter((s) => inPeriod(s, start, end)).reduce((a, s) => a + num(s.active_hours), 0), 2);
  const activeBy: Record<string, number> = {};
  const platIncome: Record<string, number> = {};
  for (const s of shifts) if (inPeriod(s, start, end)) {
    for (const [p, h] of Object.entries(s.active_by_platform ?? {})) activeBy[p] = (activeBy[p] ?? 0) + num(h);
  }
  for (const i of incomes) if (inPeriod(i, start, end)) {
    const p = i.platform || "Other";
    platIncome[p] = (platIncome[p] ?? 0) + num(i.amount);
  }
  const byPlatform = [...new Set([...Object.keys(activeBy), ...Object.keys(platIncome)])].map((p) => {
    const ah = pyRound(activeBy[p] ?? 0, 2);
    const inc = pyRound(platIncome[p] ?? 0, 2);
    return { platform: p, active_hours: ah, income: inc, per_active_hour: ah > 0 ? pyRound(inc / ah, 2) : null };
  }).sort((a, b) => b.income - a.income || b.active_hours - a.active_hours);
  const cat: Record<string, number> = { fuel: 0, tolls: 0, vehicle: 0, phone: 0, other: 0 };
  for (const e of expenses) if (inPeriod(e, start, end)) cat[e.category ?? "other"] = (cat[e.category ?? "other"] ?? 0) + num(e.amount);
  const where = [
    { label: "Fuel / charging", amount: pyRound(cat.fuel, 2) },
    { label: "Vehicle costs", amount: pyRound(cat.vehicle, 2) },
    { label: "Vehicle rental/lease", amount: recurringRent },
    { label: "Tolls", amount: pyRound(cat.tolls, 2) },
    { label: "Phone", amount: pyRound(cat.phone, 2) },
    { label: "Other expenses", amount: pyRound(cat.other, 2) },
    { label: "Estimated tax", amount: estimatedTax },
  ].filter((w) => w.amount > 0);
  const wStart = period === "today" ? addDays(ref, -29) : start;
  const wEnd = period === "today" ? addDays(ref, 1) : end;
  const days: Record<string, Rec> = {};
  const bucket = (d: string) => days[d] ??= { date: d, income: 0, expenses: 0, hours: 0, km: 0 };
  for (const i of incomes) if (inPeriod(i, wStart, wEnd)) bucket(String(i.date).slice(0, 10)).income += num(i.amount);
  for (const x of expenses) if (inPeriod(x, wStart, wEnd)) bucket(String(x.date).slice(0, 10)).expenses += num(x.amount);
  for (const s of shifts) if (inPeriod(s, wStart, wEnd)) bucket(String(s.date).slice(0, 10)).hours += num(s.hours);
  for (const t of trips) if (inPeriod(t, wStart, wEnd)) bucket(String(t.date).slice(0, 10)).km += tripBusinessKm(t);
  const dayStat = (d: Rec) => {
    const prof = d.income - d.expenses;
    const after = prof - Math.max(0, prof) * eff;
    return { date: d.date, income: pyRound(d.income, 2), expenses: pyRound(d.expenses, 2), hours: pyRound(d.hours, 2), km: pyRound(d.km, 2), profit_before_tax: pyRound(prof, 2), real_per_hour: d.hours > 0 ? pyRound(after / d.hours, 2) : null, per_km: d.km > 0 ? pyRound(d.income / d.km, 2) : null };
  };
  const rated = Object.values(days).filter((d) => d.hours > 0 && d.income > 0).map(dayStat);
  const bestDay = rated.length ? rated.reduce((a, b) => (a.real_per_hour ?? 0) >= (b.real_per_hour ?? 0) ? a : b) : null;
  const worstDay = rated.length > 1 ? rated.reduce((a, b) => (a.real_per_hour ?? 0) <= (b.real_per_hour ?? 0) ? a : b) : null;
  const plat: Record<string, { income: number; hours: number }> = {};
  for (const i of incomes) if (inPeriod(i, wStart, wEnd)) {
    const name = i.platform || "Other";
    plat[name] = plat[name] ?? { income: 0, hours: 0 };
    plat[name].income += num(i.amount);
  }
  for (const s of shifts) if (inPeriod(s, wStart, wEnd)) {
    const name = s.platform || "Other";
    plat[name] = plat[name] ?? { income: 0, hours: 0 };
    plat[name].hours += num(s.hours);
  }
  const platforms = Object.entries(plat).map(([name, v]) => ({ name, income: pyRound(v.income, 2), hours: pyRound(v.hours, 2), per_hour: v.hours > 0 ? pyRound(v.income / v.hours, 2) : null }));
  const withHr = platforms.filter((p) => p.per_hour != null);
  let bestPlatform: Rec | null = null;
  let platformMetric = "income";
  if (withHr.length) {
    bestPlatform = withHr.reduce((a, b) => (a.per_hour ?? 0) >= (b.per_hour ?? 0) ? a : b);
    platformMetric = "per_hour";
  } else if (platforms.length) bestPlatform = platforms.reduce((a, b) => a.income >= b.income ? a : b);
  const vehded = yearReport.vehicle_deduction ?? {};
  const fullc = yearReport.full_claim ?? {};
  const breakdown = [
    { label: "Vehicle & mileage", amount: pyRound(vehded.total ?? 0, 2) },
    { label: "Phone", amount: pyRound(fullc.phone ?? 0, 2) },
    { label: "Tolls", amount: pyRound(fullc.tolls ?? 0, 2) },
    { label: "Other", amount: pyRound(fullc.other ?? 0, 2) },
  ].filter((b) => b.amount > 0);
  const setAside = num(profile.tax_set_aside);
  const position = pyRound(setAside - ytdTax, 2);
  const [ps, pe] = period === "today" || period === "day" ? [addDays(ref, -1), ref] : periodRange(period, addDays(periodRange(period, ref, country, weekStart)[0], -1), country, weekStart);
  const prev = core(ps, pe)[4];
  const trend = Math.abs(prev) > 0.01 ? pyRound((moneyAfterTax - prev) / Math.abs(prev) * 100, 1) : null;
  return {
    period, period_label: period === "today" ? fmtFull(start) : fmtPeriodLabel(period, start, end, country),
    period_start: iso(start), symbol: "$", distance_unit: country === "US" ? "mi" : "km", country,
    money_now: { take_home: moneyAfterTax, gross, expenses: expensesTotal, recurring_rent: recurringRent, estimated_tax: estimatedTax, profit_before_tax: profitBeforeTax, keep_rate: gross > 0 ? pyRound(moneyAfterTax / gross * 100, 1) : null, effective_tax_rate: pyRound(eff * 100, 1) },
    performance: { hours, active_hours: activeHours, utilisation: hours > 0 && activeHours > 0 ? pyRound(activeHours / hours * 100, 1) : null, km: bizKm, gross_per_hour: hours > 0 ? pyRound(gross / hours, 2) : null, real_per_hour: hours > 0 ? pyRound(moneyAfterTax / hours, 2) : null, active_per_hour: activeHours > 0 ? pyRound(gross / activeHours, 2) : null, real_active_per_hour: activeHours > 0 ? pyRound(moneyAfterTax / activeHours, 2) : null, per_km: bizKm > 0 ? pyRound(gross / bizKm, 2) : null, cost_per_km: bizKm > 0 ? pyRound(expensesTotal / bizKm, 2) : null, profit_per_km: bizKm > 0 ? pyRound(profitBeforeTax / bizKm, 2) : null, by_platform: byPlatform },
    where, intel_label: period === "today" ? "last 30 days" : (PERIOD_WORD[period] ?? "this period"),
    best_day: bestDay, worst_day: worstDay, best_platform: bestPlatform, platform_metric: platformMetric,
    platforms: platforms.slice().sort((a, b) => b.income - a.income),
    deductions: { total: yearReport.total_deductions, breakdown, estimated_tax_impact: pyRound(yearReport.total_deductions * eff, 2), tax_year_label: jar.tax_year_label },
    tax_position: { owed_ytd: pyRound(ytdTax, 2), set_aside: pyRound(setAside, 2), position, status: position >= 0 ? "ahead" : "behind", recommend_rate: jar.rate_pct, tax_year_label: jar.tax_year_label },
    trend_pct: trend, prev_take_home: pyRound(prev, 2),
  };
}

export function computeAnalytics(profile: Rec, trips: Rec[], incomes: Rec[], expenses: Rec[], shifts: Rec[], vehicles: Rec[], start: Date, end: Date, providers?: string[] | null, vehicleId?: string | null): Rec {
  const today = taxToday();
  const prov = providers && providers.length ? new Set(providers) : null;
  const inc = incomes.filter((i) => inPeriod(i, start, end) && (!prov || prov.has(i.platform || "Other")));
  const exp = expenses.filter((e) => inPeriod(e, start, end) && (!vehicleId || e.vehicle_id === vehicleId));
  const trp = trips.filter((t) => inPeriod(t, start, end) && (!vehicleId || t.vehicle_id === vehicleId));
  const shf = shifts.filter((s) => inPeriod(s, start, end) && (!vehicleId || s.vehicle_id === vehicleId));
  const gross = pyRound(inc.reduce((a, i) => a + num(i.amount), 0), 2);
  const inclusive = pyRound(inc.filter((i) => (i.tax_treatment ?? "inclusive") === "inclusive").reduce((a, i) => a + num(i.amount), 0), 2);
  const gstCollected = pyRound(inclusive / 11, 2);
  const expensesTotal = pyRound(exp.reduce((a, e) => a + num(e.amount), 0), 2);
  const cat: Record<string, number> = {};
  const catGst: Record<string, number> = {};
  for (const e of exp) {
    const c = e.category ?? "other";
    const amt = num(e.amount);
    cat[c] = pyRound((cat[c] ?? 0) + amt, 2);
    let g = 0;
    if ((e.tax_treatment ?? "inclusive") === "inclusive") g = e.gst != null && e.gst !== "" ? num(e.gst) : amt / 11;
    catGst[c] = pyRound((catGst[c] ?? 0) + g, 2);
  }
  let gstCredits = pyRound(Object.values(catGst).reduce((a, n) => a + n, 0), 2);
  let vehList = vehicles ?? [];
  if (vehicleId) vehList = vehList.filter((v) => v.id === vehicleId);
  const recurringGross = pyRound(vehList.reduce((a, v) => a + recurringOwed(v.recurring_payment, start, end, today, vehEnd(v)), 0), 2);
  const recGst = pyRound(vehList.filter((v) => ["lease", "rental", "loan"].includes(v.ownership) && v.recurring_payment).reduce((a, v) => a + recurringOwed(v.recurring_payment, start, end, today, vehEnd(v)) / 11, 0), 2);
  gstCredits = pyRound(gstCredits + recGst, 2);
  const businessKm = pyRound(trp.reduce((a, t) => a + tripBusinessKm(t), 0), 2);
  const totalKm = pyRound(trp.reduce((a, t) => a + num(t.distance_km), 0), 2);
  const businessUse = totalKm > 0 ? businessKm / totalKm : num(profile.business_use_fallback ?? 100) / 100;
  const hours = pyRound(shf.reduce((a, s) => a + num(s.hours), 0), 2);
  const activeBy: Record<string, number> = {};
  for (const s of shf) for (const [p, h] of Object.entries(s.active_by_platform ?? {})) {
    const n = Number(h);
    if (Number.isFinite(n)) activeBy[p] = pyRound((activeBy[p] ?? 0) + n, 2);
  }
  const apportioned = ((cat.fuel ?? 0) + (cat.vehicle ?? 0) + recurringGross) * businessUse;
  const full = (cat.tolls ?? 0) + (cat.phone ?? 0) + (cat.other ?? 0);
  const deductions = pyRound(apportioned + full, 2);
  const taxable = pyRound(gross - deductions, 2);
  const byProvInc: Record<string, number> = {};
  const byProvN: Record<string, number> = {};
  for (const i of inc) {
    const p = i.platform || "Other";
    byProvInc[p] = pyRound((byProvInc[p] ?? 0) + num(i.amount), 2);
    byProvN[p] = (byProvN[p] ?? 0) + 1;
  }
  const providersRows = Object.entries(byProvInc).map(([p, g]) => {
    const hrs = activeBy[p];
    return { provider: p, gross: g, count: byProvN[p] ?? 0, hours: hrs ?? null, per_hour: hrs ? pyRound(g / hrs, 2) : null, pct_of_income: gross ? pyRound(g / gross * 100, 1) : 0 };
  }).sort((a, b) => b.gross - a.gross);
  const per = (n: number, d: number) => d > 0 ? pyRound(n / d, 2) : null;
  const operating = pyRound(gross - expensesTotal, 2);
  const metrics = {
    cost_per_km: per(expensesTotal, totalKm), earnings_per_km: per(gross, totalKm), expense_per_business_km: per(expensesTotal, businessKm),
    income_per_business_km: per(gross, businessKm), net_per_business_km: per(operating, businessKm), earnings_per_hour: per(gross, hours),
    net_per_hour: per(operating, hours), net_profit_margin: gross ? pyRound(operating / gross * 100, 1) : null,
  };
  return {
    start: iso(start), end: iso(addDays(end, -1)), currency: "AUD", symbol: "$", distance_unit: "km",
    providers_applied: providers ?? [], vehicle_id: vehicleId ?? null,
    all_providers: [...new Set(incomes.map((i) => i.platform || "Other"))].sort(),
    income: { gross, inclusive, count: inc.length, by_provider: byProvInc },
    expenses: { total: expensesTotal, count: exp.length, by_category: cat, gst_by_category: catGst, recurring_gross: recurringGross },
    gst: { collected: gstCollected, credits: gstCredits, net_payable: pyRound(gstCollected - gstCredits, 2), inclusive_income: inclusive },
    tax: { gross_income: gross, total_deductions: deductions, taxable_profit: taxable, income_tax_est: auIncomeTax(taxable), business_use_pct: pyRound(businessUse * 100, 1), deduction_breakdown: { apportioned_running: pyRound(apportioned, 2), full_claim: pyRound(full, 2), recurring_gross: recurringGross } },
    km: { total: totalKm, business: businessKm, private: pyRound(totalKm - businessKm, 2), business_use_pct: pyRound(businessUse * 100, 1), trips: trp.length, has_data: totalKm > 0 },
    hours: { total: hours, active_by_provider: activeBy, has_data: hours > 0 },
    profitability: { gross_income: gross, expenses: expensesTotal, operating_profit: operating, ...metrics },
    providers: providersRows, metrics,
  };
}

function bestLogbook(trips: Rec[]): Rec | null {
  const dated = trips.filter((t) => t.distance_km).slice().sort((a, b) => parseDate(a.date).getTime() - parseDate(b.date).getTime());
  if (!dated.length) return null;
  const first = parseDate(dated[0].date);
  const last = parseDate(dated[dated.length - 1].date);
  const span = Math.round((last.getTime() - first.getTime()) / 86400000) + 1;
  const build = (start: Date, end: Date, complete: boolean) => {
    const window = dated.filter((t) => inPeriod(t, start, end));
    const tkm = window.reduce((a, t) => a + num(t.distance_km), 0);
    if (tkm <= 0) return null;
    const bkm = window.reduce((a, t) => a + tripBusinessKm(t), 0);
    if (bkm < 1) return null;
    return { start: iso(start), end: iso(addDays(end, -1)), start_label: fmtFull(start), end_label: fmtFull(addDays(end, -1)), business_km: pyRound(bkm, 2), private_km: pyRound(tkm - bkm, 2), total_km: pyRound(tkm, 2), business_pct: pyRound(bkm / tkm * 100, 2), journeys: window.length, complete, window, _score: [pyRound(bkm / tkm, 4), pyRound(tkm, 2)] as [number, number] };
  };
  if (span < LOGBOOK_WINDOW_DAYS) {
    const w = build(first, addDays(last, 1), false);
    if (!w) return null;
    const { _score: _ignored, ...rest } = w;
    return rest;
  }
  let best: Rec | null = null;
  const latest = addDays(addDays(last, 1), -LOGBOOK_WINDOW_DAYS);
  for (const anchor of dated) {
    const start = parseDate(anchor.date);
    if (start.getTime() > latest.getTime()) continue;
    const w = build(start, addDays(start, LOGBOOK_WINDOW_DAYS), true);
    if (!w) continue;
    if (!best || w._score[0] > best._score[0] || (w._score[0] === best._score[0] && w._score[1] > best._score[1])) best = w;
  }
  if (!best) best = build(first, addDays(last, 1), false);
  if (!best) return null;
  const { _score: _ignored, ...rest } = best;
  return rest;
}

function journeyRows(rows: Rec[], us: boolean): Rec[] {
  return rows.slice().sort((a, b) => parseDate(a.date).getTime() - parseDate(b.date).getTime()).slice(0, 200).map((t) => ({
    id: t.id, date: String(t.date).slice(0, 10), date_label: fmtFull(parseDate(t.date), us),
    distance_km: pyRound(num(t.distance_km), 2), business_km: tripBusinessKm(t), type: t.type ?? "business",
    purpose: t.purpose ?? null, from_label: t.from_label ?? null, to_label: t.to_label ?? null, odo_start: t.odo_start ?? null, odo_end: t.odo_end ?? null,
  }));
}

function logbookSummary(_profile: Rec, trips: Rec[], ref: Date, country = "AU"): Rec {
  const us = country === "US";
  const [fyS, fyE] = fyBounds(ref, country);
  const fyTrips = trips.filter((t) => inPeriod(t, fyS, fyE));
  if (us) {
    const biz = pyRound(fyTrips.reduce((a, t) => a + tripBusinessKm(t), 0), 2);
    const tot = pyRound(fyTrips.reduce((a, t) => a + num(t.distance_km), 0), 2);
    if (tot <= 0) return { available: false, business_pct: null, message: "Log business and personal miles to build your IRS mileage log." };
    return { available: true, us_mode: true, period_start: iso(fyS), period_end: iso(addDays(fyE, -1)), period_label: fyLabel(fyS, country), business_km: biz, private_km: pyRound(tot - biz, 2), total_km: tot, business_pct: pyRound(biz / tot * 100, 2), journey_count: fyTrips.length, complete: true, journeys: journeyRows(fyTrips, true), note: "Keep a contemporaneous mileage log — date, purpose and miles for each business trip supports your Schedule C car expenses." };
  }
  const lb = bestLogbook(fyTrips) ?? bestLogbook(trips);
  if (!lb) return { available: false, business_pct: null, message: "Log at least a few business and private trips to build your 12-week ATO logbook." };
  const window = (lb.window ?? []) as Rec[];
  delete lb.window;
  return { available: true, period_start: lb.start, period_end: lb.end, period_label: `${lb.start_label} – ${lb.end_label}`, business_km: lb.business_km, private_km: lb.private_km, total_km: lb.total_km, business_pct: lb.business_pct, journey_count: lb.journeys, complete: lb.complete, journeys: journeyRows(window, false), note: "A valid ATO logbook must cover a continuous 12-week period that represents your typical driving. Keep going for the full 12 weeks." };
}

function fyVehicleExpenses(expenses: Rec[], fyS: Date, fyE: Date, recurring: Rec | null | undefined, disposal?: Date | null) {
  const cats: Record<string, number> = { fuel: 0, vehicle: 0, tolls: 0, phone: 0, other: 0 };
  for (const e of expenses) if (inPeriod(e, fyS, fyE)) cats[e.category ?? "other"] = (cats[e.category ?? "other"] ?? 0) + num(e.amount);
  const rec = recurringOwed(recurring, fyS, fyE, taxToday(), disposal);
  for (const k of Object.keys(cats)) cats[k] = pyRound(cats[k], 2);
  return { cats, recurring: pyRound(rec, 2), eligible: pyRound(cats.fuel + cats.vehicle + rec, 2) };
}

function methodComparison(profile: Rec, trips: Rec[], expenses: Rec[], ref: Date, vehicle?: Rec | null, country = "AU"): Rec {
  const us = country === "US";
  const [fyS, fyE] = fyBounds(ref, country);
  const fyTrips = trips.filter((t) => inPeriod(t, fyS, fyE));
  const businessKm = pyRound(fyTrips.reduce((a, t) => a + tripBusinessKm(t), 0), 2);
  const totalKm = pyRound(fyTrips.reduce((a, t) => a + num(t.distance_km), 0), 2);
  let logbookPct: number;
  let pctSource: string;
  if (us) {
    logbookPct = totalKm > 0 ? businessKm / totalKm : num(profile.business_use_fallback ?? 100) / 100;
    pctSource = totalKm > 0 ? "annual" : "fallback";
  } else {
    const lb = bestLogbook(fyTrips) ?? bestLogbook(trips);
    if (lb) { logbookPct = lb.business_pct / 100; pctSource = "logbook"; }
    else if (totalKm > 0) { logbookPct = businessKm / totalKm; pctSource = "derived"; }
    else { logbookPct = num(profile.business_use_fallback ?? 100) / 100; pctSource = "fallback"; }
  }
  const recurring = vehicle ? vehicle.recurring_payment : profile.recurring_payment;
  const { cats, recurring: recAmt, eligible } = fyVehicleExpenses(expenses, fyS, fyE, recurring, vehEnd(vehicle));
  const actual = pyRound(eligible * logbookPct, 2);
  let rate: number, mileage: number, capped: boolean, claimable: number, maxDed: number | null, detail: string;
  if (us) {
    rate = usMileageRate(fyS);
    mileage = usStandardMileageDeduction(fyTrips);
    capped = false; claimable = businessKm; maxDed = null;
    detail = `${businessKm} mi · IRS rate`;
  } else {
    rate = cpkRate(fyS.getUTCFullYear());
    claimable = Math.min(businessKm, AU_CPK_MAX_KM);
    mileage = pyRound(claimable * rate, 2);
    capped = businessKm > AU_CPK_MAX_KM;
    maxDed = pyRound(AU_CPK_MAX_KM * rate, 2);
    detail = `${pyRound(rate * 100)}c × ${pyRound(claimable)} km${capped ? " (cap)" : ""}`;
  }
  const recommend = actual >= mileage ? "logbook" : "cents_per_km";
  return {
    country, unit: us ? "mi" : "km", fy_start: iso(fyS), fy_end: iso(fyE), fy_label: fyLabel(fyS, country),
    business_km: businessKm, total_km: totalKm,
    logbook: { title: us ? "Actual expenses" : "Logbook", business_pct: pyRound(logbookPct * 100, 2), pct_source: pctSource, eligible_expenses: eligible, expense_breakdown: { fuel: cats.fuel, vehicle: cats.vehicle, recurring_payment: recAmt }, deduction: actual },
    cents_per_km: { title: us ? "Standard mileage" : "Cents / km", detail, rate, rate_cents: pyRound(rate * 100), max_km: us ? null : AU_CPK_MAX_KM, claimable_km: pyRound(claimable, 2), capped, deduction: mileage, max_deduction: maxDed },
    recommend, recommend_label: recommend === "logbook" ? (us ? "Actual expense method" : "Logbook method") : (us ? "Standard mileage" : "Cents per kilometre"),
    recommended_deduction: recommend === "logbook" ? actual : mileage, difference: pyRound(Math.abs(actual - mileage), 2),
    disclaimer: us
      ? "This is an estimate, not tax advice. Your final deduction depends on your actual expenses and IRS rules — report car & truck expenses on Schedule C."
      : "This is an estimate, not tax advice. Your final deduction depends on your actual eligible expenses, vehicle circumstances and ATO requirements.",
  };
}

function odometerCheck(vehicle: Rec | null | undefined, trips: Rec[], ref: Date): Rec {
  const [fyS, fyE] = fyBounds(ref);
  const v = vehicle ?? {};
  const gps = pyRound(trips.filter((t) => inPeriod(t, fyS, fyE)).reduce((a, t) => a + num(t.distance_km), 0), 2);
  const opening = v.opening_odometer;
  const closing = v.closing_odometer;
  if (opening == null || closing == null) {
    return { has_odometer: false, gps_km: gps, odometer_km: null, opening, closing, discrepancy: null, discrepancy_pct: null, warning: null, prompt: "Enter your odometer at the start (1 July) and end (30 June) of the financial year for an audit-proof total." };
  }
  const odo = pyRound(num(closing) - num(opening), 2);
  const disc = pyRound(odo - gps, 2);
  const pct = odo > 0 ? pyRound(Math.abs(disc) / odo * 100, 1) : 0;
  const warnKm = (n: number) => pyRound(n, 0).toLocaleString("en-US");
  const warning = odo > 0 && pct >= 10 ? `Your GPS records show ${warnKm(gps)} km but your odometer shows ${warnKm(odo)} km. Review your mileage records.` : null;
  return { has_odometer: true, gps_km: gps, odometer_km: odo, opening: pyRound(num(opening), 2), closing: pyRound(num(closing), 2), discrepancy: disc, discrepancy_pct: pct, warning };
}

export function taxMileage(profile: Rec, trips: Rec[], incomes: Rec[], expenses: Rec[], ref: Date, vehicles?: Rec[] | null, vehicleId?: string | null): Rec {
  const country = profile.country ?? "AU";
  const us = country === "US";
  const [fyS, fyE] = fyBounds(ref, country);
  const vehList = vehicles ?? [];
  const active = vehList.find((v) => v.is_active) ?? null;
  const selected = (vehicleId ? vehList.find((v) => v.id === vehicleId) : null) ?? active ?? vehList[0] ?? null;
  const selId = selected?.id ?? null;
  const vTrips = selId ? trips.filter((t) => t.vehicle_id === selId) : trips;
  const vExp = selId ? expenses.filter((e) => e.vehicle_id === selId) : expenses;
  const tIso = iso(ref);
  const todayTrips = trips.filter((t) => String(t.date).slice(0, 10) === tIso);
  const todayBiz = pyRound(todayTrips.reduce((a, t) => a + tripBusinessKm(t), 0), 2);
  const todayPriv = pyRound(todayTrips.reduce((a, t) => a + tripPersonalKm(t), 0), 2);
  const todayTotal = pyRound(todayBiz + todayPriv, 2);
  const todayIncome = pyRound(incomes.filter((i) => String(i.date).slice(0, 10) === tIso).reduce((a, i) => a + num(i.amount), 0), 2);
  const fyTrips = trips.filter((t) => inPeriod(t, fyS, fyE));
  const fyBiz = pyRound(fyTrips.reduce((a, t) => a + tripBusinessKm(t), 0), 2);
  const fyPriv = pyRound(fyTrips.reduce((a, t) => a + tripPersonalKm(t), 0), 2);
  const fyTotal = pyRound(fyBiz + fyPriv, 2);
  const fyIncome = pyRound(incomes.filter((i) => inPeriod(i, fyS, fyE)).reduce((a, i) => a + num(i.amount), 0), 2);
  const summaries = vehList.map((v) => {
    const mc = methodComparison(profile, trips.filter((t) => t.vehicle_id === v.id), expenses.filter((e) => e.vehicle_id === v.id), ref, v, country);
    return { id: v.id, name: v.name || v.make_model || "Vehicle", registration: v.registration, is_active: Boolean(v.is_active), business_km: mc.business_km, business_pct: mc.logbook.business_pct, recommend_label: mc.recommend_label, deduction: mc.recommended_deduction };
  });
  return {
    country, currency: us ? "USD" : "AUD", symbol: "$", distance_unit: us ? "mi" : "km",
    today: { date: tIso, total_km: todayTotal, business_km: todayBiz, private_km: todayPriv, business_pct: todayTotal > 0 ? pyRound(todayBiz / todayTotal * 100, 1) : 0, income: todayIncome, per_business_km: todayBiz > 0 ? pyRound(todayIncome / todayBiz, 2) : null },
    financial_year: { label: fyLabel(fyS, country), start: iso(fyS), end: iso(fyE), total_km: fyTotal, business_km: fyBiz, private_km: fyPriv, business_pct: fyTotal > 0 ? pyRound(fyBiz / fyTotal * 100, 2) : 0, income: fyIncome, per_business_km: fyBiz > 0 ? pyRound(fyIncome / fyBiz, 2) : null },
    logbook: logbookSummary(profile, vTrips, ref, country),
    method_comparison: methodComparison(profile, vTrips, vExp, ref, selected, country),
    odometer: odometerCheck(selected, vTrips, ref),
    vehicle: selected ?? (profile.vehicle ?? {}),
    vehicles: summaries, selected_vehicle_id: selId, active_vehicle_id: active?.id ?? selId,
  };
}
