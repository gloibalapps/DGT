import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Pressable, Linking, RefreshControl, Animated, Easing, Alert, Platform } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as IntentLauncher from "expo-intent-launcher";
import * as Location from "expo-location";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, TripT, todayISO } from "@/src/api";
import { displayDateShort } from "@/src/date";
import { storage } from "@/src/utils/storage";
import { getPendingDrives, clearPendingDrive, PendingDrive, startManualDrive, getManualLive, stopManualDrive, ingestManualPoint } from "@/src/autotrack";
import {
  Screen, ScreenHeader, Card, AppText, IconButton, Spinner,
  EmptyState, PrimaryButton, SecondaryButton, Badge, useToast, fmtMoney, Input,
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
  const startTimeRef = useRef<number>(0);
  const [elapsedSec, setElapsedSec] = useState(0);
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
  const startForegroundWatch = async () => {
    if (subRef.current) return;
    try {
      subRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5, timeInterval: 2000 },
        (loc) => { ingestManualPoint(loc.coords.latitude, loc.coords.longitude, loc.timestamp); },
      );
    } catch { /* web / no perm — the background task still covers it */ }
  };
  const stopForegroundWatch = () => {
    try { subRef.current?.remove(); } catch { /* noop */ }
    subRef.current = null;
  };

  const startedAtStr = () => new Date(startTimeRef.current).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

  const startShift = async () => {
    const res = await startManualDrive();
    if (!res.ok) {
      if (res.reason === "unsupported") { show("GPS tracking needs a device build", "info"); return; }
      show("Location needed to track your drive", "error");
      if (res.canAskAgain === false) Linking.openSettings();
      return;
    }
    setDist(0); startTimeRef.current = Date.now(); setTracking(true);
    await startForegroundWatch();
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
    setPendingDuration(Math.max(0, Math.round((Date.now() - (res.startTs || startTimeRef.current)) / 60000)));
    setPendingTag(km);
  };

  const saveGpsTrip = async (type: "business" | "personal") => {
    if (pendingTag == null) return;
    const odo = parseFloat(odoInput);
    const useOdo = !isNaN(odo) && odo > 0;
    const km = useOdo ? Math.round(odo * 10) / 10 : pendingTag;
    try {
      await api.addTrip({ date: todayISO(), distance_km: km, duration_min: pendingDuration, type, source: "gps", vehicle_id: activeVehicleId });
      // Auto-calibrate this vehicle from the odometer vs the raw GPS distance.
      if (useOdo && activeVehicle && pendingRawKm && pendingRawKm > 0) {
        const pct = Math.min(150, Math.max(50, Math.round((odo / pendingRawKm) * 1000) / 10));
        await api.updateVehicle(activeVehicle.id, { gps_calibration_pct: pct });
        await reloadVehicles();
        show(`${km} ${unit} logged · ${activeVehicle.make_model || "car"} GPS calibrated to ${pct}%`, "success");
      } else {
        show(`${km} ${unit} logged as ${type === "business" ? "business" : "private"}`, "success");
      }
      setPendingTag(null); setPendingRawKm(null); setOdoInput(""); refresh(); load();
    } catch { show("Couldn't save trip — try again", "error"); }
  };

  const classifyAuto = async (d: PendingDrive, type: "business" | "personal") => {
    try {
      await api.addTrip({ date: d.date, distance_km: Math.round(d.distance_km * cal * 10) / 10, duration_min: Math.max(0, Math.round((d.end_ts - d.start_ts) / 60000)), type, source: "gps", vehicle_id: activeVehicleId });
      await clearPendingDrive(d.id);
      show(`${d.distance_km} km logged`, "success");
      refresh(); load();
    } catch { show("Couldn't save trip — try again", "error"); }
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
      <Screen header={<ScreenHeader subtitle="GPS → Logbook → Deduction" title="Tax Mileage" />}>
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
      header={<ScreenHeader subtitle="GPS → Logbook → Deduction" title="Tax Mileage" />}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      {/* ---- Vehicle switcher ---- */}
      {vehicles.length > 0 ? (
        <View style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <AppText variant="label" color={colors.dim}>YOUR VEHICLES</AppText>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {vehicles.map((v) => {
              const active = v.id === activeVehicleId;
              return (
                <Pressable key={v.id} testID={`vehicle-chip-${v.id}`} onPress={() => v.id && setActiveVehicle(v.id)}
                  style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, height: 40, borderRadius: 999,
                    backgroundColor: active ? colors.accent : colors.surfaceAlt,
                    borderWidth: 1, borderColor: active ? colors.accent : colors.border }}>
                  <Ionicons name="car-sport" size={15} color={active ? colors.bg : colors.dim} style={{ marginRight: 6 }} />
                  <AppText variant="bodyMed" color={active ? colors.bg : colors.text}>{v.registration || v.make_model || "Vehicle"}</AppText>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {/* ---- Logging controls ---- */}
      {pendingTag != null ? (
        <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
          <AppText variant="h2" style={{ marginBottom: 4 }}>{pendingTag} {unit} drive</AppText>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
            Was this trip business or private? GPS knows you drove, not why.
          </AppText>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>
            On your odometer? (optional) — logs the exact distance and auto-calibrates {activeVehicle?.make_model || "this car"} for next time.
          </AppText>
          <Input testID="gps-odo" value={odoInput} onChangeText={setOdoInput} keyboardType="decimal-pad"
            placeholder={`${pendingTag} ${unit}`} style={{ marginBottom: 12 }} />
          <View style={{ flexDirection: "row", gap: 10 }}>
            <PrimaryButton testID="gps-tag-business" label="Business" onPress={() => saveGpsTrip("business")} style={{ flex: 1 }} />
            <SecondaryButton testID="gps-tag-personal" label="Private" onPress={() => saveGpsTrip("personal")} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : tracking ? (
        <Card style={{ marginBottom: 14, borderColor: colors.profit, alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
            <PulsingDot color={colors.profit} />
            <AppText variant="label" color={colors.profit}>GPS TRACKING ACTIVE</AppText>
          </View>
          {dist <= 0 ? (
            <View style={{ alignSelf: "stretch", height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
              alignItems: "center", justifyContent: "center", marginBottom: 10 }}>
              <AppText variant="caption" color={colors.dim}>Acquiring GPS…</AppText>
            </View>
          ) : null}
          <AppText style={{ fontFamily: "BarlowCondensed-Bold", fontSize: 46, color: colors.text, fontVariant: ["tabular-nums"], letterSpacing: 0.3 }}>
            {(dist * cal).toFixed(1)}
          </AppText>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 2 }}>{unit} this drive</AppText>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: activeVehicle ? 2 : 12 }}>
            Started {startedAtStr()} · {fmtElapsed(elapsedSec)}
          </AppText>
          {activeVehicle ? (
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
              {activeVehicle.registration || activeVehicle.make_model || "Vehicle"} · Business
            </AppText>
          ) : null}
          <SecondaryButton testID="gps-stop" label="End drive" icon="stop-circle-outline" tone="danger"
            onPress={stopShift} style={{ alignSelf: "stretch" }} />
        </Card>
      ) : (
        <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
          <PrimaryButton testID="trips-add" label="Add trip" icon="add" style={{ flex: 1 }}
            onPress={() => router.push({ pathname: "/entry" as any, params: { type: "trip" } })} />
          <SecondaryButton testID="gps-start" label="GPS shift" icon="radio-outline" style={{ flex: 1 }}
            onPress={startShift} />
        </View>
      )}

      {/* ---- Today ---- */}
      <Card style={{ marginBottom: 14 }}>
        <AppText variant="label" color={colors.dim} style={{ marginBottom: 10 }}>TODAY</AppText>
        <AppText style={{ fontFamily: "BarlowCondensed-Bold", fontSize: 40, color: colors.text, fontVariant: ["tabular-nums"] }}>
          {(today.total_km + (tracking ? dist * cal : 0)).toFixed(1)} {unit}
        </AppText>
        <AppText variant="caption" color={colors.dim}>Total driven{tracking ? " · incl. live drive" : ""}</AppText>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
            <AppText variant="caption" color={colors.profit} style={{ fontWeight: "700" }}>{today.business_km} {unit} business</AppText>
          </View>
          <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
            <AppText variant="caption" color={colors.dim}>{today.private_km} {unit} private</AppText>
          </View>
          <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
            <AppText variant="caption" color={colors.dim}>{today.business_pct}% business</AppText>
          </View>
          {today.per_business_km != null ? (
            <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
              <AppText variant="caption" color={colors.accent}>{fmtMoney(today.per_business_km)}/business {unit}</AppText>
            </View>
          ) : null}
        </View>
      </Card>

      {/* ---- Odometer reconciliation (read-only; manage the car in Settings) ---- */}
      {odo?.has_odometer ? (
        <Card style={{ marginBottom: 14, borderColor: odo?.warning ? colors.warm : colors.border }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
              <Ionicons name="speedometer-outline" size={22} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant="bodySemi">Odometer check</AppText>
              <AppText variant="caption" color={colors.dim}>Odometer {odo.odometer_km} {unit} · GPS {odo.gps_km} {unit}</AppText>
            </View>
          </View>
          {odo?.warning ? (
            <View style={{ flexDirection: "row", marginTop: 10, backgroundColor: colors.surfaceAlt, borderRadius: 10, padding: 10 }}>
              <Ionicons name="warning-outline" size={16} color={colors.warm} style={{ marginRight: 8, marginTop: 1 }} />
              <AppText variant="caption" color={colors.warm} style={{ flex: 1, lineHeight: 16 }}>{odo.warning}</AppText>
            </View>
          ) : null}
        </Card>
      ) : null}

      {/* ---- Auto-detected drives ---- */}
      {autoDrives.length > 0 && (
        <View style={{ marginBottom: 14 }}>
          <AppText variant="label" color={colors.warm} style={{ marginBottom: 8, marginLeft: 4 }}>
            {autoDrives.length} AUTO-DETECTED DRIVE{autoDrives.length > 1 ? "S" : ""} TO CLASSIFY
          </AppText>
          {autoDrives.map((d) => (
            <Card key={d.id} testID={`auto-drive-${d.id}`} style={{ marginBottom: 8, borderColor: colors.warm }}>
              <AppText variant="bodySemi" style={{ marginBottom: 2 }}>{d.distance_km} {unit} drive</AppText>
              <AppText variant="caption" color={colors.dim} style={{ marginBottom: 10 }}>
                {displayDateShort(d.date)} · detected automatically — business or private?
              </AppText>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <PrimaryButton testID={`auto-business-${d.id}`} label="Business" onPress={() => classifyAuto(d, "business")} style={{ flex: 1 }} />
                <SecondaryButton testID={`auto-personal-${d.id}`} label="Private" onPress={() => classifyAuto(d, "personal")} style={{ flex: 1 }} />
              </View>
            </Card>
          ))}
        </View>
      )}

      {/* ---- History (tap to expand) ---- */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <Pressable testID="mileage-history-toggle" onPress={() => setHistoryOpen((o) => !o)} hitSlop={8}
          style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
          <AppText variant="h2">History</AppText>
          {trips.length > 0 ? (
            <AppText variant="caption" color={colors.dim} style={{ marginLeft: 8 }}>
              {trips.length} trip{trips.length > 1 ? "s" : ""}
            </AppText>
          ) : null}
          <Ionicons name={historyOpen ? "chevron-up" : "chevron-down"} size={20} color={colors.dim} style={{ marginLeft: 6 }} />
        </Pressable>
        {trips.length > 0 ? (
          <Pressable testID="mileage-export" onPress={exportReport} hitSlop={8} style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="download-outline" size={16} color={colors.accent} style={{ marginRight: 4 }} />
            <AppText variant="caption" color={colors.accent}>Motor vehicle report</AppText>
          </Pressable>
        ) : null}
      </View>
      {historyOpen ? (
        trips.length === 0 ? (
          <EmptyState icon="car-sport-outline" title="No trips recorded" subtitle="Add a trip or start a GPS shift to build your logbook." />
        ) : (
          trips.map((t) => (
            <Pressable key={t.id} testID={`trip-${t.id}`}
              onPress={() => router.push({ pathname: "/entry" as any, params: { type: "trip", id: t.id } })}>
              <Card style={{ flexDirection: "row", alignItems: "center", marginBottom: 8, paddingVertical: 12 }}>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySemi" style={{ fontVariant: ["tabular-nums"] }}>{t.distance_km} {unit}</AppText>
                  <AppText variant="caption" color={colors.dim}>
                    {displayDateShort(t.date)}{t.source === "gps" ? " · GPS" : ""}{t.note ? ` · ${t.note}` : ""}
                  </AppText>
                </View>
                <Badge label={typeLabel(t.type, t.business_pct)} color={typeColor(t.type)} bg={colors.surfaceAlt} />
                <IconButton icon="trash-outline" size={18} color={colors.dim} testID={`trip-del-${t.id}`}
                  onPress={() => del(t.id)} />
              </Card>
            </Pressable>
          ))
        )
      ) : null}
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
