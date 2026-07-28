export function displayDate(iso: string, opts?: Intl.DateTimeFormatOptions): string {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString("en-AU", opts || { day: "numeric", month: "short", year: "numeric" });
}

export function displayDateShort(iso: string): string {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00`).getTime());
}
