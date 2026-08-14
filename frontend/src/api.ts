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

export async function getProfileId(): Promise<string> {
  if (_pid) return _pid;
  let id = await storage.getItem<string>(PID_KEY, "");
  if (!id) {
    id = uuid();
    await storage.setItem(PID_KEY, id);
  }
  _pid = id;
  return id;
}

async function req(path: string, opts: RequestInit = {}, retries = 2): Promise<any> {
  const method = (opts.method || "GET").toUpperCase();
  // Only GET/PUT/DELETE are safe to auto-retry; POST is not idempotent.
  const canRetry = method !== "POST";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      ...opts,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    clearTimeout(timer);
    if (!res.ok) {
      // Transient gateway errors (backend restarting) — retry idempotent calls.
      if (canRetry && [502, 503, 504].includes(res.status) && retries > 0) {
        await new Promise((r) => setTimeout(r, 800));
        return req(path, opts, retries - 1);
      }
      const t = await res.text();
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
  theme: "dark" | "light";
  onboarded: boolean;
}

export interface TripT {
  id: string; profile_id: string; date: string; distance_km: number;
  duration_min?: number | null;
  type: "business" | "personal"; note?: string | null; source?: string;
}
export interface IncomeT {
  id: string; profile_id: string; date: string; amount: number;
  platform?: string | null; tax_treatment: string; note?: string | null;
}
export interface ExpenseT {
  id: string; profile_id: string; date: string; amount: number;
  category: "fuel" | "tolls" | "vehicle" | "phone" | "other";
  merchant?: string | null; tax_treatment: string; note?: string | null;
  receipt_image?: string | null;
}

export const api = {
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
  async addExpense(e: Partial<ExpenseT>) {
    const pid = await getProfileId();
    return req(`/expenses`, { method: "POST", body: JSON.stringify({ ...e, profile_id: pid }) });
  },
  updateExpense: (id: string, e: Partial<ExpenseT>) =>
    req(`/expenses/${id}`, { method: "PUT", body: JSON.stringify(e) }),
  deleteExpense: (id: string) => req(`/expenses/${id}`, { method: "DELETE" }),

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
  async report(period: string, refDate: string) {
    const pid = await getProfileId();
    return req(`/reports?profile_id=${pid}&period=${period}&ref_date=${refDate}`);
  },
  async exportUrl(period: string, refDate: string) {
    const pid = await getProfileId();
    return `${BASE}/api/export?profile_id=${pid}&period=${period}&ref_date=${refDate}`;
  },
};

export const todayISO = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD local
