import { assertEquals } from "@std/assert";
import * as tax from "../_shared/tax.ts";
import { summarise, rateFor } from "../_shared/ue.ts";
import { fernetDecrypt, fernetEncrypt } from "../_shared/fernet.ts";

const PY = "/tmp/dgt-venv/bin/python";
const ORACLE = "supabase/functions/tests/py_oracle.py";

async function python(args: string[]): Promise<string> {
  const cmd = new Deno.Command(PY, {
    args: [ORACLE, ...args],
    cwd: "/workspace",
    env: { PYTHONPATH: "/workspace/backend" },
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout);
}

function diffs(got: unknown, exp: unknown, path: string, out: string[]): void {
  if (typeof got === "number" && typeof exp === "number") {
    if (Math.abs(got - exp) > 1e-6) out.push(`${path}: ${got} != ${exp}`);
    return;
  }
  if (got === exp) return;
  if (Array.isArray(got) && Array.isArray(exp)) {
    if (got.length !== exp.length) out.push(`${path}.length: ${got.length} != ${exp.length}`);
    const n = Math.min(got.length, exp.length);
    for (let i = 0; i < n; i++) diffs(got[i], exp[i], `${path}[${i}]`, out);
    return;
  }
  if (got && exp && typeof got === "object" && typeof exp === "object") {
    const keys = new Set([...Object.keys(got as object), ...Object.keys(exp as object)]);
    for (const k of keys) diffs((got as Record<string, unknown>)[k], (exp as Record<string, unknown>)[k], `${path}.${k}`, out);
    return;
  }
  out.push(`${path}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`);
}

Deno.test("tax and uber calculations match the Python implementation", async () => {
  const fixture = JSON.parse(await Deno.readTextFile("/workspace/supabase/functions/tests/fixtures/calc.json"));
  tax.setTaxToday(tax.parseDate(fixture.today));
  const expected = JSON.parse(await python(["calc", "/workspace/supabase/functions/tests/fixtures/calc.json"]));
  const ref = tax.parseDate(fixture.today);
  const { profile, trips, incomes, expenses, shifts, vehicles } = fixture;
  const us = { ...profile, country: "US", region: "TX" };
  const start = tax.parseDate(fixture.analytics_start);
  const end = tax.addDays(tax.parseDate(fixture.analytics_end), 1);
  const got = {
    report: tax.computeReport(profile, trips, incomes, expenses, "quarter", ref, vehicles),
    report_us: tax.computeReport(us, trips, incomes, expenses, "year", ref, vehicles),
    dashboard: tax.dashboard(profile, trips, incomes, expenses, ref, vehicles),
    performance: tax.performance(profile, trips, incomes, expenses, ref, shifts),
    insights: tax.insights(profile, incomes, expenses, shifts, ref),
    money: tax.moneyOverview(profile, trips, incomes, expenses, shifts, ref, "week", vehicles),
    tax_mileage: tax.taxMileage(profile, trips, incomes, expenses, ref, vehicles),
    analytics: tax.computeAnalytics(profile, trips, incomes, expenses, shifts, vehicles, start, end, ["Uber Eats"], "v1"),
    summarise: summarise(fixture.ue_jobs, rateFor("car")),
  };
  const found: string[] = [];
  diffs(got, expected, "$", found);
  assertEquals(found, [], found.slice(0, 30).join("\n"));
  tax.setTaxToday(null);
});

Deno.test("Fernet decrypts existing Python tokens and Python decrypts ours", async () => {
  const made = JSON.parse(await python(["make"]));
  assertEquals(await fernetDecrypt(made.key, made.token), made.plain);
  const ours = await fernetEncrypt(made.key, "new-drive-refresh");
  const opened = (await python(["open", made.key, ours])).trim();
  assertEquals(opened, "new-drive-refresh");
});
