import React, { useCallback, useMemo, useState } from "react";
import { View, Pressable, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme, FONT } from "@/src/theme";
import { useStore } from "@/src/store";
import { api } from "@/src/api";
import { displayDateShort } from "@/src/date";
import { CATEGORIES, TAX_TREATMENTS } from "@/src/config";
import {
  Screen, ScreenHeader, Card, GradientCard, AppText, Money, Spinner,
  PrimaryButton, SecondaryButton, IconButton, Badge, EmptyState, useToast,
} from "@/src/ui";

const CAT_META: Record<string, { label: string; icon: any }> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, { label: c.label, icon: c.icon }]),
);
const TREAT_LABEL: Record<string, string> = Object.fromEntries(
  TAX_TREATMENTS.map((t) => [t.key, t.label]),
);

type Period = "today" | "fy" | "all";
interface Row { kind: "income" | "expense"; id: string; date: string; amount: number; title: string; subtitle: string; icon: any; treatment: string }

function tripBizKm(t: any): number {
  if (t.type === "personal") return 0;
  if (t.type === "mixed") return (t.distance_km || 0) * (t.business_pct || 0) / 100;
  return t.distance_km || 0;
}

function fyRange(country: string, ref: Date) {
  if (country === "US") {
    const y = ref.getFullYear();
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: `FY ${y}` };
  }
  const y = ref.getMonth() >= 6 ? ref.getFullYear() : ref.getFullYear() - 1; // AU: Jul–Jun
  return { start: `${y}-07-01`, end: `${y + 1}-06-30`, label: `FY ${String(y).slice(2)}–${String(y + 1).slice(2)}` };
}

function Bars({ weeks, symbol }: { weeks: any[]; symbol: string }) {
  const { colors } = useTheme();
  const H = 60;
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

const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "fy", label: "This FY" },
  { key: "all", label: "All-time" },
];

export default function Money_() {
  const { colors } = useTheme();
  const { profile, version, refresh } = useStore();
  const { show } = useToast();
  const router = useRouter();

  const [dash, setDash] = useState<any>(null);
  const [perf, setPerf] = useState<any>(null);
  const [income, setIncome] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [trips, setTrips] = useState<any[]>([]);
  const [shifts, setShifts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<Period>("today");
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const [d, p, inc, ex, tr, sh] = await Promise.all([
        api.dashboard(today), api.performance(today),
        api.listIncome(), api.listExpenses(), api.listTrips(), api.listShifts(),
      ]);
      setDash(d); setPerf(p); setIncome(inc); setExpenses(ex); setTrips(tr); setShifts(sh);
    } catch {
      show("Couldn't load your money summary", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [show]);

  useFocusEffect(useCallback(() => { load(); }, [load, version]));

  const country = profile?.country || "AU";
  const symbol = dash?.symbol || "$";
  const unit = dash?.distance_unit || (country === "US" ? "mi" : "km");

  const range = useMemo(() => {
    const now = new Date();
    const today = now.toLocaleDateString("en-CA");
    if (period === "today") return { start: today, end: today, label: "Today" };
    if (period === "fy") return fyRange(country, now);
    return { start: "0000-01-01", end: "9999-12-31", label: "All-time" };
  }, [period, country]);

  const inRange = useCallback((dateStr: string) => {
    const d = String(dateStr).slice(0, 10);
    return d >= range.start && d <= range.end;
  }, [range]);

  const summary = useMemo(() => {
    const incF = income.filter((i) => inRange(i.date));
    const expF = expenses.filter((e) => inRange(e.date));
    const trF = trips.filter((t) => inRange(t.date));
    const shF = shifts.filter((s) => inRange(s.date));
    const inc = incF.reduce((s, i) => s + (i.amount || 0), 0);
    const exp = expF.reduce((s, e) => s + (e.amount || 0), 0);
    const bizKm = trF.reduce((s, t) => s + tripBizKm(t), 0);
    const hrs = shF.reduce((s, x) => s + (x.hours || 0), 0);
    const cat: Record<string, number> = {};
    for (const e of expF) cat[e.category] = (cat[e.category] || 0) + (e.amount || 0);
    return {
      inc: Math.round(inc * 100) / 100,
      exp: Math.round(exp * 100) / 100,
      net: Math.round((inc - exp) * 100) / 100,
      bizKm: Math.round(bizKm * 10) / 10,
      hours: Math.round(hrs * 10) / 10,
      cat,
    };
  }, [income, expenses, trips, shifts, inRange]);

  const shiftRows = useMemo(
    () => shifts.filter((s) => inRange(s.date)).sort((a, b) => (a.date < b.date ? 1 : -1)),
    [shifts, inRange],
  );

  const rows = useMemo<Row[]>(() => {
    const r: Row[] = [];
    for (const i of income) {
      if (!inRange(i.date)) continue;
      r.push({ kind: "income", id: i.id, date: String(i.date).slice(0, 10), amount: i.amount,
        title: i.platform || "Income", subtitle: "Income", icon: "cash-outline", treatment: i.tax_treatment });
    }
    for (const e of expenses) {
      if (!inRange(e.date)) continue;
      r.push({ kind: "expense", id: e.id, date: String(e.date).slice(0, 10), amount: -e.amount,
        title: e.merchant || CAT_META[e.category]?.label, subtitle: CAT_META[e.category]?.label,
        icon: CAT_META[e.category]?.icon, treatment: e.tax_treatment });
    }
    r.sort((a, b) => (a.date < b.date ? 1 : -1));
    return r;
  }, [income, expenses, inRange]);

  const del = async (row: Row) => {
    try {
      if (row.kind === "income") await api.deleteIncome(row.id);
      else await api.deleteExpense(row.id);
      show("Deleted", "success");
      load(); refresh();
    } catch {
      show("Couldn't delete — try again", "error");
    }
  };

  const delShift = async (id: string) => {
    try {
      await api.deleteShift(id);
      show("Deleted", "success");
      load(); refresh();
    } catch {
      show("Couldn't delete — try again", "error");
    }
  };

  if (loading) return <Screen><Spinner /></Screen>;

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();
  const firstName = (profile?.driver_name || "").trim().split(" ")[0];

  // Base font size for the hero net figure, scaled down for longer amounts so
  // it looks right on web too (native also uses adjustsFontSizeToFit).
  const netLen = `${symbol}${Math.round(Math.abs(summary.net)).toLocaleString()}`.length;
  const netSize = netLen > 11 ? 32 : netLen > 9 ? 38 : netLen > 7 ? 44 : 48;

  return (
    <Screen
      header={<ScreenHeader subtitle={firstName ? `${greeting}, ${firstName}` : greeting} title="Money" />}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      {!dash?.tax_setup_complete && (
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

      {/* Hero with period toggle */}
      <GradientCard style={{ marginBottom: 14 }}>
        {/* Segmented period control */}
        <View style={{ flexDirection: "row", backgroundColor: "rgba(255,255,255,0.16)", borderRadius: 999, padding: 3, marginBottom: 14 }}>
          {PERIODS.map((p) => {
            const active = p.key === period;
            return (
              <Pressable key={p.key} testID={`money-period-${p.key}`} onPress={() => setPeriod(p.key)}
                style={{ flex: 1, paddingVertical: 7, borderRadius: 999, alignItems: "center",
                  backgroundColor: active ? "#FFFFFF" : "transparent" }}>
                <AppText variant="caption" style={{ fontWeight: "700" }}
                  color={active ? colors.accent : colors.onGradient}>{p.label}</AppText>
              </Pressable>
            );
          })}
        </View>

        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <AppText variant="label" color={colors.onGradient} style={{ opacity: 0.8 }}>NET EARNINGS · {range.label.toUpperCase()}</AppText>
            <View style={{ marginTop: 6 }}>
              <Money value={summary.net} symbol={symbol} size={netSize} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}
                color={summary.net >= 0 ? "#FFFFFF" : "#FF7A7A"} />
            </View>
          </View>
          <View style={{ gap: 12, alignItems: "flex-end" }}>
            <View style={{ alignItems: "flex-end" }}>
              <AppText variant="caption" color={colors.onGradient} style={{ opacity: 0.7 }}>Income</AppText>
              <Money value={summary.inc} symbol={symbol} size={20} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} color="#2BD47D" />
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <AppText variant="caption" color={colors.onGradient} style={{ opacity: 0.7 }}>Expenses</AppText>
              <Money value={summary.exp} symbol={symbol} size={20} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} color="#FF7A7A" />
            </View>
          </View>
        </View>
      </GradientCard>

      {/* Quick add */}
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
        <PrimaryButton testID="ledger-add-income" label="Add income" icon="add" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "income" } })} />
        <PrimaryButton testID="expense-add" label="Add expense" icon="remove" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "expense" } })} />
      </View>
      <SecondaryButton testID="expense-scan" label="Scan receipt" icon="camera-outline" style={{ marginBottom: 14 }}
        onPress={() => router.push("/scan-receipt" as any)} />

      {/* Category breakdown for the period */}
      {CATEGORIES.some((c) => (summary.cat[c.key] || 0) > 0) ? (
        <Card style={{ marginBottom: 14 }}>
          <AppText variant="label" color={colors.dim} style={{ marginBottom: 12 }}>EXPENSES BY CATEGORY · {range.label.toUpperCase()}</AppText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {CATEGORIES.filter((c) => (summary.cat[c.key] || 0) > 0).map((c) => (
              <View key={c.key} style={{ flexBasis: "48%", flexGrow: 1, backgroundColor: colors.surfaceAlt, borderRadius: 12,
                padding: 12, flexDirection: "row", alignItems: "center" }}>
                <Ionicons name={c.icon as any} size={18} color={colors.accent} style={{ marginRight: 8 }} />
                <View style={{ flex: 1 }}>
                  <AppText variant="caption" color={colors.dim}>{c.label}</AppText>
                  <Money value={Math.round((summary.cat[c.key] || 0) * 100) / 100} symbol={symbol} size={16} />
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      {/* Performance — last 4 weeks */}
      {perf && (
        <Card style={{ marginBottom: 14 }}>
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
            <Kpi label={`${symbol}/${unit}`} value={perf.per_km != null ? `${perf.symbol}${perf.per_km}` : "—"} />
            <Kpi label="hours" value={perf.total_hours ? String(perf.total_hours) : "—"} />
            <Kpi label={`${symbol}/hr`} value={perf.per_hour != null ? `${perf.symbol}${perf.per_hour}` : "—"} />
          </View>
        </Card>
      )}

      {/* Online hours (this period) */}
      <Card style={{ marginBottom: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: summary.hours > 0 ? 12 : 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name="time-outline" size={18} color={colors.accent} style={{ marginRight: 8 }} />
            <AppText variant="h2">Online hours</AppText>
          </View>
          <Pressable testID="hours-add" hitSlop={8} style={{ flexDirection: "row", alignItems: "center" }}
            onPress={() => router.push({ pathname: "/entry" as any, params: { type: "shift" } })}>
            <Ionicons name="add-circle" size={18} color={colors.accent} />
            <AppText variant="bodySemi" color={colors.accent} style={{ marginLeft: 4 }}>Log hours</AppText>
          </Pressable>
        </View>
        {summary.hours > 0 ? (
          <>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
              <Kpi label={`hours · ${range.label.toLowerCase()}`} value={String(summary.hours)} />
              <Kpi label={`${symbol}/hr online`} value={`${symbol}${Math.round((summary.inc / summary.hours) * 100) / 100}`} />
            </View>
            {shiftRows.map((s) => (
              <Pressable key={s.id} testID={`shift-${s.id}`}
                onPress={() => router.push({ pathname: "/entry" as any, params: { type: "shift", id: s.id } })}
                style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10,
                  borderTopWidth: 1, borderTopColor: colors.border }}>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodyMed">{s.hours} hrs</AppText>
                  <AppText variant="caption" color={colors.dim}>
                    {displayDateShort(String(s.date).slice(0, 10))}{s.platform ? ` · ${s.platform}` : ""}
                  </AppText>
                </View>
                <IconButton icon="trash-outline" size={18} color={colors.dim} testID={`shift-del-${s.id}`}
                  onPress={() => delShift(s.id)} />
              </Pressable>
            ))}
          </>
        ) : (
          <AppText variant="caption" color={colors.dim}>
            Log the hours you were online each shift to see your true earnings-per-hour — counting waiting time, not just driving.
          </AppText>
        )}
      </Card>

      {/* Driving insights */}
      <Pressable testID="money-insights" onPress={() => router.push("/insights" as any)} style={{ marginBottom: 14 }}>
        <Card style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
            alignItems: "center", justifyContent: "center", marginRight: 12 }}>
            <Ionicons name="analytics-outline" size={20} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="bodySemi">Driving insights</AppText>
            <AppText variant="caption" color={colors.dim}>Weekly hours vs earnings & your best days to drive</AppText>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.dim} />
        </Card>
      </Pressable>

      {/* Business km (period) + recurring owed */}
      <View style={{ flexDirection: "row", gap: 12, marginBottom: 14 }}>
        <Card style={{ flex: 1 }}>
          <Ionicons name="navigate" size={20} color={colors.accent} />
          <AppText variant="displaySemi" style={{ fontSize: 28, marginTop: 6, fontVariant: ["tabular-nums"] }}>
            {summary.bizKm}
          </AppText>
          <AppText variant="caption" color={colors.dim}>{unit} business · {range.label.toLowerCase()}</AppText>
        </Card>
        <Card style={{ flex: 1 }}>
          <Ionicons name="repeat" size={20} color={dash?.recurring?.enabled ? colors.warm : colors.dim} />
          {dash?.recurring?.enabled ? (
            <>
              <Money value={dash.recurring.owed_this_quarter} symbol={symbol} size={22} style={{ marginTop: 6 }} />
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

      {/* History (tap to expand) — filtered to the selected period */}
      <Pressable testID="ledger-history-toggle" onPress={() => setHistoryOpen((o) => !o)} hitSlop={8}
        style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
        <AppText variant="h2">History</AppText>
        {rows.length > 0 ? (
          <AppText variant="caption" color={colors.dim} style={{ marginLeft: 8 }}>
            {rows.length} {rows.length > 1 ? "entries" : "entry"} · {range.label.toLowerCase()}
          </AppText>
        ) : null}
        <Ionicons name={historyOpen ? "chevron-up" : "chevron-down"} size={20} color={colors.dim} style={{ marginLeft: 6 }} />
      </Pressable>
      {historyOpen ? (
        rows.length === 0 ? (
          <EmptyState icon="swap-vertical-outline" title="Nothing here yet"
            subtitle={`No income or expenses for ${range.label.toLowerCase()}. Add one above or change the period.`} />
        ) : (
          rows.map((row) => (
            <Pressable key={`${row.kind}-${row.id}`} testID={`ledger-${row.id}`}
              onPress={() => router.push({ pathname: "/entry" as any, params: { type: row.kind, id: row.id } })}>
              <Card style={{ flexDirection: "row", alignItems: "center", marginBottom: 8, paddingVertical: 12 }}>
                <View style={{ width: 38, height: 38, borderRadius: 999, backgroundColor: colors.surfaceAlt,
                  alignItems: "center", justifyContent: "center", marginRight: 12 }}>
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
                <Money value={row.amount} symbol={symbol} size={18} signed style={{ marginRight: 6 }} />
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
