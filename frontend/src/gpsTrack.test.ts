import assert from "node:assert/strict";
import test from "node:test";
import { applyFix, FIX_WAIT_MS, foldFixes, haversineKm, shouldRestartLocationUpdates, type GpsFix } from "./gpsTrack.ts";

/** Previous stepKm rules, kept here to show why a parked phone grew a trip. */
function legacyStepKm(
  ref: { lat: number; lon: number; ts: number; speed?: number | null },
  lat: number, lon: number, ts: number, accuracy?: number | null, speed?: number | null,
): number {
  const dtS = (ts - ref.ts) / 1000;
  if (dtS < 1) return 0;
  const d = haversineKm(ref.lat, ref.lon, lat, lon);
  if (d / (dtS / 3600) > 180) return 0;
  const spd = speed != null && speed >= 0 ? speed : null;
  if (spd != null) {
    const refSpd = ref.speed != null && ref.speed >= 0 ? ref.speed : spd;
    if (spd < 1 && refSpd < 1) return 0;
    const acc = accuracy != null && accuracy > 0 ? accuracy : 10;
    const floor = Math.max(8, Math.min(25, acc * 0.6)) / 1000;
    if (d < floor) return 0;
    const capKm = (((spd + refSpd) / 2) * dtS * 1.05) / 1000;
    return Math.min(d, capKm);
  }
  const accM = accuracy != null && accuracy > 0 ? accuracy : 20;
  if (accuracy != null && accuracy > 60) return 0;
  if (d * 1000 < Math.max(60, accM * 3)) return 0;
  return d;
}

function legacyDistance(fixes: GpsFix[]): number {
  let ref: GpsFix | null = null;
  let km = 0;
  for (const fix of fixes) {
    if (fix.accuracy != null && fix.accuracy > 60) continue;
    if (!ref) { ref = fix; continue; }
    const add = legacyStepKm(
      { lat: ref.lat, lon: ref.lon, ts: ref.ts, speed: ref.speed },
      fix.lat, fix.lon, fix.ts, fix.accuracy, fix.speed,
    );
    if (add > 0) {
      km += add;
      ref = fix;
    }
  }
  return km;
}

const LAT = -33.8688;
const LON = 151.2093;

function offset(lat: number, lon: number, northM: number, eastM: number): { lat: number; lon: number } {
  return {
    lat: lat + northM / 111320,
    lon: lon + eastM / (111320 * Math.cos((lat * Math.PI) / 180)),
  };
}

/** Parked phone: the fix walks a ~80 m circle. Accuracy 20–65 m, speed -1 or 0. */
function stationaryFixes(): GpsFix[] {
  const fixes: GpsFix[] = [{ lat: LAT, lon: LON, ts: 1_700_000_000_000, accuracy: 20, speed: 0 }];
  let ts = fixes[0].ts;
  for (let i = 0; i < 36; i++) {
    ts += 15_000;
    const rad = (i % 6) * (Math.PI / 3);
    const acc = [20, 32, 45, 65, 22, 58][i % 6];
    const speed = i % 2 === 0 ? -1 : 0;
    const p = offset(LAT, LON, Math.cos(rad) * 80, Math.sin(rad) * 80);
    fixes.push({ ...p, ts, accuracy: acc, speed });
  }
  return fixes;
}

test("a stationary phone does not start a trip or collect kilometres", () => {
  const fixes = stationaryFixes();
  const legacy = legacyDistance(fixes);
  const next = foldFixes(fixes);
  assert.ok(legacy >= 0.3, `old rules should have built a drive from jitter, got ${legacy.toFixed(3)} km`);
  assert.equal(next.armed, false);
  assert.equal(next.distanceKm, 0);
  assert.equal(next.closed.length, 0);
});

test("speed noise just above the old 1 m/s still threshold does not arm a drive", () => {
  const fixes: GpsFix[] = [];
  let ts = 1_700_000_000_000;
  for (let i = 0; i < 30; i++) {
    const p = offset(LAT, LON, (i % 2 === 0 ? 30 : -10), (i % 3) * 8);
    fixes.push({ ...p, ts, accuracy: 25, speed: 1.2 });
    ts += 10_000;
  }
  const next = foldFixes(fixes);
  assert.equal(next.armed, false);
  assert.equal(next.distanceKm, 0);
  assert.ok(legacyDistance(fixes) > 0.2);
});

test("a single jump away from the anchor is ignored", () => {
  const start = { lat: LAT, lon: LON, ts: 1_700_000_000_000, accuracy: 20, speed: 0 };
  const jumped = offset(LAT, LON, 0, 5000);
  const folded = foldFixes([
    start,
    { ...jumped, ts: start.ts + 2000, accuracy: 40, speed: -1 },
    { lat: LAT, lon: LON, ts: start.ts + 20_000, accuracy: 20, speed: 0 },
  ]);
  assert.equal(folded.armed, false);
  assert.equal(folded.distanceKm, 0);
  assert.equal(applyFix(null, { ...jumped, ts: start.ts, accuracy: 80, speed: 0 }).ignored, "accuracy");
});

test("real movement arms the drive and then counts kilometres", () => {
  const fixes: GpsFix[] = [];
  let ts = 1_700_000_000_000;
  fixes.push({ lat: LAT, lon: LON, ts, accuracy: 15, speed: -1 });
  for (let i = 1; i <= 8; i++) {
    const p = offset(LAT, LON, i * 200, 0);
    fixes.push({ ...p, ts: ts + i * 15_000, accuracy: 12, speed: -1 });
  }
  const folded = foldFixes(fixes);
  assert.equal(folded.armed, true);
  assert.ok(folded.distanceKm > 0.5, `expected a real drive, got ${folded.distanceKm}`);
});

test("three consecutive fast fixes arm a drive even before 150 m", () => {
  let state = applyFix(null, { lat: LAT, lon: LON, ts: 0, accuracy: 10, speed: 0 }).state;
  for (let i = 1; i <= 3; i++) {
    const p = offset(LAT, LON, i * 20, 0);
    const step = applyFix(state, { ...p, ts: i * 3000, accuracy: 10, speed: 8 });
    state = step.state;
    if (i < 3) assert.equal(step.armedNow, false);
    else assert.equal(step.armedNow, true);
  }
  assert.ok(state);
  assert.equal(state!.armed, true);
  assert.ok(state!.distance > 0);
});

test("a noisy 500 m drive is not doubled when both streams and duplicate batches are fed in", () => {
  const fixes: GpsFix[] = [];
  const ts0 = 1_700_000_000_000;
  const mps = 500 / 36;
  for (let i = 0; i <= 36; i++) {
    const along = i * mps;
    const acc = 5 + (i % 4) * 5;
    const lateral = Math.sin(i * 1.7) * acc * 0.6;
    fixes.push({ ...offset(LAT, LON, along, lateral), ts: ts0 + i * 1000, accuracy: acc, speed: mps });
  }
  const shifted = fixes.map((f) => ({ ...f, ts: f.ts + 400 }));
  const folded = foldFixes([...fixes, ...fixes, ...shifted].sort((a, b) => a.ts - b.ts));
  assert.equal(folded.armed, true);
  assert.ok(Math.abs(folded.distanceKm - 0.5) <= 0.025, `expected ~0.5 km, got ${folded.distanceKm}`);
});

test("a started task with no fix is restarted once, then left alone until the next wait", () => {
  const t0 = 1_000_000;
  const base = { started: true, lastFixAt: null, updatesStartedAt: t0, restartedAt: null };
  assert.equal(shouldRestartLocationUpdates({ ...base, now: t0 + 10_000 }), false);
  assert.equal(shouldRestartLocationUpdates({ ...base, now: t0 + FIX_WAIT_MS }), true);
  assert.equal(shouldRestartLocationUpdates({ ...base, now: t0 + FIX_WAIT_MS, restartedAt: t0 + FIX_WAIT_MS }), false);
  assert.equal(shouldRestartLocationUpdates({
    ...base, now: t0 + FIX_WAIT_MS * 2, restartedAt: t0 + FIX_WAIT_MS, lastFixAt: null,
  }), true);
  assert.equal(shouldRestartLocationUpdates({
    started: true, now: t0 + 60_000, updatesStartedAt: t0, restartedAt: null, lastFixAt: t0 + 50_000,
  }), false);
  assert.equal(shouldRestartLocationUpdates({ ...base, started: false, now: t0 }), true);
});

test("after the drive is armed, a stop does not add more distance", () => {
  const fixes: GpsFix[] = [{ lat: LAT, lon: LON, ts: 0, accuracy: 10, speed: 0 }];
  for (let i = 1; i <= 6; i++) {
    fixes.push({ ...offset(LAT, LON, i * 40, 0), ts: i * 4000, accuracy: 10, speed: 8 });
  }
  const moving = foldFixes(fixes);
  assert.equal(moving.armed, true);
  const parkedAt = fixes[fixes.length - 1];
  const extra: GpsFix[] = [];
  for (let i = 1; i <= 10; i++) {
    extra.push({
      ...offset(parkedAt.lat, parkedAt.lon, (i % 2 === 0 ? 25 : -15), 10),
      ts: parkedAt.ts + i * 5000,
      accuracy: i % 3 === 0 ? 65 : 30,
      speed: i % 2 === 0 ? 0 : -1,
    });
  }
  const after = foldFixes([...fixes, ...extra]);
  assert.ok(Math.abs(after.distanceKm - moving.distanceKm) < 0.05);
});
