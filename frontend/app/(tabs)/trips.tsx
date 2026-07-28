import React, { useCallback, useMemo, useRef, useState } from "react";
import { View, Pressable, Linking, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, TripT, todayISO } from "@/src/api";
import { displayDateShort } from "@/src/date";
import {
  Screen, ScreenHeader, Card, AppText, Money, IconButton, Spinner,
  EmptyState, PrimaryButton, SecondaryButton, Badge, useToast,
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

export default function Trips() {
  const { colors } = useTheme();
  const { version, refresh } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const [trips, setTrips] = useState<TripT[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // GPS shift state
  const [tracking, setTracking] = useState(false);
  const [dist, setDist] = useState(0);
  const [pendingTag, setPendingTag] = useState<number | null>(null); // km awaiting classification
  const subRef = useRef<Location.LocationSubscription | null>(null);
  const lastRef = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      setTrips(await api.listTrips());
    } catch {
      show("Couldn't load trips", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [show]);

  useFocusEffect(useCallback(() => { load(); }, [load, version]));

  const stats = useMemo(() => {
    let biz = 0, per = 0;
    for (const t of trips) {
      if (t.type === "personal") per += t.distance_km;
      else biz += t.distance_km;
    }
    const total = biz + per;
    return { biz: Math.round(biz * 10) / 10, per: Math.round(per * 10) / 10, pct: total > 0 ? Math.round((biz / total) * 1000) / 10 : 100 };
  }, [trips]);

  const startShift = async () => {
    let perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) {
      show("Location needed to auto-track drives", "error");
      if (!perm.canAskAgain) Linking.openSettings();
      return;
    }
    setDist(0);
    lastRef.current = null;
    setTracking(true);
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
    subRef.current?.remove();
    subRef.current = null;
    setTracking(false);
    const km = Math.round(dist * 100) / 100;
    if (km <= 0) { show("No distance recorded", "info"); return; }
    setPendingTag(km); // GPS can tell THAT you drove, never WHY — ask.
  };

  const saveGpsTrip = async (type: "business" | "personal") => {
    if (pendingTag == null) return;
    await api.addTrip({ date: todayISO(), distance_km: pendingTag, type, source: "gps" });
    setPendingTag(null);
    show(`${pendingTag} km logged as ${type}`, "success");
    refresh();
    load();
  };

  const flip = async (t: TripT) => {
    const next = t.type === "personal" ? "business" : "personal";
    await api.updateTrip(t.id, { type: next });
    load();
    refresh();
  };

  const del = async (id: string) => {
    await api.deleteTrip(id);
    show("Trip deleted", "success");
    load();
    refresh();
  };

  if (loading) return <Screen><Spinner /></Screen>;

  return (
    <Screen
      header={<ScreenHeader subtitle="Logbook" title="Trips" />}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      {/* Business-use gauge */}
      <Card style={{ marginBottom: 14, alignItems: "center" }}>
        <AppText variant="label" color={colors.dim}>BUSINESS-USE %</AppText>
        <AppText style={{ fontFamily: "BarlowCondensed-Bold", fontSize: 64, color: colors.accent, fontVariant: ["tabular-nums"] }}>
          {stats.pct}%
        </AppText>
        <View style={{ flexDirection: "row", gap: 28, marginTop: 4 }}>
          <View style={{ alignItems: "center" }}>
            <AppText variant="bodySemi" color={colors.profit}>{stats.biz} km</AppText>
            <AppText variant="caption" color={colors.dim}>Business</AppText>
          </View>
          <View style={{ alignItems: "center" }}>
            <AppText variant="bodySemi" color={colors.dim}>{stats.per} km</AppText>
            <AppText variant="caption" color={colors.dim}>Personal</AppText>
          </View>
        </View>
      </Card>

      {/* GPS shift tracker */}
      {pendingTag != null ? (
        <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
          <AppText variant="h2" style={{ marginBottom: 4 }}>{pendingTag} km drive</AppText>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
            Was this trip business or personal? GPS knows you drove, not why.
          </AppText>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <PrimaryButton testID="gps-tag-business" label="Business" onPress={() => saveGpsTrip("business")} style={{ flex: 1 }} />
            <SecondaryButton testID="gps-tag-personal" label="Personal" onPress={() => saveGpsTrip("personal")} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : tracking ? (
        <Card style={{ marginBottom: 14, borderColor: colors.profit, alignItems: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.loss, marginRight: 8 }} />
            <AppText variant="label" color={colors.dim}>TRACKING SHIFT</AppText>
          </View>
          <Money value={Math.round(dist * 100) / 100} symbol="" size={46} />
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>km this drive</AppText>
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

      <AppText variant="h2" style={{ marginBottom: 10 }}>History</AppText>
      {trips.length === 0 ? (
        <EmptyState icon="navigate-outline" title="No trips recorded" subtitle="Add a trip or start a GPS shift to build your logbook." />
      ) : (
        trips.map((t) => (
          <Pressable key={t.id} testID={`trip-${t.id}`}
            onPress={() => router.push({ pathname: "/entry" as any, params: { type: "trip", id: t.id } })}>
            <Card style={{ flexDirection: "row", alignItems: "center", marginBottom: 8, paddingVertical: 12 }}>
              <View style={{ flex: 1 }}>
                <AppText variant="bodySemi" style={{ fontVariant: ["tabular-nums"] }}>{t.distance_km} km</AppText>
                <AppText variant="caption" color={colors.dim}>
                  {displayDateShort(t.date)}{t.source === "gps" ? " · GPS" : ""}{t.note ? ` · ${t.note}` : ""}
                </AppText>
              </View>
              <Pressable testID={`trip-toggle-${t.id}`} onPress={() => flip(t)} style={{ marginRight: 6 }}>
                <Badge label={t.type === "personal" ? "Personal" : "Business"}
                  color={t.type === "personal" ? colors.dim : colors.profit}
                  bg={colors.surfaceAlt} />
              </Pressable>
              <IconButton icon="trash-outline" size={18} color={colors.dim} testID={`trip-del-${t.id}`}
                onPress={() => del(t.id)} />
            </Card>
          </Pressable>
        ))
      )}
    </Screen>
  );
}
