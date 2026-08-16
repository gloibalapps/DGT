import React, { useCallback, useRef, useState } from "react";
import { View, Pressable, Linking, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, TripT, todayISO } from "@/src/api";
import { displayDateShort } from "@/src/date";
import { getPendingDrives, clearPendingDrive, PendingDrive } from "@/src/autotrack";
import {
  Screen, ScreenHeader, Card, AppText, Money, IconButton, Spinner,
  EmptyState, PrimaryButton, SecondaryButton, Badge, useToast, fmtMoney,
} from "@/src/ui";

function haversine(a: any, b: any) {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const la1 = (a.latitude * Math.PI) / 180;
  const la2 = (b.latitude * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export default function Mileage() {
  const { colors } = useTheme();
  const { version, refresh, vehicles, activeVehicleId, setActiveVehicle } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const [trips, setTrips] = useState<TripT[]>([]);
  const [tm, setTm] = useState<any>(null);
  const [autoDrives, setAutoDrives] = useState<PendingDrive[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // GPS shift state
  const [tracking, setTracking] = useState(false);
  const [dist, setDist] = useState(0);
  const [pendingTag, setPendingTag] = useState<number | null>(null);
  const [pendingDuration, setPendingDuration] = useState(0);
  const subRef = useRef<Location.LocationSubscription | null>(null);
  const lastRef = useRef<any>(null);
  const startTimeRef = useRef<number>(0);

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
    let perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) {
      show("Location needed to track your drive", "error");
      if (!perm.canAskAgain) Linking.openSettings();
      return;
    }
    setDist(0); lastRef.current = null; startTimeRef.current = Date.now(); setTracking(true);
    subRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 20, timeInterval: 4000 },
      (loc) => {
        const c = loc.coords;
        if (lastRef.current) {
          const d = haversine(lastRef.current, c);
          if (d > 0.005) setDist((prev) => prev + d);
        }
        lastRef.current = c;
      },
    );
  };

  const stopShift = async () => {
    try { subRef.current?.remove(); } catch { /* web */ }
    subRef.current = null; setTracking(false);
    const km = Math.round(dist * 100) / 100;
    if (km <= 0) { show("No distance recorded", "info"); return; }
    setPendingDuration(Math.max(0, Math.round((Date.now() - startTimeRef.current) / 60000)));
    setPendingTag(km);
  };

  const saveGpsTrip = async (type: "business" | "personal") => {
    if (pendingTag == null) return;
    try {
      await api.addTrip({ date: todayISO(), distance_km: pendingTag, duration_min: pendingDuration, type, source: "gps", vehicle_id: activeVehicleId });
      show(`${pendingTag} km logged as ${type === "business" ? "business" : "private"}`, "success");
      setPendingTag(null); refresh(); load();
    } catch { show("Couldn't save trip — try again", "error"); }
  };

  const classifyAuto = async (d: PendingDrive, type: "business" | "personal") => {
    try {
      await api.addTrip({ date: d.date, distance_km: d.distance_km, duration_min: Math.max(0, Math.round((d.end_ts - d.start_ts) / 60000)), type, source: "gps", vehicle_id: activeVehicleId });
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

  const today = tm?.today;
  const unit = tm?.distance_unit || "km";
  const odo = tm?.odometer;

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

      {/* ---- Today ---- */}
      <Card style={{ marginBottom: 14 }}>
        <AppText variant="label" color={colors.dim} style={{ marginBottom: 10 }}>TODAY</AppText>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <View>
            <AppText style={{ fontFamily: "BarlowCondensed-Bold", fontSize: 40, color: colors.text, fontVariant: ["tabular-nums"] }}>
              {today.total_km} {unit}
            </AppText>
            <AppText variant="caption" color={colors.dim}>Total driven</AppText>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <AppText variant="bodySemi" color={colors.profit}>{today.business_km} {unit} business</AppText>
            <AppText variant="caption" color={colors.dim}>{today.private_km} {unit} private · {today.business_pct}% business</AppText>
            {today.per_business_km != null ? (
              <View style={{ marginTop: 6, backgroundColor: colors.surfaceAlt, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
                <AppText variant="caption" color={colors.accent}>{fmtMoney(today.per_business_km)}/business {unit}</AppText>
              </View>
            ) : null}
          </View>
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

      {/* ---- Logging controls ---- */}
      {pendingTag != null ? (
        <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
          <AppText variant="h2" style={{ marginBottom: 4 }}>{pendingTag} {unit} drive</AppText>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
            Was this trip business or private? GPS knows you drove, not why.
          </AppText>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <PrimaryButton testID="gps-tag-business" label="Business" onPress={() => saveGpsTrip("business")} style={{ flex: 1 }} />
            <SecondaryButton testID="gps-tag-personal" label="Private" onPress={() => saveGpsTrip("personal")} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : tracking ? (
        <Card style={{ marginBottom: 14, borderColor: colors.profit, alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.loss, marginRight: 8 }} />
            <AppText variant="label" color={colors.dim}>TRACKING SHIFT</AppText>
          </View>
          <Money value={Math.round(dist * 100) / 100} symbol="" size={46} />
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>{unit} this drive</AppText>
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

      {/* ---- History ---- */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <AppText variant="h2">History</AppText>
        {trips.length > 0 ? (
          <Pressable testID="mileage-export" onPress={exportReport} hitSlop={8} style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="download-outline" size={16} color={colors.accent} style={{ marginRight: 4 }} />
            <AppText variant="caption" color={colors.accent}>Motor vehicle report</AppText>
          </Pressable>
        ) : null}
      </View>
      {trips.length === 0 ? (
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
      )}
    </Screen>
  );
}
