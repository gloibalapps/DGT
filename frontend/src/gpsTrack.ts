/**
 * Pure drive gate shared by auto-detect and the manual GPS shift.
 * A trip does not start, and no kilometres are added, until the phone shows
 * sustained movement. Stationary GPS wander stays on a fixed anchor.
 */

export const POOR_ACC_M = 50;
export const DRIVE_SPEED_MS = 2.5;
export const ARM_SPEED_FIXES = 3;
export const ARM_DISPLACE_M = 150;
export const ARM_PROGRESS_FIXES = 3;
export const MAX_STEP_MS = 50; // 180 km/h
export const MIN_STEP_M = 12;
export const MIN_IMPLIED_MS = 2.5;
export const STOP_GAP_MS = 5 * 60 * 1000;
export const MIN_DRIVE_KM = 0.3;
/** If a location task claims to be running but no fix arrives, restart it. */
export const FIX_WAIT_MS = 25_000;

export interface GpsFix {
  lat: number;
  lon: number;
  ts: number;
  accuracy?: number | null;
  speed?: number | null;
}

export interface DriveState {
  anchorLat: number;
  anchorLon: number;
  anchorTs: number;
  lastLat: number;
  lastLon: number;
  lastTs: number;
  lastSpeed: number | null;
  seenTs: number;
  distance: number;
  startTs: number;
  speedStreak: number;
  progress: number;
  farthestM: number;
  armed: boolean;
}

export interface StepResult {
  state: DriveState | null;
  addedKm: number;
  armedNow: boolean;
  ignored: "accuracy" | "jump" | "gap" | "still" | "tiny" | null;
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  return haversineKm(aLat, aLon, bLat, bLon) * 1000;
}

function knownSpeed(speed?: number | null): number | null {
  if (speed == null || speed < 0) return null;
  return speed;
}

function blank(fix: GpsFix): DriveState {
  return {
    anchorLat: fix.lat, anchorLon: fix.lon, anchorTs: fix.ts,
    lastLat: fix.lat, lastLon: fix.lon, lastTs: fix.ts, lastSpeed: knownSpeed(fix.speed),
    seenTs: fix.ts, distance: 0, startTs: fix.ts,
    speedStreak: 0, progress: 0, farthestM: 0, armed: false,
  };
}

export function applyFix(state: DriveState | null, fix: GpsFix): StepResult {
  if (fix.accuracy != null && fix.accuracy > POOR_ACC_M) {
    return { state, addedKm: 0, armedNow: false, ignored: "accuracy" };
  }
  if (!state) return { state: blank(fix), addedKm: 0, armedNow: false, ignored: null };

  const dtS = (fix.ts - state.seenTs) / 1000;
  if (dtS < 1) return { state, addedKm: 0, armedNow: false, ignored: "gap" };

  const stepM = metres(state.lastLat, state.lastLon, fix.lat, fix.lon);
  const implied = stepM / dtS;
  if (implied > MAX_STEP_MS) return { state, addedKm: 0, armedNow: false, ignored: "jump" };

  const spd = knownSpeed(fix.speed);
  const fromAnchor = metres(state.anchorLat, state.anchorLon, fix.lat, fix.lon);

  if (!state.armed) {
    const next: DriveState = { ...state, seenTs: fix.ts };
    if (spd != null && spd >= DRIVE_SPEED_MS) next.speedStreak += 1;
    else next.speedStreak = 0;

    const outward = fromAnchor > state.farthestM + 20;
    const plausible = implied >= MIN_IMPLIED_MS && stepM >= MIN_STEP_M;
    const speedAllows = spd == null || spd >= DRIVE_SPEED_MS;
    if (plausible && outward && speedAllows) {
      next.progress += 1;
      next.farthestM = fromAnchor;
    } else if (fromAnchor < state.farthestM - 40) {
      next.progress = 0;
    }

    const armBySpeed = next.speedStreak >= ARM_SPEED_FIXES;
    const armByMove = next.progress >= ARM_PROGRESS_FIXES && next.farthestM >= ARM_DISPLACE_M;
    if (!armBySpeed && !armByMove) {
      return { state: next, addedKm: 0, armedNow: false, ignored: "still" };
    }
    const windowS = Math.max(dtS, (fix.ts - state.anchorTs) / 1000);
    const capM = spd != null ? spd * windowS * 1.15 : fromAnchor;
    const addedKm = Math.min(fromAnchor, capM) / 1000;
    next.armed = true;
    next.distance = addedKm;
    next.startTs = state.anchorTs;
    next.lastLat = fix.lat;
    next.lastLon = fix.lon;
    next.lastTs = fix.ts;
    next.lastSpeed = spd;
    return { state: next, addedKm, armedNow: true, ignored: null };
  }

  if (spd != null && spd < DRIVE_SPEED_MS) {
    return { state: { ...state, seenTs: fix.ts }, addedKm: 0, armedNow: false, ignored: "still" };
  }
  if (stepM < MIN_STEP_M || (spd == null && implied < MIN_IMPLIED_MS) || implied < 1) {
    return { state: { ...state, seenTs: fix.ts }, addedKm: 0, armedNow: false, ignored: implied < 1 || stepM < MIN_STEP_M ? "tiny" : "still" };
  }
  let km = stepM / 1000;
  if (spd != null) {
    const refSpd = state.lastSpeed != null && state.lastSpeed >= 0 ? state.lastSpeed : spd;
    km = Math.min(km, ((spd + refSpd) / 2) * dtS * 1.15 / 1000);
  }
  return {
    state: {
      ...state,
      distance: state.distance + km,
      lastLat: fix.lat, lastLon: fix.lon, lastTs: fix.ts, lastSpeed: spd, seenTs: fix.ts,
    },
    addedKm: km,
    armedNow: false,
    ignored: null,
  };
}

export interface FoldedDrive {
  state: DriveState | null;
  closed: { distanceKm: number; startTs: number; endTs: number }[];
  distanceKm: number;
  armed: boolean;
}

/**
 * A task that Android still lists as started after an app upgrade can stop
 * delivering fixes. Restart it when nothing has arrived since we last started
 * it, and do not restart again until another wait has passed.
 */
export function shouldRestartLocationUpdates(input: {
  started: boolean;
  now: number;
  lastFixAt: number | null;
  updatesStartedAt: number;
  restartedAt: number | null;
}): boolean {
  if (!input.started) return true;
  const heard = input.lastFixAt != null && input.lastFixAt >= input.updatesStartedAt;
  const since = heard ? input.lastFixAt! : input.updatesStartedAt;
  if (input.now - since < FIX_WAIT_MS) return false;
  if (input.restartedAt != null && input.now - input.restartedAt < FIX_WAIT_MS) return false;
  return true;
}

/** Replay fixes the way auto-detect does, including the stationary stop-gap. */
export function foldFixes(fixes: GpsFix[], stopGapMs = STOP_GAP_MS): FoldedDrive {
  let state: DriveState | null = null;
  const closed: FoldedDrive["closed"] = [];
  const ordered = [...fixes].sort((a, b) => a.ts - b.ts);
  for (const fix of ordered) {
    if (state && fix.ts - state.lastTs > stopGapMs) {
      if (state.armed && state.distance >= MIN_DRIVE_KM) {
        closed.push({
          distanceKm: Math.round(state.distance * 100) / 100,
          startTs: state.startTs,
          endTs: state.seenTs || state.lastTs,
        });
      }
      state = null;
    }
    state = applyFix(state, fix).state;
  }
  return {
    state,
    closed,
    distanceKm: Math.round((state?.distance ?? 0) * 100) / 100,
    armed: !!state?.armed,
  };
}
