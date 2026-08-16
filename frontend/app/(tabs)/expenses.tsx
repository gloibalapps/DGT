import React, { useCallback, useMemo, useState } from "react";
import { View, Pressable, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, ExpenseT, IncomeT } from "@/src/api";
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

interface Row {
  kind: "income" | "expense";
  id: string; date: string; amount: number; title: string;
  subtitle: string; icon: any; treatment: string;
}

export default function Ledger() {
  const { colors } = useTheme();
  const { version, refresh } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const [expenses, setExpenses] = useState<ExpenseT[]>([]);
  const [income, setIncome] = useState<IncomeT[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ex, inc] = await Promise.all([api.listExpenses(), api.listIncome()]);
      setExpenses(ex);
      setIncome(inc);
    } catch {
      show("Couldn't load ledger", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [show]);

  useFocusEffect(useCallback(() => { load(); }, [load, version]));

  const totals = useMemo(() => {
    const inc = income.reduce((s, i) => s + i.amount, 0);
    const exp = expenses.reduce((s, e) => s + e.amount, 0);
    const cat: Record<string, number> = { fuel: 0, tolls: 0, vehicle: 0, phone: 0, other: 0 };
    for (const e of expenses) cat[e.category] = (cat[e.category] || 0) + e.amount;
    return {
      inc: Math.round(inc * 100) / 100,
      exp: Math.round(exp * 100) / 100,
      net: Math.round((inc - exp) * 100) / 100,
      cat,
    };
  }, [income, expenses]);

  const rows = useMemo<Row[]>(() => {
    const r: Row[] = [];
    for (const i of income) r.push({
      kind: "income", id: i.id, date: String(i.date).slice(0, 10), amount: i.amount,
      title: i.platform || "Income", subtitle: "Income", icon: "cash-outline", treatment: i.tax_treatment,
    });
    for (const e of expenses) r.push({
      kind: "expense", id: e.id, date: String(e.date).slice(0, 10), amount: -e.amount,
      title: e.merchant || CAT_META[e.category]?.label, subtitle: CAT_META[e.category]?.label,
      icon: CAT_META[e.category]?.icon, treatment: e.tax_treatment,
    });
    r.sort((a, b) => (a.date < b.date ? 1 : -1));
    return r;
  }, [income, expenses]);

  const del = async (row: Row) => {
    try {
      if (row.kind === "income") await api.deleteIncome(row.id);
      else await api.deleteExpense(row.id);
      show("Deleted", "success");
      load();
      refresh();
    } catch {
      show("Couldn't delete — try again", "error");
    }
  };

  if (loading) return <Screen><Spinner /></Screen>;

  return (
    <Screen
      header={<ScreenHeader subtitle="Money in & out" title="Ledger" />}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      {/* Net summary */}
      <Card style={{ marginBottom: 14 }}>
        <AppText variant="label" color={colors.dim} style={{ marginBottom: 4 }}>NET (ALL TIME)</AppText>
        <Money value={totals.net} symbol="$" size={38} color={totals.net >= 0 ? colors.profit : colors.loss} />
        <View style={{ flexDirection: "row", marginTop: 12, gap: 24 }}>
          <View>
            <AppText variant="caption" color={colors.dim}>Income</AppText>
            <Money value={totals.inc} symbol="$" size={18} color={colors.profit} />
          </View>
          <View>
            <AppText variant="caption" color={colors.dim}>Expenses</AppText>
            <Money value={totals.exp} symbol="$" size={18} color={colors.loss} />
          </View>
        </View>
      </Card>

      {/* Expense category breakdown — only categories with spend */}
      {CATEGORIES.some((c) => (totals.cat[c.key] || 0) > 0) ? (
        <Card style={{ marginBottom: 14 }}>
          <AppText variant="label" color={colors.dim} style={{ marginBottom: 12 }}>EXPENSES BY CATEGORY</AppText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {CATEGORIES.filter((c) => (totals.cat[c.key] || 0) > 0).map((c) => (
              <View key={c.key} style={{
                flexBasis: "48%", flexGrow: 1, backgroundColor: colors.surfaceAlt, borderRadius: 12,
                padding: 12, flexDirection: "row", alignItems: "center",
              }}>
                <Ionicons name={c.icon as any} size={18} color={colors.accent} style={{ marginRight: 8 }} />
                <View style={{ flex: 1 }}>
                  <AppText variant="caption" color={colors.dim}>{c.label}</AppText>
                  <Money value={Math.round((totals.cat[c.key] || 0) * 100) / 100} symbol="$" size={16} />
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      {/* Actions — add income or expense, or scan */}
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
        <PrimaryButton testID="ledger-add-income" label="Add income" icon="add" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "income" } })} />
        <PrimaryButton testID="expense-add" label="Add expense" icon="remove" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "expense" } })} />
      </View>
      <SecondaryButton testID="expense-scan" label="Scan receipt" icon="camera-outline" style={{ marginBottom: 18 }}
        onPress={() => router.push("/scan-receipt" as any)} />

      {/* History (tap to expand) */}
      <Pressable testID="ledger-history-toggle" onPress={() => setHistoryOpen((o) => !o)} hitSlop={8}
        style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
        <AppText variant="h2">History</AppText>
        {rows.length > 0 ? (
          <AppText variant="caption" color={colors.dim} style={{ marginLeft: 8 }}>
            {rows.length} {rows.length > 1 ? "entries" : "entry"}
          </AppText>
        ) : null}
        <Ionicons name={historyOpen ? "chevron-up" : "chevron-down"} size={20} color={colors.dim} style={{ marginLeft: 6 }} />
      </Pressable>
      {historyOpen ? (
        rows.length === 0 ? (
          <EmptyState icon="swap-vertical-outline" title="Nothing logged yet" subtitle="Add income or an expense, or scan a receipt to get started." />
        ) : (
          rows.map((row) => (
            <Pressable key={`${row.kind}-${row.id}`} testID={`ledger-${row.id}`}
              onPress={() => router.push({ pathname: "/entry" as any, params: { type: row.kind, id: row.id } })}>
              <Card style={{ flexDirection: "row", alignItems: "center", marginBottom: 8, paddingVertical: 12 }}>
                <View style={{
                  width: 38, height: 38, borderRadius: 999, backgroundColor: colors.surfaceAlt,
                  alignItems: "center", justifyContent: "center", marginRight: 12,
                }}>
                  <Ionicons name={row.icon} size={18} color={row.kind === "income" ? colors.profit : colors.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodyMed">{row.title}</AppText>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 }}>
                    <AppText variant="caption" color={colors.dim}>{row.subtitle} · {displayDateShort(row.date)}</AppText>
                    <Badge label={TREAT_LABEL[row.treatment] || row.treatment}
                      color={row.treatment === "inclusive" ? colors.accent : colors.dim} />
                  </View>
                </View>
                <Money value={row.amount} symbol="$" size={18} signed style={{ marginRight: 6 }} />
                <IconButton icon="trash-outline" size={18} color={colors.dim} testID={`ledger-del-${row.id}`}
                  onPress={() => del(row)} />
              </Card>
            </Pressable>
          ))
        )
      ) : null}
    </Screen>
  );
}
