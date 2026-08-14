// Dates are stored internally as ISO (YYYY-MM-DD) for the backend, but shown
// and entered in Australian format (DD/MM/YYYY).

export function displayDate(iso: string): string {
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

export function displayDateShort(iso: string): string {
  const s = String(iso).slice(0, 10);
  const [, m, d] = s.split("-");
  return m && d ? `${d}/${m}` : iso;
}

// Internal ISO validity (used where values are already ISO).
export function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00`).getTime());
}

// ---- Australian input helpers (DD/MM/YYYY) ----
export function isoToAU(iso?: string | null): string {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : "";
}

export function auToISO(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || "").trim());
  if (!m) return null;
  const [, dd, mm, yy] = m;
  const day = +dd, mon = +mm;
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  const iso = `${yy}-${mm}-${dd}`;
  return isNaN(new Date(`${iso}T00:00:00`).getTime()) ? null : iso;
}

// Auto-insert slashes as the user types: "01072026" -> "01/07/2026".
export function maskAUDate(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "").slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join("/");
}

export function todayAU(): string {
  return isoToAU(new Date().toLocaleDateString("en-CA"));
}
