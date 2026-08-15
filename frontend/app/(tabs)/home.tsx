import React, { useCallback, useState } from "react";
import { View, Pressable, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme, FONT } from "@/src/theme";
import { useStore } from "@/src/store";
import { api } from "@/src/api";
import {
  Screen, ScreenHeader, Card, GradientCard, AppText, Money, Spinner, useToast,
} from "@/src/ui";

function Bars({ weeks, symbol }: { weeks: any[]; symbol: string }) {
  const { colors } = useTheme();
  const H = 92;
  const max = Math.max(1, ...weeks.map((w) => Math.max(Math.abs(w.profit), w.expenses)));
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", height: H + 34, marginTop: 8 }}>
      {weeks.map((w, i) => {
        const ph = Math.max(2, (Math.abs(w.profit) / max) * H);
        const eh = Math.max(2, (w.expenses / max) * H);
        return (
          <View key={i} style={{ flex: 1, alignItems: "center" }}>
            <View style={{ height: H, flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
              <View style={{ width: 12, height: ph, borderRadius: 3, backgroundColor: w.profit >= 0 ? colors.profit : colors.loss }} />
              <View style={{ width: 12, height: eh, borderRadius: 3, backgroundColor: colors.loss, opacity: 0.55 }} />
            </View>
            <AppText variant="caption" color={colors.dim} style={{ marginTop: 6 }}>{w.label}</AppText>
          </View>
        );
      })}
    </View>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 12, alignItems: "center" }}>
      <AppText style={{ fontFamily: FONT.display, fontSize: 22, color: colors.text, fontVariant: ["tabular-nums"] }}>{value}</AppText>
      <AppText variant="caption" color={colors.dim} style={{ marginTop: 2 }}>{label}</AppText>
    </View>
  );
}

export default function Home() {
  const { colors } = useTheme();
  const { profile, version } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [perf, setPerf] = useState<any>(null);
  const [tm, setTm] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const [d, p, m] = await Promise.all([api.dashboard(today), api.performance(today), api.taxMileage(today)]);
      setData(d);
      setPerf(p);
      setTm(m);
    } catch {
      show("Couldn't load dashboard", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [show]);

  useFocusEffect(useCallback(() => { load(); }, [load, version]));

  if (loading) return <Screen><Spinner /></Screen>;

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();
  const firstName = (profile?.driver_name || "").trim().split(" ")[0];

  return (
    <Screen
      header={<ScreenHeader subtitle={greeting} title={firstName || "Today"} />}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      {!data?.tax_setup_complete && (
        <Pressable testID="home-tax-nudge" onPress={() => router.push("/tax-setup" as any)} style={{ marginBottom: 14 }}>
          <Card style={{ flexDirection: "row", alignItems: "center", borderColor: colors.warm }}>
            <Ionicons name="alert-circle" size={22} color={colors.warm} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <AppText variant="bodySemi">Finish your tax setup</AppText>
              <AppText variant="caption" color={colors.dim}>Add your registration details so your reports lodge cleanly.</AppText>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.dim} />
          </Card>
        </Pressable>
      )}

      {/* Hero */}
      <GradientCard style={{ marginBottom: 14 }}>
        <AppText variant="label" color={colors.onGradient} style={{ opacity: 0.8 }}>NET EARNINGS TODAY</AppText>
        <View style={{ marginTop: 6 }}>
          <Money value={data.net_today} symbol={data.symbol} size={52}
            color={data.net_today >= 0 ? "#FFFFFF" : "#FFD5D5"} />
        </View>
        <View style={{ flexDirection: "row", marginTop: 14, gap: 24 }}>
          <View>
            <AppText variant="caption" color={colors.onGradient} style={{ opacity: 0.7 }}>Income</AppText>
            <Money value={data.income_today} symbol={data.symbol} size={20} color="#CFE8FF" />
          </View>
          <View>
            <AppText variant="caption" color={colors.onGradient} style={{ opacity: 0.7 }}>Expenses</AppText>
            <Money value={data.expense_today} symbol={data.symbol} size={20} color="#CFE8FF" />
          </View>
        </View>
      </GradientCard>

      {/* Secondary row */}
      <View style={{ flexDirection: "row", gap: 12, marginBottom: 14 }}>
        <Card style={{ flex: 1 }}>
          <Ionicons name="navigate" size={20} color={colors.accent} />
          <AppText variant="displaySemi" style={{ fontSize: 28, marginTop: 6, fontVariant: ["tabular-nums"] }}>
            {data.business_distance_today}
          </AppText>
          <AppText variant="caption" color={colors.dim}>km business today</AppText>
        </Card>
        <Card style={{ flex: 1 }}>
          <Ionicons name="repeat" size={20} color={data.recurring.enabled ? colors.warm : colors.dim} />
          {data.recurring.enabled ? (
            <>
              <Money value={data.recurring.owed_this_quarter} symbol={data.symbol} size={22} style={{ marginTop: 6 }} />
              <AppText variant="caption" color={colors.dim}>owed this quarter</AppText>
            </>
          ) : (
            <>
              <AppText variant="bodySemi" style={{ marginTop: 6 }}>Not set</AppText>
              <AppText variant="caption" color={colors.dim}>recurring payment</AppText>
            </>
          )}
        </Card>
      </View>

      {/* Tax Mileage pillar — vehicle deduction estimate */}
      {tm?.method_comparison ? (
        <Pressable testID="home-mileage-pillar" onPress={() => router.push("/trips" as any)} style={{ marginBottom: 14 }}>
          <Card style={{ borderColor: colors.accent }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Ionicons name="car-sport" size={18} color={colors.accent} style={{ marginRight: 6 }} />
                <AppText variant="label" color={colors.dim}>TAX MILEAGE · FY {tm.method_comparison.fy_label}</AppText>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.dim} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}>
              <View>
                <AppText variant="caption" color={colors.dim}>Estimated vehicle deduction</AppText>
                <Money
                  value={tm.method_comparison.recommend === "logbook"
                    ? tm.method_comparison.logbook.deduction
                    : tm.method_comparison.cents_per_km.deduction}
                  symbol={data.symbol} size={34} color={colors.profit} />
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <Ionicons name="trophy" size={13} color={colors.warm} style={{ marginRight: 4 }} />
                  <AppText variant="caption" color={colors.text}>{tm.method_comparison.recommend_label}</AppText>
                </View>
                <AppText variant="caption" color={colors.dim} style={{ marginTop: 4 }}>
                  {tm.financial_year.business_pct}% business · {tm.financial_year.business_km} km
                </AppText>
              </View>
            </View>
          </Card>
        </Pressable>
      ) : null}

      {/* Performance — last 4 weeks */}
      {perf && (
        <Card style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <AppText variant="h2">Performance</AppText>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: colors.profit, marginRight: 4 }} />
                <AppText variant="caption" color={colors.dim}>Profit</AppText>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: colors.loss, opacity: 0.55, marginRight: 4 }} />
                <AppText variant="caption" color={colors.dim}>Expenses</AppText>
              </View>
            </View>
          </View>
          <AppText variant="caption" color={colors.dim}>Last 4 weeks</AppText>

          <Bars weeks={perf.weeks} symbol={perf.symbol} />

          <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
            <Kpi label="$/km" value={perf.per_km != null ? `${perf.symbol}${perf.per_km}` : "—"} />
            <Kpi label="hours" value={perf.total_hours ? String(perf.total_hours) : "—"} />
            <Kpi label="$/hr" value={perf.per_hour != null ? `${perf.symbol}${perf.per_hour}` : "—"} />
          </View>
          {(perf.per_hour == null) && (
            <AppText variant="caption" color={colors.dim} style={{ marginTop: 10 }}>
              Track a GPS shift or add trip time to see $/hr and hours worked.
            </AppText>
          )}
        </Card>
      )}
    </Screen>
  );
}
