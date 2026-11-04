// Automatic drive detection (background). OFF by default.
// Uses expo-location background updates + a TaskManager task that stitches GPS
// points into drives, auto-closing a drive after a stationary gap. Completed
// drives land in a pending queue the user classifies (Business/Personal) later.
//
// NOTE: background location only runs in a NATIVE build — never Expo Go / web.

import { Platform } from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { storage } from "@/src/utils/storage";

export const AUTOTRACK_TASK = "gigtax-autotrack";
const ENABLED_KEY = "gigtax.autotrack.enabled"; // boolean (scalar)
const BUF_KEY = "gigtax.autotrack.buffer"; // JSON string
const PENDING_KEY = "gigtax.autotrack.pending"; // JSON string (array)
const STOP_GAP_MS = 5 * 60 * 1000; // 5 min stationary => drive ended
const MIN_DRIVE_KM = 0.3; // ignore trivial GPS jitter drives
const GPS_ACC_MAX_M = 30;     // manual: ignore fixes less accurate than this (metres)
const AUTO_ACC_MAX_M = 60;    // auto: slightly looser (sparser background fixes)
const GPS_MAX_KMH = 180;      // ignore segments implying an impossible speed (GPS glitch)
const MIN_GAP_MS = 1000;      // accept at most one fix per second (two sources → one)
const STILL_MS = 1.0;         // GPS speed below ~3.6 km/h = not moving
const MAX_AVG_KMH = 130;      // a whole drive can't average more than this

// Decide how much real distance one GPS step represents. The phone's Doppler
// SPEED (coords.speed, m/s) is far more reliable than position, which jitters
// by tens of metres — so speed is used to (a) recognise standing still and
// (b) cap each step to what the car could actually have covered. Returns null
// to reject the fix outright (keep the reference), km 0 + move=false to hold
// the reference (stationary / jitter), or the km to add and move the reference.
interface Ref { lat: number; lon: number; ts: number; speed?: number | null }
function stepKm(ref: Ref, lat: number, lon: number, ts: number, accuracy?: number | null, speed?: number | null):
  { km: number; move: boolean } | null {
  const dtS = (ts - ref.ts) / 1000;
  if (dtS < MIN_GAP_MS / 1000) return null;              // duplicate / stale / out-of-order
  const d = haversine(ref.lat, ref.lon, lat, lon);
  if (d / (dtS / 3600) > GPS_MAX_KMH) return null;       // teleport glitch
  const spd = speed != null && speed >= 0 ? speed : null;
  if (spd != null) {
    const refSpd = ref.speed != null && ref.speed >= 0 ? ref.speed : spd;
    if (spd < STILL_MS && refSpd < STILL_MS) return { km: 0, move: false }; // parked / at lights
    if (d < moveFloorKm(accuracy)) return { km: 0, move: false };
    // Distance can't exceed what the speedometer says was covered — this stops
    // sideways position jitter inflating the total while driving.
    const capKm = (((spd + refSpd) / 2) * dtS * 1.05) / 1000;
    return { km: Math.min(d, capKm), move: true };
  }
  // No speed from the device: be stricter — movement must beat the fix's own error.
  const accM = accuracy != null && accuracy > 0 ? accuracy : 20;
  if (d * 1000 < Math.max(60, accM * 3)) return { km: 0, move: false };
  return { km: d, move: true };
}

// Movement must beat the fix's own uncertainty before it counts, otherwise
// standing still at lights / in a car park slowly "walks" the distance up.
function moveFloorKm(accuracy?: number | null): number {
  const acc = accuracy != null && accuracy > 0 ? accuracy : 10;
  return Math.max(8, Math.min(25, acc * 0.6)) / 1000;
}

export interface PendingDrive {
  id: string;
  distance_km: number;
  date: string; // YYYY-MM-DD (local, from drive start)
  start_ts: number;
  end_ts: number;
}

interface Buffer {
  lastLat: number; lastLon: number; lastTs: number; distance: number; startTs: number;
  lastSpeed?: number | null; seenTs?: number;
}

function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  const raw = await storage.getItem<string>(key, "");
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
async function writeJSON(key: string, value: unknown): Promise<void> {
  await storage.setItem(key, JSON.stringify(value));
}

function finalize(buf: Buffer): PendingDrive {
  return {
    id: `${buf.startTs}`,
    distance_km: Math.round(buf.distance * 100) / 100,
    date: new Date(buf.startTs).toLocaleDateString("en-CA"),
    start_ts: buf.startTs,
    end_ts: buf.seenTs || buf.lastTs,
  };
}

// Register the background handler (native only; harmless to skip on web).
if (Platform.OS !== "web") {
  TaskManager.defineTask(AUTOTRACK_TASK, async ({ data, error }: any) => {
    if (error) return;
    const locs: Location.LocationObject[] = data?.locations || [];
    if (!locs.length) return;
    autoChain = autoChain.then(() => autoIngest(locs)).catch(() => {});
    return autoChain;
  });
}

let autoChain: Promise<void> = Promise.resolve();
async function autoIngest(locsIn: Location.LocationObject[]): Promise<void> {
  if ((await readJSON<Live | null>(LIVE_KEY, null))?.active) return; // manual shift owns this drive
  let buf = await readJSON<Buffer | null>(BUF_KEY, null);
  const pending = await readJSON<PendingDrive[]>(PENDING_KEY, []);
  const locs = [...locsIn].sort((a, b) => a.timestamp - b.timestamp);
  for (const loc of locs) {
    const { latitude, longitude, accuracy, speed } = loc.coords;
    const ts = loc.timestamp;
    if (accuracy != null && accuracy > AUTO_ACC_MAX_M) continue; // skip junk fix
    const lastMove = buf ? buf.lastTs : 0;
    if (buf && ts - lastMove > STOP_GAP_MS) {
      if (buf.distance >= MIN_DRIVE_KM) pending.push(finalize(buf));
      buf = null;
    }
    if (!buf) {
      buf = { lastLat: latitude, lastLon: longitude, lastTs: ts, distance: 0, startTs: ts, lastSpeed: speed, seenTs: ts };
      continue;
    }
    const step = stepKm({ lat: buf.lastLat, lon: buf.lastLon, ts: buf.lastTs, speed: buf.lastSpeed }, latitude, longitude, ts, accuracy, speed);
    if (!step || !step.move) continue; // stationary → stop-gap closes the drive
    buf.distance += step.km;
    buf.lastLat = latitude; buf.lastLon = longitude; buf.lastTs = ts; buf.lastSpeed = speed; buf.seenTs = ts;
  }
  await writeJSON(BUF_KEY, buf);
  // de-dupe by id so a drive can never be queued twice
  const seen = new Set<string>();
  await writeJSON(PENDING_KEY, pending.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))));
}

async function isRunning(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try { return await Location.hasStartedLocationUpdatesAsync(AUTOTRACK_TASK); }
  catch { return false; }
}

export async function isAutotrackEnabled(): Promise<boolean> {
  return (await storage.getItem<boolean>(ENABLED_KEY, false)) === true;
}

export interface EnableResult { ok: boolean; reason?: "unsupported" | "permission" | "disclosure"; canAskAgain?: boolean; backgroundOff?: boolean; }

// Prominent-disclosure state (Play User Data policy). true = accepted,
// false = declined ("No thanks"), null = never shown. We never call
// requestBackgroundPermissionsAsync unless this is true.
const DISCLOSURE_KEY = "gigtax.bglocation.disclosure"; // "accepted" | "declined"
export async function getBackgroundDisclosure(): Promise<boolean | null> {
  const v = await storage.getItem<string>(DISCLOSURE_KEY, "");
  return v === "accepted" ? true : v === "declined" ? false : null;
}
export async function setBackgroundDisclosure(accepted: boolean): Promise<void> {
  await storage.setItem(DISCLOSURE_KEY, accepted ? "accepted" : "declined");
}

// True when the background permission is missing and we'd have to prompt for
// it, i.e. the UI must show the disclosure first (unless already accepted).
async function needsDisclosure(): Promise<boolean> {
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.granted) return false;
  return (await getBackgroundDisclosure()) !== true;
}

// Auto-detect needs background location. If the user hasn't accepted the
// disclosure yet this returns reason "disclosure" WITHOUT any system prompt;
// the caller shows the disclosure (useLocationDisclosure) and retries.
export async function enableAutotrack(): Promise<EnableResult> {
  if (Platform.OS === "web") return { ok: false, reason: "unsupported" };
  if (await needsDisclosure()) return { ok: false, reason: "disclosure" };
  let fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted && fg.canAskAgain) fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, reason: "permission", canAskAgain: fg.canAskAgain };

  let bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted && bg.canAskAgain) bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) return { ok: false, reason: "permission", canAskAgain: bg.canAskAgain };

  if (!(await isRunning())) {
    await Location.startLocationUpdatesAsync(AUTOTRACK_TASK, {
      // High (GPS) accuracy — Balanced uses cell/Wi-Fi fixes (~100 m) which
      // were being rejected as junk, so auto drives came out short or missing.
      accuracy: Location.Accuracy.High,
      distanceInterval: 25,
      deferredUpdatesInterval: 15000,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: false,
      foregroundService: {
        notificationTitle: "GigTax is detecting your drive",
        notificationBody: "Trips are logged automatically — classify them later.",
        notificationColor: "#38BDF8",
      },
    });
  }
  await storage.setItem(ENABLED_KEY, true);
  return { ok: true };
}

export async function disableAutotrack(): Promise<void> {
  await storage.setItem(ENABLED_KEY, false);
  if (await isRunning()) {
    try { await Location.stopLocationUpdatesAsync(AUTOTRACK_TASK); } catch { /* noop */ }
  }
}

// Ensure the background task matches the stored preference (call on app start).
export async function syncAutotrack(): Promise<void> {
  if (Platform.OS === "web") return;
  const enabled = await isAutotrackEnabled();
  const running = await isRunning();
  if ((await readJSON<Live | null>(LIVE_KEY, null))?.active) { if (running) await pauseAutotrackForManual(); return; }
  if (enabled && !running) { try { await enableAutotrack(); } catch { /* noop */ } }
  if (!enabled && running) { await disableAutotrack(); }
}

// Suspend background auto-tracking while a manual GPS shift is running, so the
// same physical drive isn't captured twice (once by auto, once by the manual
// tracker). This does NOT change the user's enabled preference — it just stops
// the background updates and drops any half-captured drive so it can't become a
// duplicate pending trip. syncAutotrack() on the next app open will restore it.
export async function pauseAutotrackForManual(): Promise<void> {
  if (Platform.OS === "web") return;
  if (await isRunning()) {
    try { await Location.stopLocationUpdatesAsync(AUTOTRACK_TASK); } catch { /* noop */ }
  }
  await writeJSON(BUF_KEY, null);
}

// Resume background auto-tracking after a manual GPS shift ends, but only if the
// driver still has auto-detection turned on. Starts fresh (no carried-over buffer).
export async function resumeAutotrackIfEnabled(): Promise<void> {
  if (Platform.OS === "web") return;
  await writeJSON(BUF_KEY, null);
  if ((await isAutotrackEnabled()) && !(await isRunning())) {
    try { await enableAutotrack(); } catch { /* noop */ }
  }
}

// If a drive is sitting open past the stop-gap, close it into the queue.
export async function flushOpenDrive(): Promise<void> {
  const buf = await readJSON<Buffer | null>(BUF_KEY, null);
  if (!buf) return;
  if (Date.now() - buf.lastTs > STOP_GAP_MS) {
    if (buf.distance >= MIN_DRIVE_KM) {
      const pending = await readJSON<PendingDrive[]>(PENDING_KEY, []);
      pending.push(finalize(buf));
      await writeJSON(PENDING_KEY, pending);
    }
    await writeJSON(BUF_KEY, null);
  }
}

export async function getPendingDrives(): Promise<PendingDrive[]> {
  await flushOpenDrive();
  return readJSON<PendingDrive[]>(PENDING_KEY, []);
}

export async function clearPendingDrive(id: string): Promise<void> {
  const pending = await readJSON<PendingDrive[]>(PENDING_KEY, []);
  await writeJSON(PENDING_KEY, pending.filter((p) => p.id !== id));
}

// ---------------------------------------------------------------------------
// MANUAL DRIVE (foreground-service background task).
// Keeps the live "GPS shift" alive when the app is backgrounded / screen off,
// and auto-saves the running distance to storage every update so the drive is
// recovered even if the OS kills the app. Native only.
// ---------------------------------------------------------------------------
export const MANUAL_TASK = "gigtax-manual-drive";
const LIVE_KEY = "gigtax.manual.live"; // JSON string

interface Live { distance: number; lastLat?: number; lastLon?: number; lastTs: number; lastSpeed?: number | null; startTs: number; active: boolean; }


// Read-modify-write a single GPS fix into the live drive. Shared by BOTH the
// background foreground-service task AND the in-app foreground watcher, so the
// running distance is persisted to storage on EVERY update from either source
// and can never be lost if the OS kills the app.
//
// Stability guards (fixes the ±20–100 km back-and-forth jumping):
//  • drop fixes whose reported accuracy is worse than GPS_ACC_MAX_M — a bad fix
//    must NEVER become the reference point, or the "return" step spikes too;
//  • drop segments implying an impossible speed (GPS teleport);
//  • de-dupe by timestamp so the same fix arriving from both sources (or a
//    stale racing write) is only ever counted once.
// Serialise every write: the foreground watcher and the background task can
// fire at the same moment, and two overlapping read-modify-writes would lose
// or double-count distance.
let ingestChain: Promise<void> = Promise.resolve();
export function ingestManualPoint(latitude: number, longitude: number, ts: number, accuracy?: number | null, speed?: number | null): Promise<void> {
  ingestChain = ingestChain.then(() => ingestOne(latitude, longitude, ts, accuracy, speed)).catch(() => {});
  return ingestChain;
}

async function ingestOne(latitude: number, longitude: number, ts: number, accuracy?: number | null, speed?: number | null): Promise<void> {
  const live = await readJSON<Live | null>(LIVE_KEY, null);
  if (!live || !live.active) return;
  if (accuracy != null && accuracy > GPS_ACC_MAX_M) return; // junk fix — ignore entirely
  if (live.lastLat == null || live.lastLon == null) {
    live.lastLat = latitude; live.lastLon = longitude; live.lastTs = ts; live.lastSpeed = speed;
    await writeJSON(LIVE_KEY, live);
    return;
  }
  const step = stepKm({ lat: live.lastLat, lon: live.lastLon, ts: live.lastTs, speed: live.lastSpeed }, latitude, longitude, ts, accuracy, speed);
  if (!step || !step.move) return; // glitch or standing still — hold the reference
  live.distance += step.km;
  live.lastLat = latitude; live.lastLon = longitude; live.lastTs = ts; live.lastSpeed = speed;
  await writeJSON(LIVE_KEY, live);
}

if (Platform.OS !== "web") {
  TaskManager.defineTask(MANUAL_TASK, async ({ data, error }: any) => {
    if (error) return;
    try {
      const locs: Location.LocationObject[] = data?.locations || [];
      const sorted = [...locs].sort((a, b) => a.timestamp - b.timestamp);
      for (const loc of sorted) {
        await ingestManualPoint(loc.coords.latitude, loc.coords.longitude, loc.timestamp, loc.coords.accuracy, loc.coords.speed);
      }
    } catch { /* never let a bad fix crash the background service */ }
  });
}

export async function isManualRunning(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try { return await Location.hasStartedLocationUpdatesAsync(MANUAL_TASK); }
  catch { return false; }
}

// Manual drive. With background permission it runs as a foreground-service
// task (survives screen-off). If the user declined the disclosure, or denies
// "Allow all the time", it still starts in FOREGROUND-ONLY mode: the caller's
// in-app watcher (trips.tsx startForegroundWatch) records the drive while the
// app is open, and result.backgroundOff = true. Returns reason "disclosure"
// (no prompt shown) when the disclosure hasn't been answered yet.
export async function startManualDrive(): Promise<EnableResult> {
  if (Platform.OS === "web") return { ok: false, reason: "unsupported" };
  const disclosure = await getBackgroundDisclosure();
  let bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted && disclosure === null) return { ok: false, reason: "disclosure" };
  let fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted && fg.canAskAgain) fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, reason: "permission", canAskAgain: fg.canAskAgain };
  if (!bg.granted && disclosure === true && bg.canAskAgain) bg = await Location.requestBackgroundPermissionsAsync();
  const background = bg.granted;

  await pauseAutotrackForManual(); // don't double-count the same drive
  await writeJSON(LIVE_KEY, { distance: 0, lastTs: 0, startTs: Date.now(), active: true } as Live);
  if (!background) return { ok: true, backgroundOff: true };
  if (!(await isManualRunning())) {
    await Location.startLocationUpdatesAsync(MANUAL_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      distanceInterval: 5,
      timeInterval: 2000,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "GigTax is tracking your drive",
        notificationBody: "Your distance is being recorded — tap to return to the app.",
        notificationColor: "#38BDF8",
      },
    });
  }
  return { ok: true };
}

export async function getManualLive(): Promise<{ distanceKm: number; startTs: number; active: boolean } | null> {
  const live = await readJSON<Live | null>(LIVE_KEY, null);
  if (!live) return null;
  return { distanceKm: Math.round(live.distance * 100) / 100, startTs: live.startTs, active: !!live.active };
}

export async function stopManualDrive(): Promise<{ distanceKm: number; startTs: number; endTs: number }> {
  const live = await readJSON<Live | null>(LIVE_KEY, null);
  if (await isManualRunning()) {
    try { await Location.stopLocationUpdatesAsync(MANUAL_TASK); } catch { /* noop */ }
  }
  await writeJSON(LIVE_KEY, null);
  await resumeAutotrackIfEnabled();
  const endTs = Date.now(); // finish = when the driver tapped End drive
  const startTs = live ? live.startTs : endTs;
  // Final sanity net: a drive can't average more than MAX_AVG_KMH.
  const maxKm = ((endTs - startTs) / 3600000) * MAX_AVG_KMH;
  const km = live ? Math.min(live.distance, maxKm) : 0;
  return { distanceKm: Math.round(km * 100) / 100, startTs, endTs };
}
