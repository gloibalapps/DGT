import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Linking, RefreshControl, Animated, Easing, Alert, Platform } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import * as IntentLauncher from "expo-intent-launcher";
import * as Location from "expo-location";

import { useTheme, FONT } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, TripT, todayISO } from "@/src/api";
import { displayDateShort } from "@/src/date";
import { storage } from "@/src/utils/storage";
import { OdometerCheck } from "@/src/OdometerCheck";
import { useLocationDisclosure } from "@/src/LocationDisclosure";
import { getPendingDrives, clearPendingDrive, PendingDrive, startManualDrive, getManualLive, stopManualDrive, ingestManualPoint, isManualRunning } from "@/src/autotrack";
import {
  Screen, ScreenHeader, Card, AppText, IconButton, Spinner, Field, Select, HeroCard, ListCard, ListRow, SectionLabel,
  EmptyState, PrimaryButton, SecondaryButton, useToast, fmtMoney, Input,
} from "@/src/ui";

const BATTERY_PROMPT_KEY = "gigtax.battery_prompt_seen";

export default function Mileage() {
  const { colors } = useTheme();
  const { version, refresh, vehicles, activeVehicleId, setActiveVehicle, reloadVehicles } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const [trips, setTrips] = useState<TripT[]>([]);
  const [tm, setTm] = useState<any>(null);
  const [autoDrives, setAutoDrives] = useState<PendingDrive[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // GPS shift state. Distance is auto-saved to storage by a background
  // foreground-service task, so it survives screen-off and even app kills.
  const [tracking, setTracking] = useState(false);
  const [dist, setDist] = useState(0);
  const [pendingTag, setPendingTag] = useState<number | null>(null);
  const [pendingRawKm, setPendingRawKm] = useState<number | null>(null);
  const [odoInput, setOdoInput] = useState("");
  const [pendingDuration, setPendingDuration] = useState(0);
  const [pendingStartTs, setPendingStartTs] = useState(0);
  const [pendingEndTs, setPendingEndTs] = useState(0);
  const startTimeRef = useRef<number>(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [savingTrip, setSavingTrip] = useState(false);
  const subRef = useRef<Location.LocationSubscription | null>(null);

  const activeVehicle = vehicles.find((v) => v.id === activeVehicleId);
  // Per-vehicle GPS calibration (scales tracked distance to match the odometer).
  const cal = ((activeVehicle?.gps_calibration_pct ?? 100) || 100) / 100;

  // While a drive is tracked, poll the auto-saved distance from storage (the
  // background task keeps writing it even when the screen is off) + tick the timer.
  useEffect(() => {
    if (!tracking) { setElapsedSec(0); return; }
    const id = setInterval(async () => {
      const live = await getManualLive();
      if (live) {
        setDist(live.distanceKm);
        if (live.startTs) startTimeRef.current = live.startTs;
      }
      setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1500);
    return () => clearInterval(id);
  }, [tracking]);

  // Recover an in-progress drive if the app was killed & reopened mid-drive.
  // The running distance was persisted to storage, so it comes back intact; we
  // also restart the foreground watcher so continued driving keeps counting.
  useEffect(() => {
    (async () => {
      const live = await getManualLive();
      if (live && live.active) {
        startTimeRef.current = live.startTs || Date.now();
        setDist(live.distanceKm);
        setTracking(true);
        await startForegroundWatch();
      }
    })();
    return () => stopForegroundWatch();
  }, []);

  // Foreground GPS watcher — persists every fix straight to storage (via the
  // shared ingest) so distance is NEVER only in memory. Belt-and-suspenders
  // alongside the background foreground-service task for aggressive OEMs.
  // Fallback only: if the background drive service is running it is the SINGLE
  // source of GPS points. Feeding a second stream of slightly different fixes
  // made the distance zig-zag and inflate several times over.
  const startForegroundWatch = async () => {
    if (subRef.current) return;
    if (await isManualRunning()) return;
    try {
      subRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5, timeInterval: 2000 },
        (loc) => { ingestManualPoint(loc.coords.latitude, loc.coords.longitude, loc.timestamp, loc.coords.accuracy, loc.coords.speed); },
      );
    } catch { /* web / no perm — the background task still covers it */ }
  };
  const stopForegroundWatch = () => {
    try { subRef.current?.remove(); } catch { /* noop */ }
    subRef.current = null;
  };

  const startedAtStr = () => new Date(startTimeRef.current).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const hmISO = (iso?: string | null) => iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const fmtElapsed = (s: number) => {
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${m % 60}m` : `${m} min`;
  };

  const load = useCallback(async () => {
    try {
      const [t, m, a] = await Promise.all([
        api.listTrips(), api.taxMileage(todayISO()), getPendingDrives(),
      ]);
      setTrips(t); setTm(m); setAutoDrives(a);
    } catch {
      show("Couldn't load mileage", "error");
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [show]);

  useFocusEffect(useCallback(() => { load(); }, [load, version]));

  const disclosure = useLocationDisclosure();

  const startShift = async () => {
    let res = await startManualDrive();
    if (res.reason === "disclosure") {
      // Prominent disclosure BEFORE any location system prompt. Declining
      // still tracks the drive, but only while the app is open.
      await disclosure.ask();
      res = await startManualDrive();
    }
    if (!res.ok) {
      if (res.reason === "unsupported") { show("GPS tracking needs a device build", "info"); return; }
      show("Location needed to track your drive", "error");
      if (res.canAskAgain === false) Linking.openSettings();
      return;
    }
    setDist(0); startTimeRef.current = Date.now(); setTracking(true);
    await startForegroundWatch();
    if (res.backgroundOff) { show("Tracking while the app is open — keep GigTax on screen during the drive", "info"); return; }
    maybePromptBattery();
  };

  // One-time nudge for aggressive Android battery managers (Blackview, Xiaomi,
  // Oppo, Samsung…) that kill background apps and can interrupt drive tracking.
  const maybePromptBattery = async () => {
    if (Platform.OS !== "android") return;
    if (await storage.getItem<boolean>(BATTERY_PROMPT_KEY, false)) return;
    await storage.setItem(BATTERY_PROMPT_KEY, true);
    Alert.alert(
      "Keep drive tracking reliable",
      "Some phones (Blackview, Xiaomi, Oppo, Samsung…) aggressively close apps in the background, which can stop your drive from being tracked. Allow GigTax to run without battery limits so your mileage keeps recording with the screen off.",
      [
        { text: "Not now", style: "cancel" },
        { text: "Open settings", onPress: openBatterySettings },
      ],
    );
  };

  const openBatterySettings = async () => {
    try { await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS); }
    catch {
      try { await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.BATTERY_SAVER_SETTINGS); }
      catch { Linking.openSettings(); }
    }
  };

  const stopShift = async () => {
    setTracking(false);
    stopForegroundWatch();
    const res = await stopManualDrive();
    const raw = res.distanceKm;
    const km = Math.round(raw * cal * 10) / 10;
    if (km <= 0) { show("No distance recorded", "info"); return; }
    setPendingRawKm(Math.round(raw * 10) / 10);   // raw GPS (uncalibrated) for auto-calibration
    setOdoInput("");
    const sTs = res.startTs || startTimeRef.current;
    const eTs = res.endTs || Date.now();
    setPendingStartTs(sTs); setPendingEndTs(eTs);
    setPendingDuration(Math.max(0, Math.round((eTs - sTs) / 60000)));
    setPendingTag(km);
  };

  const saveGpsTrip = async (type: "business" | "personal") => {
    if (pendingTag == null || savingTrip) return;
    setSavingTrip(true);
    const odo = parseFloat(odoInput);
    const useOdo = !isNaN(odo) && odo > 0;
    const km = useOdo ? Math.round(odo * 10) / 10 : pendingTag;
    try {
      await api.addTrip({ date: todayISO(), distance_km: km, duration_min: pendingDuration, type, source: "gps", vehicle_id: activeVehicleId,
        start_time: pendingStartTs ? new Date(pendingStartTs).toISOString() : null,
        end_time: pendingEndTs ? new Date(pendingEndTs).toISOString() : null });
      // Auto-calibrate this vehicle from the odometer vs the raw GPS distance.
      if (useOdo && activeVehicle?.id && pendingRawKm && pendingRawKm > 0) {
        const pct = Math.min(150, Math.max(50, Math.round((odo / pendingRawKm) * 1000) / 10));
        await api.updateVehicle(activeVehicle.id, { gps_calibration_pct: pct });
        await reloadVehicles();
        show(`${km} ${unit} logged · ${activeVehicle.make_model || "car"} GPS calibrated to ${pct}%`, "success");
      } else {
        show(`${km} ${unit} logged as ${type === "business" ? "business" : "private"}`, "success");
      }
      setPendingTag(null); setPendingRawKm(null); setOdoInput(""); setHistoryOpen(true); refresh(); load();
    } catch (e: any) {
      if (/^409/.test(e?.message || "")) {
        show("This drive overlaps a trip already logged — not saved twice", "info");
        setPendingTag(null); setPendingRawKm(null); setOdoInput(""); setHistoryOpen(true); load();
      } else show("Couldn't save trip — try again", "error");
    } finally { setSavingTrip(false); }
  };

  const classifyAuto = async (d: PendingDrive, type: "business" | "personal") => {
    if (savingTrip) return;
    setSavingTrip(true);
    try {
      await api.addTrip({ date: d.date, distance_km: Math.round(d.distance_km * cal * 10) / 10, duration_min: Math.max(0, Math.round((d.end_ts - d.start_ts) / 60000)), type, source: "gps", vehicle_id: activeVehicleId,
        start_time: new Date(d.start_ts).toISOString(), end_time: new Date(d.end_ts).toISOString() });
      await clearPendingDrive(d.id);
      show(`${d.distance_km} km logged`, "success");
      setHistoryOpen(true); refresh(); load();
    } catch (e: any) {
      if (/^409/.test(e?.message || "")) {
        await clearPendingDrive(d.id);
        show("Already logged — this drive overlaps an existing trip", "info");
        load();
      } else show("Couldn't save trip — try again", "error");
    } finally { setSavingTrip(false); }
  };

  const del = async (id: string) => {
    try { await api.deleteTrip(id); show("Trip deleted", "success"); load(); refresh(); }
    catch { show("Couldn't delete — try again", "error"); }
  };

  const exportReport = async () => {
    const url = await api.exportMileageUrl(todayISO());
    Linking.openURL(url);
  };

  const typeColor = (t: string) => t === "personal" ? colors.dim : t === "mixed" ? colors.warm : colors.profit;
  const typeLabel = (t: string, pct?: number | null) =>
    t === "personal" ? "Private" : t === "mixed" ? `Mixed ${pct ?? 50}%` : "Business";

  if (loading) return <Screen><Spinner /></Screen>;

  // Load failed (e.g. transient network/auth) — show a retry instead of crashing.
  if (!tm || !tm.today) {
    return (
      <Screen header={<ScreenHeader title="Mileage" />}>
        <EmptyState icon="cloud-offline-outline" title="Couldn't load mileage"
          subtitle="Check your connection and try again." />
        <PrimaryButton testID="mileage-retry" label="Retry" icon="refresh"
          onPress={() => { setLoading(true); load(); }} style={{ marginTop: 12 }} />
      </Screen>
    );
  }

  const today = tm.today;
  const unit = tm.distance_unit || "km";
  const odo = tm.odometer;

  return (
    <Screen
      header={<ScreenHeader title="Mileage" />}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      {/* ---- Vehicle ---- */}
      {vehicles.length > 0 ? (
        <Select testID="vehicle-select" title="Vehicle" value={activeVehicleId || ""}
          onChange={(id) => setActiveVehicle(id)} style={{ marginBottom: 16 }}
          options={vehicles.filter((v) => !!v.id).map((v) => ({
            key: v.id as string, label: v.registration || v.make_model || "Vehicle", icon: "car-outline",
            desc: v.disposal_date ? "Disposed — history kept" : (v.registration && v.make_model ? v.make_model : undefined),
          }))} />
      ) : null}

      {/* ---- Logging controls ---- */}
      {pendingTag != null ? (
        <Card style={{ marginBottom: 16, padding: 20 }}>
          <AppText variant="label" color={colors.dim}>Drive finished</AppText>
          <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 4 }}>
            <AppText style={{ fontFamily: FONT.bold, fontSize: 40, color: colors.text, fontVariant: ["tabular-nums"] }}>{pendingTag}</AppText>
            <AppText variant="bodySemi" color={colors.dim} style={{ marginLeft: 6 }}>{unit}</AppText>
          </View>
          <AppText testID="gps-drive-times" variant="caption" color={colors.dim} style={{ fontVariant: ["tabular-nums"], marginBottom: 12 }}>
            Start {hm(pendingStartTs)} · Finish {hm(pendingEndTs)} · {fmtElapsed(pendingDuration * 60)}
          </AppText>
          <Field label="Odometer distance (optional)"
            hint={`Logs the exact distance and auto-calibrates ${activeVehicle?.make_model || "this car"} for next time.`}>
            <Input testID="gps-odo" value={odoInput} onChangeText={setOdoInput} keyboardType="decimal-pad"
              placeholder={`${pendingTag} ${unit}`} />
          </Field>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>Was this drive business or private?</AppText>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <PrimaryButton testID="gps-tag-business" label="Business" disabled={savingTrip} onPress={() => saveGpsTrip("business")} style={{ flex: 1 }} />
            <SecondaryButton testID="gps-tag-personal" label="Private" disabled={savingTrip} onPress={() => saveGpsTrip("personal")} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : tracking ? (
        <Card testID="gps-live-card" style={{ marginBottom: 16, padding: 20, paddingBottom: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <PulsingDot color={colors.profit} />
            <AppText variant="label" color={colors.dim}>GPS tracking active</AppText>
          </View>
          <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 4 }}>
            <AppText style={{ fontFamily: FONT.bold, fontSize: 40, color: colors.text, fontVariant: ["tabular-nums"] }}>
              {dist > 0 ? (dist * cal).toFixed(1) : "0.0"}
            </AppText>
            <AppText variant="bodySemi" color={colors.dim} style={{ marginLeft: 6 }}>{unit}</AppText>
          </View>
          <AppText variant="caption" color={colors.dim} style={{ fontVariant: ["tabular-nums"] }}>
            {dist <= 0 ? "Acquiring GPS… · " : ""}Started {startedAtStr()} · {fmtElapsed(elapsedSec)}
            {activeVehicle ? ` · ${activeVehicle.registration || activeVehicle.make_model || "Vehicle"}` : ""}
          </AppText>
          <SecondaryButton testID="gps-stop" label="End drive" tone="danger" onPress={stopShift} style={{ marginTop: 8 }} />
        </Card>
      ) : (
        <View style={{ flexDirection: "row", gap: 12, marginBottom: 16 }}>
          <PrimaryButton testID="gps-start" label="GPS drive" icon="navigate-outline" style={{ flex: 1 }}
            onPress={startShift} />
          <SecondaryButton testID="trips-add" label="Add trip" icon="add" style={{ flex: 1 }}
            onPress={() => router.push({ pathname: "/entry" as any, params: { type: "trip" } })} />
        </View>
      )}

      {/* ---- Today ---- */}
      <HeroCard testID="mileage-today" label={`Today${tracking ? " · incl. live drive" : ""}`}
        value={0} display={(today.total_km + (tracking ? dist * cal : 0)).toFixed(1)} unit={unit} />
      <ListCard>
        <ListRow label={`Business ${unit}`} value={`${(today.business_km + (tracking ? dist * cal : 0)).toFixed(1)} ${unit}`} />
        <ListRow label={`Private ${unit}`} value={`${Number(today.private_km).toFixed(1)} ${unit}`} />
        <ListRow label="Business use" value={`${today.business_pct}%`} />
        {today.per_business_km != null ? <ListRow label={`Earned / business ${unit}`} value={fmtMoney(today.per_business_km)} /> : null}
      </ListCard>

      {/* ---- Day odometer check (compare + auto-correct this car) ---- */}
      {activeVehicle?.id && !tracking && pendingTag == null ? (
        <OdometerCheck vehicle={activeVehicle} trips={trips} unit={unit} onCalibrated={reloadVehicles} />
      ) : null}

      {/* ---- Odometer reconciliation (read-only; manage the car in Profile) ---- */}
      {odo?.has_odometer ? (
        <ListCard label="Odometer check">
          <ListRow icon="speedometer-outline" label="Odometer vs GPS" value={`${odo.odometer_km} / ${odo.gps_km} ${unit}`} />
          {odo?.warning ? <ListRow icon="warning-outline" iconColor={colors.warm} label={odo.warning} /> : null}
        </ListCard>
      ) : null}

      {/* ---- Auto-detected drives ---- */}
      {autoDrives.length > 0 && (
        <View style={{ marginBottom: 16 }}>
          <SectionLabel text={`${autoDrives.length} detected drive${autoDrives.length > 1 ? "s" : ""} to classify`} style={{ marginLeft: 4 }} />
          {autoDrives.map((d) => (
            <Card key={d.id} testID={`auto-drive-${d.id}`} style={{ marginBottom: 12 }}>
              <AppText variant="bodySemi" style={{ fontVariant: ["tabular-nums"] }}>{d.distance_km} {unit}</AppText>
              <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12, fontVariant: ["tabular-nums"] }}>
                {displayDateShort(d.date)} · Start {hm(d.start_ts)} · Finish {hm(d.end_ts)}
              </AppText>
              <View style={{ flexDirection: "row", gap: 12 }}>
                <PrimaryButton testID={`auto-business-${d.id}`} label="Business" disabled={savingTrip} onPress={() => classifyAuto(d, "business")} style={{ flex: 1 }} />
                <SecondaryButton testID={`auto-personal-${d.id}`} label="Private" disabled={savingTrip} onPress={() => classifyAuto(d, "personal")} style={{ flex: 1 }} />
              </View>
            </Card>
          ))}
        </View>
      )}

      {/* ---- History ---- */}
      <ListCard label="History">
        <ListRow testID="mileage-history-toggle" strong label={`${trips.length} trip${trips.length === 1 ? "" : "s"}`}
          onPress={() => setHistoryOpen((o) => !o)} trailingIcon={historyOpen ? "chevron-up" : "chevron-down"} />
        {historyOpen && trips.length === 0 ? <ListRow label="No trips recorded" sub="Add a trip or start a GPS drive to build your logbook." /> : null}
        {historyOpen ? trips.map((t) => (
          <ListRow key={t.id} testID={`trip-${t.id}`}
            label={`${t.distance_km} ${unit}`}
            sub={`${displayDateShort(t.date)}${t.start_time && t.end_time ? ` · Start ${hmISO(t.start_time)} · Finish ${hmISO(t.end_time)}` : ""}${t.source === "gps" ? " · GPS" : ""}${t.note ? ` · ${t.note}` : ""}`}
            value={typeLabel(t.type, t.business_pct)} valueColor={typeColor(t.type)}
            onPress={() => router.push({ pathname: "/entry" as any, params: { type: "trip", id: t.id } })}
            right={<IconButton icon="trash-outline" size={18} color={colors.dim} testID={`trip-del-${t.id}`} onPress={() => del(t.id)} />} />
        )) : null}
        {trips.length > 0 ? <ListRow testID="mileage-export" icon="download-outline" label="Motor vehicle report" onPress={exportReport} /> : null}
      </ListCard>
      {disclosure.element}
    </Screen>
  );
}

function PulsingDot({ color }: { color: string }) {
  const a = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue: 0.25, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(a, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [a]);
  return <Animated.View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color, marginRight: 8, opacity: a }} />;
}
