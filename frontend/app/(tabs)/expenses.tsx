import React, { useCallback, useMemo, useState } from "react";
import { View, Pressable, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, ExpenseT } from "@/src/api";
import { displayDateShort } from "@/src/date";
import { CATEGORIES, TAX_TREATMENTS } from "@/src/config";
import {
  Screen, ScreenHeader, Card, AppText, Money, IconButton, Spinner,
  EmptyState, PrimaryButton, SecondaryButton, Badge, useToast,
} from "@/src/ui";

const CAT_META: Record<string, { label: string; icon: any }> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, { label: c.label, icon: c.icon }]),
);
const TREAT_LABEL: Record<string, string> = Object.fromEntries(
  TAX_TREATMENTS.map((t) => [t.key, t.label]),
);

export default function Expenses() {
  const { colors } = useTheme();
  const { version, refresh } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const [items, setItems] = useState<ExpenseT[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await api.listExpenses());
    } catch {
      show("Couldn't load expenses", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [show]);

  useFocusEffect(useCallback(() => { load(); }, [load, version]));

  const breakdown = useMemo(() => {
    const b: Record<string, number> = { fuel: 0, tolls: 0, vehicle: 0, phone: 0, other: 0 };
    let total = 0;
    for (const e of items) { b[e.category] = (b[e.category] || 0) + e.amount; total += e.amount; }
    return { b, total: Math.round(total * 100) / 100 };
  }, [items]);

  const del = async (id: string) => {
    try {
      await api.deleteExpense(id);
      show("Expense deleted", "success");
      load();
      refresh();
    } catch {
      show("Couldn't delete — try again", "error");
    }
  };

  if (loading) return <Screen><Spinner /></Screen>;

  return (
    <Screen
      header={<ScreenHeader subtitle="Deductions" title="Expenses" />}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      <Card style={{ marginBottom: 14 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
          <AppText variant="label" color={colors.dim}>ALL EXPENSES</AppText>
          <Money value={breakdown.total} symbol="$" size={20} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {CATEGORIES.map((c) => (
            <View key={c.key} style={{
              flexBasis: "48%", flexGrow: 1, backgroundColor: colors.surfaceAlt, borderRadius: 12,
              padding: 12, flexDirection: "row", alignItems: "center",
            }}>
              <Ionicons name={c.icon as any} size={18} color={colors.accent} style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <AppText variant="caption" color={colors.dim}>{c.label}</AppText>
                <Money value={Math.round((breakdown.b[c.key] || 0) * 100) / 100} symbol="$" size={16} />
              </View>
            </View>
          ))}
        </View>
      </Card>

      {/* Equal-weight actions */}
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 18 }}>
        <PrimaryButton testID="expense-add" label="Add" icon="add" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "expense" } })} />
        <SecondaryButton testID="expense-scan" label="Scan receipt" icon="camera-outline" style={{ flex: 1 }}
          onPress={() => router.push("/scan-receipt" as any)} />
      </View>

      <AppText variant="h2" style={{ marginBottom: 10 }}>History</AppText>
      {items.length === 0 ? (
        <EmptyState icon="receipt-outline" title="Add your first expense" subtitle="Log fuel, tolls, servicing and more — or scan a receipt." />
      ) : (
        items.map((e) => (
          <Pressable key={e.id} testID={`expense-${e.id}`}
            onPress={() => router.push({ pathname: "/entry" as any, params: { type: "expense", id: e.id } })}>
            <Card style={{ flexDirection: "row", alignItems: "center", marginBottom: 8, paddingVertical: 12 }}>
              <View style={{
                width: 38, height: 38, borderRadius: 999, backgroundColor: colors.surfaceAlt,
                alignItems: "center", justifyContent: "center", marginRight: 12,
              }}>
                <Ionicons name={CAT_META[e.category]?.icon} size={18} color={colors.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText variant="bodyMed">{e.merchant || CAT_META[e.category]?.label}</AppText>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 }}>
                  <AppText variant="caption" color={colors.dim}>{displayDateShort(e.date)}</AppText>
                  <Badge label={TREAT_LABEL[e.tax_treatment] || e.tax_treatment}
                    color={e.tax_treatment === "inclusive" ? colors.accent : colors.dim} />
                </View>
              </View>
              <Money value={-e.amount} symbol="$" size={18} color={colors.text} style={{ marginRight: 6 }} />
              <IconButton icon="trash-outline" size={18} color={colors.dim} testID={`expense-del-${e.id}`}
                onPress={() => del(e.id)} />
            </Card>
          </Pressable>
        ))
      )}
    </Screen>
  );
}
