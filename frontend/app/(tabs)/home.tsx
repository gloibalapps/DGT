import React, { useCallback, useState } from "react";
import { View, Pressable, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api } from "@/src/api";
import { displayDateShort } from "@/src/date";
import {
  Screen, ScreenHeader, Card, GradientCard, AppText, Money, IconButton,
  Spinner, EmptyState, useToast,
} from "@/src/ui";

const KIND_ICON: Record<string, any> = {
  income: "cash-outline", expense: "receipt-outline", trip: "navigate-outline",
};

export default function Home() {
  const { colors } = useTheme();
  const { version, refresh } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const d = await api.dashboard(today);
      setData(d);
    } catch (e) {
      show("Couldn't load dashboard", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [show]);

  useFocusEffect(useCallback(() => { load(); }, [load, version]));

  const del = async (kind: string, id: string) => {
    if (kind === "income") await api.deleteIncome(id);
    else if (kind === "expense") await api.deleteExpense(id);
    else await api.deleteTrip(id);
    show("Deleted", "success");
    refresh();
    load();
  };

  const edit = (kind: string, id: string) =>
    router.push({ pathname: "/entry" as any, params: { type: kind, id } });

  if (loading) return <Screen><Spinner /></Screen>;

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();

  return (
    <Screen
      header={<ScreenHeader subtitle={greeting} title="Today"
        right={<IconButton icon="person-add-outline" testID="home-scan" onPress={() => router.push({ pathname: "/entry" as any, params: { type: "income" } })} />} />}
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

      {/* Quick add */}
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 18 }}>
        {[
          { k: "income", label: "Income", icon: "add-circle-outline" },
          { k: "trip", label: "Trip", icon: "navigate-outline" },
          { k: "expense", label: "Expense", icon: "receipt-outline" },
        ].map((q) => (
          <Pressable key={q.k} testID={`home-add-${q.k}`}
            onPress={() => router.push({ pathname: "/entry" as any, params: { type: q.k } })}
            style={{ flex: 1 }}>
            <Card style={{ alignItems: "center", paddingVertical: 14 }}>
              <Ionicons name={q.icon as any} size={22} color={colors.accent} />
              <AppText variant="label" style={{ marginTop: 6 }}>{q.label}</AppText>
            </Card>
          </Pressable>
        ))}
      </View>

      <AppText variant="h2" style={{ marginBottom: 10 }}>Recent activity</AppText>
      {data.recent.length === 0 ? (
        <EmptyState icon="car-outline" title="No entries yet" subtitle="Log your first trip, income or expense to get started." />
      ) : (
        data.recent.map((it: any) => (
          <Pressable key={`${it.kind}-${it.id}`} testID={`recent-${it.id}`} onPress={() => edit(it.kind, it.id)}>
            <Card style={{ flexDirection: "row", alignItems: "center", marginBottom: 8, paddingVertical: 12 }}>
              <View style={{
                width: 38, height: 38, borderRadius: 999, backgroundColor: colors.surfaceAlt,
                alignItems: "center", justifyContent: "center", marginRight: 12,
              }}>
                <Ionicons name={KIND_ICON[it.kind]} size={18} color={colors.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText variant="bodyMed">{it.title}</AppText>
                <AppText variant="caption" color={colors.dim}>{it.subtitle} · {displayDateShort(it.date)}</AppText>
              </View>
              {it.amount !== null ? (
                <Money value={it.amount} symbol={data.symbol} size={18} signed style={{ marginRight: 6 }} />
              ) : null}
              <IconButton icon="trash-outline" size={18} color={colors.dim} testID={`recent-del-${it.id}`}
                onPress={() => del(it.kind, it.id)} />
            </Card>
          </Pressable>
        ))
      )}
    </Screen>
  );
}
