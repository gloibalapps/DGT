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

export interface PendingDrive {
  id: string;
  distance_km: number;
  date: string; // YYYY-MM-DD (local, from drive start)
  start_ts: number;
  end_ts: number;
}

interface Buffer {
  lastLat: number; lastLon: number; lastTs: number; distance: number; startTs: number;
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
    end_ts: buf.lastTs,
  };
}

// Register the background handler (native only; harmless to skip on web).
if (Platform.OS !== "web") {
  TaskManager.defineTask(AUTOTRACK_TASK, async ({ data, error }: any) => {
    if (error) return;
    const locs: Location.LocationObject[] = data?.locations || [];
    if (!locs.length) return;
    let buf = await readJSON<Buffer | null>(BUF_KEY, null);
    const pending = await readJSON<PendingDrive[]>(PENDING_KEY, []);
    for (const loc of locs) {
      const { latitude, longitude, accuracy } = loc.coords;
      const ts = loc.timestamp;
      if (accuracy != null && accuracy > GPS_ACC_MAX_M) continue; // skip junk fix
      if (buf && ts - buf.lastTs > STOP_GAP_MS) {
        if (buf.distance >= MIN_DRIVE_KM) pending.push(finalize(buf));
        buf = null;
      }
      if (!buf) {
        buf = { lastLat: latitude, lastLon: longitude, lastTs: ts, distance: 0, startTs: ts };
      } else {
        const d = haversine(buf.lastLat, buf.lastLon, latitude, longitude);
        const dtH = Math.max(0, ts - buf.lastTs) / 3600000;
        const kmh = dtH > 0 ? d / dtH : Infinity;
        if (kmh > GPS_MAX_KMH) continue; // teleport glitch — don't move the reference point
        if (d > 0.005) buf.distance += d;
        buf.lastLat = latitude; buf.lastLon = longitude; buf.lastTs = ts;
      }
    }
    await writeJSON(BUF_KEY, buf);
    await writeJSON(PENDING_KEY, pending);
  });
}

async function isRunning(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try { return await Location.hasStartedLocationUpdatesAsync(AUTOTRACK_TASK); }
  catch { return false; }
}

export async function isAutotrackEnabled(): Promise<boolean> {
  return (await storage.getItem<boolean>(ENABLED_KEY, false)) === true;
}

export interface EnableResult { ok: boolean; reason?: "unsupported" | "permission"; canAskAgain?: boolean; }

export async function enableAutotrack(): Promise<EnableResult> {
  if (Platform.OS === "web") return { ok: false, reason: "unsupported" };
  let fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted && fg.canAskAgain) fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, reason: "permission", canAskAgain: fg.canAskAgain };

  let bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted && bg.canAskAgain) bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) return { ok: false, reason: "permission", canAskAgain: bg.canAskAgain };

  if (!(await isRunning())) {
    await Location.startLocationUpdatesAsync(AUTOTRACK_TASK, {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 50,
      deferredUpdatesInterval: 30000,
      pausesUpdatesAutomatically: true,
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

interface Live { distance: number; lastLat?: number; lastLon?: number; lastTs: number; startTs: number; active: boolean; }

const MANUAL_NOISE_KM = 0.004; // 4 m floor — drop GPS jitter
const GPS_ACC_MAX_M = 35;      // ignore fixes less accurate than this (metres)
const GPS_MAX_KMH = 180;       // ignore segments implying an impossible speed (GPS glitch)

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
export async function ingestManualPoint(latitude: number, longitude: number, ts: number, accuracy?: number | null): Promise<void> {
  const live = await readJSON<Live | null>(LIVE_KEY, null);
  if (!live || !live.active) return;
  if (accuracy != null && accuracy > GPS_ACC_MAX_M) return; // junk fix — ignore entirely
  if (live.lastLat != null && ts <= live.lastTs) return;    // duplicate / stale fix
  if (live.lastLat != null && live.lastLon != null) {
    const d = haversine(live.lastLat, live.lastLon, latitude, longitude);
    const dtH = Math.max(0, ts - live.lastTs) / 3600000;
    const kmh = dtH > 0 ? d / dtH : Infinity;
    if (kmh > GPS_MAX_KMH) return; // teleport glitch — don't move the reference point
    if (d > MANUAL_NOISE_KM) live.distance += d;
  }
  live.lastLat = latitude; live.lastLon = longitude; live.lastTs = ts;
  await writeJSON(LIVE_KEY, live);
}

if (Platform.OS !== "web") {
  TaskManager.defineTask(MANUAL_TASK, async ({ data, error }: any) => {
    if (error) return;
    const locs: Location.LocationObject[] = data?.locations || [];
    for (const loc of locs) {
      await ingestManualPoint(loc.coords.latitude, loc.coords.longitude, loc.timestamp, loc.coords.accuracy);
    }
  });
}

export async function isManualRunning(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try { return await Location.hasStartedLocationUpdatesAsync(MANUAL_TASK); }
  catch { return false; }
}

export async function startManualDrive(): Promise<EnableResult> {
  if (Platform.OS === "web") return { ok: false, reason: "unsupported" };
  let fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted && fg.canAskAgain) fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, reason: "permission", canAskAgain: fg.canAskAgain };
  let bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted && bg.canAskAgain) bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) return { ok: false, reason: "permission", canAskAgain: bg.canAskAgain };

  await pauseAutotrackForManual(); // don't double-count the same drive
  await writeJSON(LIVE_KEY, { distance: 0, lastTs: Date.now(), startTs: Date.now(), active: true } as Live);
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
  return {
    distanceKm: live ? Math.round(live.distance * 100) / 100 : 0,
    startTs: live ? live.startTs : Date.now(),
    endTs: live ? live.lastTs : Date.now(),
  };
}
