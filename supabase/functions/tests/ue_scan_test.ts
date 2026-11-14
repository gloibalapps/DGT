import { assert, assertEquals } from "@std/assert";
import { handle, type AppDeps } from "../_shared/app.ts";
import { MemoryDb } from "../_shared/db.ts";
import { inferJobDate, jobPeriod, parseGuaranteeJobs, rateFor, rateNote, summarise } from "../_shared/ue.ts";

function deps(extra: Partial<AppDeps> = {}): AppDeps {
  return { db: extra.db ?? new MemoryDb(), env: extra.env, fetch: extra.fetch, now: extra.now };
}

function call(d: AppDeps, path: string, init: RequestInit = {}): Promise<Response> {
  return handle(new Request(`http://local${path}`, init), d);
}

async function user(d: AppDeps): Promise<string> {
  await d.db.users.insertOne({
    user_id: "user_ada", email: "ada@example.com", is_demo: false,
    trial_started_at: "2026-11-01T00:00:00.000Z", trial_ends_at: "2026-12-01T00:00:00.000Z",
  });
  await d.db.user_sessions.insertOne({ session_token: "tok-user_ada", user_id: "user_ada", expires_at: "2099-01-01T00:00:00.000Z" });
  return "tok-user_ada";
}

const auth = (token: string, init: RequestInit = {}): RequestInit =>
  ({ ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

Deno.test("overlapping jobs count once, quests add earnings only, and tips are excluded", () => {
  const jobs = [
    { date: "2026-10-20", start_time: "10:00 AM", type: "DELIVERY", duration_sec: 3600, amount: 10, tip: 2, platform: "Uber Eats" },
    { date: "2026-10-20", start_time: "10:30 AM", type: "DELIVERY", duration_sec: 3600, amount: 12, platform: "Uber Eats" },
    { date: "2026-10-20", start_time: "", type: "Promotion", duration_sec: 0, amount: 5, platform: "Uber Eats" },
  ];
  const total = summarise(jobs, "car");
  assertEquals(total.engaged_sec, 5400);
  assertEquals(total.earnings, 25);
  assertEquals(total.promo_total, 5);
  assertEquals(total.guaranteed, 48);
  assertEquals(total.top_up, 23);
  assertEquals(total.jobs, 2);
  assertEquals(total.promotions, 1);
});

Deno.test("engaged time rounds to the nearest minute", () => {
  const jobs = [{ date: "2026-10-20", start_time: "9:00 AM", type: "DELIVERY", duration_sec: 90, amount: 4, platform: "Uber Eats" }];
  const total = summarise(jobs, "car");
  assertEquals(total.engaged_sec, 120);
  assertEquals(total.guaranteed, 1.07);
});

Deno.test("a job before 4:00 am Monday belongs to the previous period", () => {
  const early = { date: "2026-10-19", start_time: "3:30 AM", type: "DELIVERY" };
  const onTime = { date: "2026-10-19", start_time: "4:00 AM", type: "DELIVERY" };
  assertEquals(jobPeriod(early), "2026-09-28");
  assertEquals(jobPeriod(onTime), "2026-10-19");
});

Deno.test("rates follow the job date and 2027 stays marked reported", () => {
  assertEquals(rateFor("car", "2026-12-31"), 32);
  assertEquals(rateFor("motorbike", "2026-12-31"), 31.5);
  assertEquals(rateFor("bicycle", "2026-12-31"), 31.3);
  assertEquals(rateFor("ebike", "2027-01-01"), 31.8);
  assertEquals(rateFor("car", "2027-01-01"), 32.5);
  assertEquals(rateNote("2026-10-19"), null);
  assertEquals(rateNote("2027-01-01"), "reported, verify");
  const mixed = summarise([
    { date: "2026-12-31", start_time: "11:00 PM", type: "DELIVERY", duration_sec: 3600, amount: 20, platform: "Uber Eats" },
    { date: "2027-01-01", start_time: "1:00 AM", type: "DELIVERY", duration_sec: 3600, amount: 20, platform: "Uber Eats" },
  ], "car");
  // 11pm–midnight and 1am–2am do not overlap. 3600s at $32 plus 3600s at $32.50.
  assertEquals(mixed.engaged_sec, 7200);
  assertEquals(mixed.guaranteed, 64.5);
});

Deno.test("a fictional activity-list reply keeps complete rows and drops a cut-off one", () => {
  const text = JSON.stringify({
    top_up: 40,
    hours_online: 6,
    jobs: [
      { date: "Thu, Oct 22", start_time: "4:05 pm", type: "DELIVERY", duration_sec: 600, amount: 12, km: 3.5 },
      { date: "2026-10-22", start_time: "3:40 pm", type: "DELIVERY", duration: "15 min 0 sec", amount: 9.5, km: 4 },
      { date: "Oct 22", start_time: "7:13 pm", type: "5 Trip Quest", amount: 15 },
      { date: "2026-10-22", start_time: "2:00 pm", type: "DELIVERY", duration_sec: 0, amount: 8 },
    ],
  });
  const parsed = parseGuaranteeJobs(text, "2026-11-14");
  assertEquals(parsed.rejected, 1);
  assertEquals(parsed.jobs.length, 3);
  assertEquals(parsed.jobs.map((j) => j.type), ["DELIVERY", "DELIVERY", "Promotion"]);
  assertEquals(parsed.jobs[0].date, "2026-10-22");
  assertEquals(parsed.jobs[0].start_time, "4:05 PM");
  assertEquals(parsed.jobs[0].duration_sec, 600);
  assertEquals(parsed.jobs[0].amount, 12);
  assertEquals(parsed.jobs[1].duration_sec, 900);
  assertEquals(parsed.jobs[2].amount, 15);
  assertEquals(parsed.jobs[2].duration_sec, 0);
  assertEquals(parsed.jobs.every((j) => j.platform === "Uber Eats" && j.tip === 0), true);
  assertEquals("top_up" in parsed, false);
  assertEquals(inferJobDate("Thu, Oct 22", "2026-01-15"), "2025-10-22");
});

Deno.test("guarantee scan needs a key, rejects an oversized image, and does not save jobs", async () => {
  const noKey = deps();
  const token = await user(noKey);
  const missing = await call(noKey, "/api/ue/jobs/scan", auth(token, { method: "POST", body: JSON.stringify({ image_base64: "aa" }) }));
  assertEquals(missing.status, 503);

  let called = 0;
  const huge = deps({
    env: { ANTHROPIC_API_KEY: "sk" },
    fetch: () => { called++; return Promise.resolve(new Response("{}", { status: 200 })); },
  });
  await user(huge);
  const tooBig = "a".repeat(8_000_001);
  const scan = await call(huge, "/api/ue/jobs/scan", auth(token, { method: "POST", body: JSON.stringify({ image_base64: tooBig }) }));
  assertEquals(scan.status, 413);
  const receipt = await call(huge, "/api/receipts/scan", auth(token, { method: "POST", body: JSON.stringify({ image_base64: tooBig }) }));
  assertEquals(receipt.status, 413);
  assertEquals(called, 0);

  const vision = JSON.stringify({
    jobs: [{ date: "2026-10-22", start_time: "4:05 PM", type: "DELIVERY", duration_sec: 600, amount: 12, km: 3.5, tip: 0 }],
  });
  const ok = deps({
    env: { ANTHROPIC_API_KEY: "sk" },
    fetch: () => Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: vision }] }), { status: 200 })),
  });
  await user(ok);
  const read = await (await call(ok, "/api/ue/jobs/scan", auth(token, { method: "POST", body: JSON.stringify({ image_base64: "aa" }) }))).json();
  assertEquals(read.jobs.length, 1);
  assertEquals(read.jobs[0].amount, 12);
  assertEquals(await ok.db.ue_jobs.find({ profile_id: "user_ada" }).toList(10), []);
  assert(read.top_up === undefined);
});

Deno.test("verify and bulk delete only touch the caller's jobs", async () => {
  const d = deps();
  const token = await user(d);
  await d.db.ue_jobs.insertMany([
    { id: "a", profile_id: "user_ada", date: "2026-10-22", start_time: "4:05 PM", type: "DELIVERY", duration_sec: 600, amount: 12 },
    { id: "b", profile_id: "user_ada", date: "2026-10-22", start_time: "5:05 PM", type: "DELIVERY", duration_sec: 600, amount: 9 },
    { id: "c", profile_id: "someone-else", date: "2026-10-22", start_time: "4:05 PM", type: "DELIVERY", duration_sec: 600, amount: 12 },
  ]);
  const verified = await (await call(d, "/api/ue/jobs/verify", auth(token, { method: "POST", body: JSON.stringify({ ids: ["a", "c"], verified: true }) }))).json();
  assertEquals(verified.updated, 1);
  const row = await d.db.ue_jobs.findOne({ id: "a" });
  assertEquals(row?.verified, true);
  assert(typeof row?.verified_at === "string");
  assertEquals((await d.db.ue_jobs.findOne({ id: "c" }))?.verified, undefined);
  const deleted = await (await call(d, "/api/ue/jobs/bulk-delete", auth(token, { method: "POST", body: JSON.stringify({ ids: ["b", "c"] }) }))).json();
  assertEquals(deleted.deleted, 1);
  assertEquals(await d.db.ue_jobs.findOne({ id: "b" }), null);
  assertEquals((await d.db.ue_jobs.findOne({ id: "c" }))?.profile_id, "someone-else");
});
