import type { UEJob } from "@/src/ueParse";
import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;
const PID_KEY = "gigtax.profile_id";

function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let _pid: string | null = null;
let _authPid: string | null = null;
let _authToken: string | null = null;
let _pidPromise: Promise<string> | null = null;

export function setAuthProfileId(id: string | null) { _authPid = id; }
export function setAuthToken(t: string | null) { _authToken = t; }

// Server-side paywall: write/premium routes answer 402 {detail:{code:"subscription_required"}}
// once the 14-day trial is over without an active subscription. One global
// listener (SubscriptionProvider) reacts by refreshing status + opening the paywall.
export const PAYWALL_CODE = "subscription_required";
export class PaywallError extends Error {
  code = PAYWALL_CODE;
  constructor(msg: string) { super(msg); this.name = "PaywallError"; }
}
let _paywallListener: ((msg: string) => void) | null = null;
export function setPaywallListener(fn: ((msg: string) => void) | null) { _paywallListener = fn; }

export interface SubscriptionStatus {
  state: "trial" | "active" | "grace" | "expired";
  trial_started_at?: string | null;
  trial_ends_at: string | null;
  days_left: number | null;
  entitlement: string | null;
  expires_at?: string | null;
  is_demo?: boolean;
  enforced: boolean;
  trial_days: number;
}

// Durable local identity that scopes ALL of a driver's data. This MUST survive
// the Android OS killing a backgrounded app and cold-starting it. We keep TWO
// copies — AsyncStorage (primary) and SecureStore/Keychain (durable mirror that
// survives cache clears) — and only ever mint a NEW id when BOTH are genuinely
// empty (true first run). A transient read failure returns the fallback, so we
// must never regenerate just because the primary read came back empty once.
export async function getLocalProfileId(): Promise<string> {
  if (_pidPromise) return _pidPromise;           // coalesce concurrent callers
  _pidPromise = (async () => {
    // 1) Primary store.
    const primary = await storage.getItem<string>(PID_KEY, "");
    if (primary) {
      // Keep the durable mirror in sync (cheap, idempotent).
      const mirror = await storage.secureGet<string>(PID_KEY, "");
      if (mirror !== primary) await storage.secureSet(PID_KEY, primary);
      return primary;
    }
    // 2) Primary empty — fall back to the durable mirror and restore it.
    const mirror = await storage.secureGet<string>(PID_KEY, "");
    if (mirror) {
      await storage.setItem(PID_KEY, mirror);
      return mirror;
    }
    // 3) Genuinely first run on this device — mint once, persist to BOTH.
    const id = uuid();
    await storage.setItem(PID_KEY, id);
    await storage.secureSet(PID_KEY, id);
    return id;
  })();
  try { return await _pidPromise; }
  finally { _pidPromise = null; }
}

export async function getProfileId(): Promise<string> {
  if (_authPid) return _authPid;
  if (_pid) return _pid;
  _pid = await getLocalProfileId();
  return _pid;
}

// Forget the current local profile so a brand-new one is generated on next
// access (used after account deletion → fresh onboarding).
export async function resetLocalProfileId(): Promise<void> {
  _pid = null;
  _authPid = null;
  _pidPromise = null;
  await storage.removeItem(PID_KEY);
  await storage.secureRemove(PID_KEY);
}

async function req(path: string, opts: RequestInit = {}, retries = 2, timeoutMs = 15000): Promise<any> {
  const method = (opts.method || "GET").toUpperCase();
  // Only GET/PUT/DELETE are safe to auto-retry; POST is not idempotent.
  const canRetry = method !== "POST";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      ...opts,
      signal: controller.signal,
      headers: { "Content-Type": "application/json",
        ...(_authToken ? { Authorization: `Bearer ${_authToken}` } : {}),
        ...(opts.headers || {}) },
    });
    clearTimeout(timer);
    if (!res.ok) {
      // Transient gateway errors (backend restarting) — retry idempotent calls.
      if (canRetry && [502, 503, 504].includes(res.status) && retries > 0) {
        await new Promise((r) => setTimeout(r, 800));
        return req(path, opts, retries - 1);
      }
      const t = await res.text();
      if (res.status === 402) {
        let msg = "Your 14-day free trial has ended. Subscribe to keep adding records.";
        try { const d = JSON.parse(t)?.detail; if (d?.code === PAYWALL_CODE && d.message) msg = d.message; } catch { /* not JSON */ }
        try { _paywallListener?.(msg); } catch { /* listener errors never mask the 402 */ }
        throw new PaywallError(msg);
      }
      throw new Error(`${res.status}: ${t.slice(0, 120)}`);
    }
    return res.json();
  } catch (e: any) {
    clearTimeout(timer);
    const transient = e?.name === "AbortError" || /network/i.test(e?.message || "");
    if (canRetry && retries > 0 && transient) {
      await new Promise((r) => setTimeout(r, 800));
      return req(path, opts, retries - 1);
    }
    throw e;
  }
}

export interface VehicleT {
  id?: string;
  profile_id?: string;
  name?: string | null;
  registration?: string | null;
  make_model?: string | null;
  year?: number | null;
  purchase_price?: number | null;
  fuel_type?: "petrol" | "diesel" | "hybrid" | "electric" | "lpg" | null;
  business_use_start?: string | null;
  ownership?: "own" | "loan" | "lease" | "rental" | "rent_to_buy";
  recurring_payment?: {
    amount: number;
    frequency: "weekly" | "fortnightly" | "monthly";
    anchor_type: "acquisition" | "gigstart";
    anchor_date: string;
  } | null;
  opening_odometer?: number | null;
  opening_odometer_date?: string | null;
  closing_odometer?: number | null;
  closing_odometer_date?: string | null;
  gps_calibration_pct?: number | null;
  disposal_date?: string | null;
  is_active?: boolean;
}

export interface ProfileT {
  profile_id: string;
  country: string;
  region?: string | null;
  driver_name?: string | null;
  work_type: "passengers" | "delivery" | "both";
  platforms: string[];
  vehicle_ownership: "own" | "loan" | "lease" | "rental" | "rent_to_buy";
  acquisition_date?: string | null;
  recurring_payment?: {
    amount: number;
    frequency: "weekly" | "fortnightly" | "monthly";
    anchor_type: "acquisition" | "gigstart";
    anchor_date: string;
  } | null;
  legal_name?: string | null;
  accounting_method: "cash" | "accrual";
  tax_id_on_file: boolean;
  registration_status?: "registered" | "not_registered" | "unknown" | null;
  registration_date?: string | null;
  reporting_frequency?: string | null;
  business_use_fallback: number;
  weekly_goal?: number | null;
  week_start?: number | null;
  tax_set_aside?: number | null;
  vehicle?: VehicleT | null;
  theme: "dark" | "light";
  onboarded: boolean;
}

export interface TripT {
  id: string; profile_id: string; date: string; distance_km: number;
  duration_min?: number | null;
  type: "business" | "personal" | "mixed"; business_pct?: number | null;
  purpose?: string | null; vehicle_id?: string | null;
  from_label?: string | null; to_label?: string | null;
  odo_start?: number | null; odo_end?: number | null;
  note?: string | null; source?: string;
  start_time?: string | null; end_time?: string | null;
}
export interface IncomeT {
  id: string; profile_id: string; date: string; amount: number;
  platform?: string | null; tax_treatment: string; note?: string | null;
}
export interface ExpenseT {
  id: string; profile_id: string; date: string; amount: number;
  category: "fuel" | "tolls" | "vehicle" | "phone" | "other";
  liters?: number | null;
  gst?: number | null;
  merchant?: string | null; vehicle_id?: string | null;
  tax_treatment: string; note?: string | null;
  receipt_image?: string | null;
  has_receipt?: boolean;
}
export interface ShiftT {
  id: string; profile_id: string; date: string; hours: number;
  active_hours?: number | null;
  active_by_platform?: Record<string, number> | null;
  start_time?: string | null; end_time?: string | null;
  platform?: string | null; vehicle_id?: string | null; note?: string | null;
}

// URLs opened in a browser / OS handler (exports, Drive connect) can't carry the
// Authorization header, so ask the backend for a short-lived (5 min), single-use
// ticket and put that in the URL instead of the long-lived session token.
async function ticketParam(): Promise<string> {
  const { ticket } = await req(`/auth/ticket`, { method: "POST" }, 0);
  return `ticket=${encodeURIComponent(ticket)}`;
}

export const api = {
  subscriptionStatus: (refresh = false): Promise<SubscriptionStatus> =>
    req(`/subscription/status${refresh ? "?refresh=true" : ""}`),
  async authMe() { return req(`/auth/me`); },
  async authLogout() { return req(`/auth/logout`, { method: "POST" }); },
  async authClaim(fromProfileId: string) {
    return req(`/auth/claim`, { method: "POST", body: JSON.stringify({ from_profile_id: fromProfileId }) });
  },
  async deleteAccount() {
    // The backend deletes the account of the signed-in session (Bearer header).
    return req(`/account`, { method: "DELETE" });
  },

  // ---- Google Drive backup ----
  async backupStatus() {
    const pid = await getProfileId();
    return req(`/backups/status?profile_id=${pid}`);
  },
  async runBackup() {
    const pid = await getProfileId();
    // Backups can take a while (uploads) — long timeout, no auto-retry.
    return req(`/backups/google-drive?profile_id=${pid}`, { method: "POST" }, 0, 120000);
  },
  async restoreBackup() {
    const pid = await getProfileId();
    // Restore downloads + rewrites records — long timeout, no auto-retry.
    return req(`/backups/restore?profile_id=${pid}`, { method: "POST" }, 0, 120000);
  },
  async disconnectBackup() {
    const pid = await getProfileId();
    return req(`/backups/disconnect?profile_id=${pid}`, { method: "POST" });
  },
  async driveConnectUrl(redirect: string) {
    return `${BASE}/api/auth/google/start?backup=1&${await ticketParam()}&app_redirect=${encodeURIComponent(redirect)}`;
  },
  async getProfile(): Promise<ProfileT> {
    const pid = await getProfileId();
    return req(`/profile?profile_id=${pid}`);
  },
  async saveProfile(patch: Partial<ProfileT>): Promise<ProfileT> {
    const pid = await getProfileId();
    return req(`/profile`, { method: "PUT", body: JSON.stringify({ ...patch, profile_id: pid }) });
  },
  async listTrips(): Promise<TripT[]> {
    const pid = await getProfileId();
    return req(`/trips?profile_id=${pid}`);
  },
  async addTrip(t: Partial<TripT>) {
    const pid = await getProfileId();
    return req(`/trips`, { method: "POST", body: JSON.stringify({ ...t, profile_id: pid }) });
  },
  updateTrip: (id: string, t: Partial<TripT>) =>
    req(`/trips/${id}`, { method: "PUT", body: JSON.stringify(t) }),
  deleteTrip: (id: string) => req(`/trips/${id}`, { method: "DELETE" }),

  async listIncome(): Promise<IncomeT[]> {
    const pid = await getProfileId();
    return req(`/income?profile_id=${pid}`);
  },
  async addIncome(i: Partial<IncomeT>) {
    const pid = await getProfileId();
    return req(`/income`, { method: "POST", body: JSON.stringify({ ...i, profile_id: pid }) });
  },
  updateIncome: (id: string, i: Partial<IncomeT>) =>
    req(`/income/${id}`, { method: "PUT", body: JSON.stringify(i) }),
  deleteIncome: (id: string) => req(`/income/${id}`, { method: "DELETE" }),

  async listExpenses(): Promise<ExpenseT[]> {
    const pid = await getProfileId();
    return req(`/expenses?profile_id=${pid}`);
  },
  async getExpense(id: string): Promise<ExpenseT> {
    const pid = await getProfileId();
    return req(`/expenses/${id}?profile_id=${pid}`);
  },
  async addExpense(e: Partial<ExpenseT>) {
    const pid = await getProfileId();
    return req(`/expenses`, { method: "POST", body: JSON.stringify({ ...e, profile_id: pid }) });
  },
  updateExpense: (id: string, e: Partial<ExpenseT>) =>
    req(`/expenses/${id}`, { method: "PUT", body: JSON.stringify(e) }),
  deleteExpense: (id: string) => req(`/expenses/${id}`, { method: "DELETE" }),

  async listShifts(): Promise<ShiftT[]> {
    const pid = await getProfileId();
    return req(`/shifts?profile_id=${pid}`);
  },
  async addShift(s: Partial<ShiftT>) {
    const pid = await getProfileId();
    return req(`/shifts`, { method: "POST", body: JSON.stringify({ ...s, profile_id: pid }) });
  },
  updateShift: (id: string, s: Partial<ShiftT>) =>
    req(`/shifts/${id}`, { method: "PUT", body: JSON.stringify(s) }),
  deleteShift: (id: string) => req(`/shifts/${id}`, { method: "DELETE" }),

  async scanReceipt(image_base64: string) {
    return req(`/receipts/scan`, { method: "POST", body: JSON.stringify({ image_base64 }) });
  },
  async dashboard(refDate: string) {
    const pid = await getProfileId();
    return req(`/dashboard?profile_id=${pid}&ref_date=${refDate}`);
  },
  async performance(refDate: string) {
    const pid = await getProfileId();
    return req(`/performance?profile_id=${pid}&ref_date=${refDate}`);
  },
  async insights(refDate: string) {
    const pid = await getProfileId();
    return req(`/insights?profile_id=${pid}&ref_date=${refDate}`);
  },
  async money(period: string, refDate: string) {
    const pid = await getProfileId();
    return req(`/money?profile_id=${pid}&period=${period}&ref_date=${refDate}`);
  },
  async taxMileage(refDate: string, vehicleId?: string) {
    const pid = await getProfileId();
    const vq = vehicleId ? `&vehicle_id=${vehicleId}` : "";
    return req(`/tax-mileage?profile_id=${pid}&ref_date=${refDate}${vq}`);
  },
  async listVehicles(): Promise<VehicleT[]> {
    const pid = await getProfileId();
    return req(`/vehicles?profile_id=${pid}`);
  },
  async addVehicle(v: Partial<VehicleT>): Promise<VehicleT[]> {
    const pid = await getProfileId();
    return req(`/vehicles`, { method: "POST", body: JSON.stringify({ ...v, profile_id: pid }) });
  },
  async updateVehicle(id: string, v: Partial<VehicleT>): Promise<VehicleT[]> {
    return req(`/vehicles/${id}`, { method: "PUT", body: JSON.stringify(v) });
  },
  async activateVehicle(id: string): Promise<VehicleT[]> {
    const pid = await getProfileId();
    return req(`/vehicles/${id}/activate?profile_id=${pid}`, { method: "POST" });
  },
  async deleteVehicle(id: string): Promise<VehicleT[]> {
    const pid = await getProfileId();
    return req(`/vehicles/${id}?profile_id=${pid}`, { method: "DELETE" });
  },
  async report(period: string, refDate: string) {
    const pid = await getProfileId();
    return req(`/reports?profile_id=${pid}&period=${period}&ref_date=${refDate}`);
  },
  async reportAnalytics(start: string, end: string, providers?: string[], vehicleId?: string) {
    const pid = await getProfileId();
    const qs = [`profile_id=${pid}`, `start=${start}`, `end=${end}`];
    if (providers && providers.length) qs.push(`providers=${encodeURIComponent(providers.join(","))}`);
    if (vehicleId) qs.push(`vehicle_id=${vehicleId}`);
    return req(`/reports/analytics?${qs.join("&")}`);
  },
  async exportUrl(period: string, refDate: string) {
    const pid = await getProfileId();
    return `${BASE}/api/export?profile_id=${pid}&period=${period}&ref_date=${refDate}&${await ticketParam()}`;
  },
  async exportMileageUrl(refDate: string) {
    const pid = await getProfileId();
    return `${BASE}/api/export-mileage?profile_id=${pid}&ref_date=${refDate}&${await ticketParam()}`;
  },
  // ---- Uber Eats guarantee
  async ueJobs(start?: string, end?: string): Promise<UEJob[]> {
    const pid = await getProfileId();
    return req(`/ue/jobs?profile_id=${pid}${start && end ? `&start=${start}&end=${end}` : ""}`);
  },
  async ueAddJobs(jobs: UEJob[]): Promise<{ saved: UEJob[]; duplicates: number[] }> {
    const profile_id = await getProfileId();
    return req(`/ue/jobs`, { method: "POST", body: JSON.stringify({ profile_id, jobs }) }, 0);
  },
  async ueUpdateJob(id: string, j: Partial<UEJob>): Promise<UEJob> {
    return req(`/ue/jobs/${id}`, { method: "PUT", body: JSON.stringify(j) }, 0);
  },
  async ueDeleteJob(id: string) {
    return req(`/ue/jobs/${id}`, { method: "DELETE" }, 0);
  },
  async ueGuarantee(cycleStart?: string): Promise<any> {
    const pid = await getProfileId();
    return req(`/ue/guarantee?profile_id=${pid}${cycleStart ? `&cycle_start=${cycleStart}` : ""}`);
  },
  async ueMismatches(): Promise<{ date: string; platform: string; jobs_total: number; income_logged: number; difference: number }[]> {
    const pid = await getProfileId();
    return req(`/ue/mismatches?profile_id=${pid}`);
  },
  async ueExportUrl(cycleStart: string) {
    const pid = await getProfileId();
    return `${BASE}/api/ue/export?profile_id=${pid}&cycle_start=${cycleStart}&${await ticketParam()}`;
  },
  async ask(question: string, country: string, history: { role: string; text: string }[] = []) {
    return req(`/ask`, { method: "POST", body: JSON.stringify({ question, country, history }) }, 0, 45000);
  },
};

export const todayISO = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD local
