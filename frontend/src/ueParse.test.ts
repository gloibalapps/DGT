import assert from "node:assert/strict";
import test from "node:test";
import type { UEJob } from "./ueParse.ts";
import {
  cycleStartFor, emptyFilter, engagedSeconds, filterJobs, inWeek, jobPeriod, listTotals,
  matchJob, scanPayloadTooLarge, selectedBuckets, MAX_SCAN_CHARS,
} from "./ueParse.ts";

const job = (over: Partial<UEJob> = {}): UEJob => ({
  platform: "Uber Eats", date: "2026-10-20", start_time: "10:00 AM", type: "DELIVERY",
  duration_sec: 3600, amount: 10, km: 3, tip: 0, ...over,
});

test("overlapping engaged time is counted once and a tip is left out of earnings", () => {
  const jobs = [
    job({ tip: 2 }),
    job({ start_time: "10:30 AM", amount: 12 }),
    job({ type: "Promotion", start_time: "", duration_sec: 0, amount: 5 }),
  ];
  assert.equal(engagedSeconds(jobs), 5400);
  const totals = listTotals(jobs);
  assert.equal(totals.earnings, 25);
  assert.equal(totals.engagedSec, 5400);
  assert.equal(totals.jobs, 2);
  assert.equal(totals.promotions, 1);
});

test("a job before 4:00 am Monday belongs to the previous period and week", () => {
  const early = job({ date: "2026-10-26", start_time: "3:30 AM" });
  const onTime = job({ date: "2026-10-26", start_time: "4:00 AM" });
  assert.equal(jobPeriod(early), "2026-10-19");
  assert.equal(jobPeriod(onTime), "2026-10-19");
  assert.equal(inWeek(early, "2026-10-19"), true);
  assert.equal(inWeek(onTime, "2026-10-19"), false);
  assert.equal(inWeek(onTime, "2026-10-26"), true);
  assert.equal(cycleStartFor("2026-10-19"), "2026-10-19");
  assert.equal(jobPeriod(job({ date: "2026-10-19", start_time: "3:30 AM" })), "2026-09-28");
});

test("filters keep a fictional week, platform, quest, verified flag, and amount", () => {
  const rows = [
    job({ id: "a", amount: 12.5 }),
    job({ id: "b", date: "2026-11-02", start_time: "9:00 AM", platform: "DoorDash", amount: 8 }),
    job({ id: "c", type: "Promotion", start_time: "", duration_sec: 0, amount: 15, verified: true }),
  ];
  const week = { ...emptyFilter(), periodStart: "2026-10-19", weekIndex: "0" as const };
  assert.deepEqual(filterJobs(rows, week).map((j) => j.id), ["a", "c"]);
  assert.deepEqual(filterJobs(rows, { ...emptyFilter(), platform: "DoorDash" }).map((j) => j.id), ["b"]);
  assert.deepEqual(filterJobs(rows, { ...emptyFilter(), type: "Promotion" }).map((j) => j.id), ["c"]);
  assert.deepEqual(filterJobs(rows, { ...emptyFilter(), verified: "verified" }).map((j) => j.id), ["c"]);
  assert.deepEqual(filterJobs(rows, { ...emptyFilter(), verified: "unverified" }).map((j) => j.id), ["a", "b"]);
  assert.equal(matchJob(rows[0], { ...emptyFilter(), query: "12.50" }), true);
  assert.equal(matchJob(rows[2], { ...emptyFilter(), query: "quest" }), true);
  assert.equal(matchJob(rows[0], { ...emptyFilter(), from: "2026-10-21" }), false);
});

test("select-all buckets split unsaved drafts from saved jobs", () => {
  const rows = [
    { key: "d1", selected: true },
    { key: "s1", id: "job-1", selected: true },
    { key: "s2", id: "job-2", selected: false },
  ];
  assert.deepEqual(selectedBuckets(rows), { draftKeys: ["d1"], savedIds: ["job-1"], count: 2 });
  assert.equal(scanPayloadTooLarge("a".repeat(MAX_SCAN_CHARS)), false);
  assert.equal(scanPayloadTooLarge("a".repeat(MAX_SCAN_CHARS + 1)), true);
});
