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
import { applyFix, MIN_DRIVE_KM, shouldRestartLocationUpdates, STOP_GAP_MS, type DriveState, type GpsFix } from "./gpsTrack";

export const AUTOTRACK_TASK = "gigtax-autotrack";
const ENABLED_KEY = "gigtax.autotrack.enabled"; // boolean (scalar)
const BUF_KEY = "gigtax.autotrack.buffer"; // JSON string
const PENDING_KEY = "gigtax.autotrack.pending"; // JSON string (array)
const MAX_AVG_KMH = 130;      // a whole drive can't average more than this

export interface PendingDrive {
  id: string;
  distance_km: number;
  date: string; // YYYY-MM-DD (local, from drive start)
  start_ts: number;
  end_ts: number;
}

interface LegacyBuffer {
  lastLat: number; lastLon: number; lastTs: number; distance: number; startTs: number;
  lastSpeed?: number | null; seenTs?: number;
  anchorLat?: number;
}

function asState(raw: DriveState | LegacyBuffer | null): DriveState | null {
  if (!raw || typeof (raw as LegacyBuffer).lastLat !== "number") return null;
  if (typeof raw.anchorLat === "number" && typeof (raw as DriveState).armed === "boolean") return raw as DriveState;
  const legacy = raw as LegacyBuffer;
  return {
    anchorLat: legacy.lastLat, anchorLon: legacy.lastLon, anchorTs: legacy.startTs || legacy.lastTs,
    lastLat: legacy.lastLat, lastLon: legacy.lastLon, lastTs: legacy.lastTs,
    lastSpeed: legacy.lastSpeed ?? null, seenTs: legacy.seenTs ?? legacy.lastTs,
    distance: legacy.distance || 0, startTs: legacy.startTs || legacy.lastTs,
    speedStreak: 0, progress: 0, farthestM: 0, armed: (legacy.distance || 0) > 0,
  };
}

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  const raw = await storage.getItem<string>(key, "");
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}
async function writeJSON(key: string, value: unknown): Promise<void> {
  await storage.setItem(key, JSON.stringify(value));
}

function finalize(buf: DriveState): PendingDrive {
  return {
    id: `${buf.startTs}`,
    distance_km: Math.round(buf.distance * 100) / 100,
    date: new Date(buf.startTs).toLocaleDateString("en-CA"),
    start_ts: buf.startTs,
    end_ts: buf.seenTs || buf.lastTs,
  };
}

function toFix(loc: Location.LocationObject): GpsFix {
  return {
    lat: loc.coords.latitude,
    lon: loc.coords.longitude,
    ts: loc.timestamp,
    accuracy: loc.coords.accuracy,
    speed: loc.coords.speed,
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
  let buf = asState(await readJSON<DriveState | LegacyBuffer | null>(BUF_KEY, null));
  const pending = await readJSON<PendingDrive[]>(PENDING_KEY, []);
  const locs = [...locsIn].sort((a, b) => a.timestamp - b.timestamp);
  for (const loc of locs) {
    const fix = toFix(loc);
    if (buf && fix.ts - buf.lastTs > STOP_GAP_MS) {
      if (buf.armed && buf.distance >= MIN_DRIVE_KM) pending.push(finalize(buf));
      buf = null;
    }
    buf = applyFix(buf, fix).state;
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
  const buf = asState(await readJSON<DriveState | LegacyBuffer | null>(BUF_KEY, null));
  if (!buf) return;
  if (Date.now() - buf.lastTs > STOP_GAP_MS) {
    if (buf.armed && buf.distance >= MIN_DRIVE_KM) {
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

interface Live {
  distance: number; lastLat?: number; lastLon?: number; lastTs: number; lastSpeed?: number | null;
  startTs: number; active: boolean; gate?: DriveState | null;
  lastFixAt?: number | null; lastAccuracy?: number | null;
  updatesStartedAt?: number | null; restartedAt?: number | null;
}

export type GpsPhase = "idle" | "denied" | "waiting" | "fix";

const MANUAL_UPDATE_OPTIONS = {
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
};


// Read-modify-write a single GPS fix into the live drive. Shared by BOTH the
// background foreground-service task AND the in-app foreground watcher, so the
// running distance is persisted to storage on EVERY update from either source
// and can never be lost if the OS kills the app.
//
// Distance is gated in gpsTrack.applyFix: poor fixes, jumps, and stationary
// jitter never move the anchor or add kilometres. A drive is not "moving"
// until speed stays at/above ~2.5 m/s or the phone is 150 m from its anchor.
// Serialise every write so two listeners cannot interleave one read-modify-write.
// A second fix within 1.5s of the last accepted point is dropped in applyFix,
// so a duplicate batch or a second subscription cannot add the same stretch twice.
let ingestChain: Promise<void> = Promise.resolve();
export function ingestManualPoint(latitude: number, longitude: number, ts: number, accuracy?: number | null, speed?: number | null): Promise<void> {
  ingestChain = ingestChain.then(() => ingestOne(latitude, longitude, ts, accuracy, speed)).catch(() => {});
  return ingestChain;
}

async function ingestOne(latitude: number, longitude: number, ts: number, accuracy?: number | null, speed?: number | null): Promise<void> {
  const live = await readJSON<Live | null>(LIVE_KEY, null);
  if (!live || !live.active) return;
  live.lastFixAt = ts;
  live.lastAccuracy = accuracy ?? null;
  const step = applyFix(live.gate ?? null, { lat: latitude, lon: longitude, ts, accuracy, speed });
  if (step.state) {
    live.gate = step.state;
    live.distance = step.state.distance;
    live.lastLat = step.state.lastLat;
    live.lastLon = step.state.lastLon;
    live.lastTs = step.state.lastTs;
    live.lastSpeed = step.state.lastSpeed;
  }
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

let manualBackground = false;

/** True once this drive owns the background task, so the screen must not also watch. */
export function manualUsesBackgroundTask(): boolean {
  return manualBackground;
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
  const now = Date.now();
  await writeJSON(LIVE_KEY, {
    distance: 0, lastTs: 0, startTs: now, active: true,
    updatesStartedAt: now, lastFixAt: null, lastAccuracy: null, restartedAt: null,
  } as Live);
  if (!background) {
    manualBackground = false;
    return { ok: true, backgroundOff: true };
  }
  manualBackground = true;
  try {
    await ensureManualUpdates();
  } catch {
    manualBackground = false;
  }
  return { ok: true };
}

/** Restart a location task that Android still reports as started but that has
 * stopped delivering fixes (typical after installing over the previous build). */
export async function ensureManualUpdates(): Promise<{ phase: GpsPhase; accuracy: number | null }> {
  if (Platform.OS === "web") return { phase: "idle", accuracy: null };
  const live = await readJSON<Live | null>(LIVE_KEY, null);
  if (!live?.active) return { phase: "idle", accuracy: null };
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) return { phase: "denied", accuracy: live.lastAccuracy ?? null };
  const bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted) {
    manualBackground = false;
    const heard = live.lastFixAt != null;
    return { phase: heard ? "fix" : "waiting", accuracy: live.lastAccuracy ?? null };
  }
  manualBackground = true;
  const started = await isManualRunning();
  const now = Date.now();
  const updatesStartedAt = live.updatesStartedAt || live.startTs || now;
  if (shouldRestartLocationUpdates({
    started,
    now,
    lastFixAt: live.lastFixAt ?? null,
    updatesStartedAt,
    restartedAt: live.restartedAt ?? null,
  })) {
    if (started) {
      try { await Location.stopLocationUpdatesAsync(MANUAL_TASK); } catch { /* stale task */ }
    }
    try {
      await Location.startLocationUpdatesAsync(MANUAL_TASK, MANUAL_UPDATE_OPTIONS);
    } catch {
      manualBackground = false;
      return { phase: "waiting", accuracy: live.lastAccuracy ?? null };
    }
    live.updatesStartedAt = now;
    live.restartedAt = now;
    await writeJSON(LIVE_KEY, live);
    return { phase: "waiting", accuracy: live.lastAccuracy ?? null };
  }
  const heard = live.lastFixAt != null && live.lastFixAt >= updatesStartedAt;
  return { phase: heard ? "fix" : "waiting", accuracy: live.lastAccuracy ?? null };
}

export async function getManualLive(): Promise<{
  distanceKm: number; startTs: number; active: boolean; lastFixAt: number | null; lastAccuracy: number | null;
} | null> {
  const live = await readJSON<Live | null>(LIVE_KEY, null);
  if (!live) return null;
  return {
    distanceKm: Math.round(live.distance * 100) / 100, startTs: live.startTs, active: !!live.active,
    lastFixAt: live.lastFixAt ?? null, lastAccuracy: live.lastAccuracy ?? null,
  };
}

export async function stopManualDrive(): Promise<{ distanceKm: number; startTs: number; endTs: number }> {
  const live = await readJSON<Live | null>(LIVE_KEY, null);
  manualBackground = false;
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
