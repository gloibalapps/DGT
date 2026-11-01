import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Pressable, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { displayDateShort } from "@/src/date";
import { CATEGORIES, TAX_TREATMENTS } from "@/src/config";
import {
  Screen, ScreenHeader, AppText, Spinner, Select, HeroCard, ListCard, ListRow,
  PrimaryButton, SecondaryButton, IconButton, useToast, fmtMoney,
} from "@/src/ui";

const CAT_META: Record<string, { label: string; icon: any }> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, { label: c.label, icon: c.icon }]),
);
const TREAT_LABEL: Record<string, string> = Object.fromEntries(
  TAX_TREATMENTS.map((t) => [t.key, t.label]),
);

type Period = "day" | "week" | "quarter" | "year";
const PERIODS: { key: Period; label: string }[] = [
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "quarter", label: "Quarterly" },
  { key: "year", label: "Financial Year" },
];

interface Row { kind: "income" | "expense"; id: string; date: string; amount: number; title: string; subtitle: string; icon: any; treatment: string }

function periodRange(period: Period, country: string, weekStart = 0) {
  const now = new Date();
  const iso = (d: Date) => d.toLocaleDateString("en-CA");
  if (period === "day") { const t = iso(now); return { start: t, end: t }; }
  if (period === "week") {
    const jsStart = (weekStart + 1) % 7;                 // week_start 0=Mon → JS 1; 6=Sun → JS 0
    const diff = (now.getDay() - jsStart + 7) % 7;
    const s = new Date(now); s.setDate(now.getDate() - diff);
    const e = new Date(s); e.setDate(s.getDate() + 6);
    return { start: iso(s), end: iso(e) };
  }
  if (period === "quarter") {
    const qm = Math.floor(now.getMonth() / 3) * 3;       // calendar-aligned (AU BAS & US share these)
    const s = new Date(now.getFullYear(), qm, 1);
    const e = new Date(now.getFullYear(), qm + 3, 0);
    return { start: iso(s), end: iso(e) };
  }
  if (country === "US") return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` };
  const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return { start: `${y}-07-01`, end: `${y + 1}-06-30` };
}

export default function Money_() {
  const { colors } = useTheme();
  const { profile, version, refresh } = useStore();
  const { show } = useToast();
  const router = useRouter();

  const [data, setData] = useState<any>(null);
  const [income, setIncome] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<Period>("week");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = (k: string) => setOpenKey((cur) => (cur === k ? null : k));

  const [showGuide, setShowGuide] = useState(false);
  useEffect(() => {
    storage.getItem<string>("gigtax.guide_seen", "").then((v) => { if (!v) setShowGuide(true); });
  }, []);
  const dismissGuide = () => { setShowGuide(false); void storage.setItem("gigtax.guide_seen", "1"); };
  const openGuide = () => { dismissGuide(); router.push("/manual" as any); };

  const country = profile?.country || "AU";

  const load = useCallback(async (p: Period) => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const [m, inc, ex] = await Promise.all([
        api.money(p, today), api.listIncome(), api.listExpenses(),
      ]);
      setData(m); setIncome(inc); setExpenses(ex);
    } catch {
      show("Couldn't load your money summary", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [show]);

  useFocusEffect(useCallback(() => { load(period); }, [load, period, version]));

  const symbol = data?.symbol || "$";
  const unit = data?.distance_unit || (country === "US" ? "mi" : "km");
  const range = useMemo(() => periodRange(period, country, Number(profile?.week_start ?? 0)), [period, country, profile?.week_start]);

  const inRange = useCallback((dateStr: string) => {
    const d = String(dateStr).slice(0, 10);
    return d >= range.start && d <= range.end;
  }, [range]);

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
      load(period); refresh();
    } catch {
      show("Couldn't delete — try again", "error");
    }
  };

  if (loading || !data) return <Screen><Spinner /></Screen>;


  const mn = data.money_now;
  const perf = data.performance;
  const tp = data.tax_position;
  const ded = data.deductions;
  const periodLabel = PERIODS.find((p) => p.key === period)?.label || "";

  const kept = mn.keep_rate;

  const perHr = (v: number | null | undefined) => (v != null ? `${symbol}${v}` : "—");
  const behind = tp.status === "behind";

  return (
    <Screen
      header={<ScreenHeader title="Money" />}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(period); }} />}
    >
      {/* Period */}
      <Select testID="money-period" title="Period" value={period} onChange={(k) => setPeriod(k as Period)}
        options={PERIODS} style={{ marginBottom: 16 }} />

      {showGuide && (
        <ListCard>
          <ListRow testID="home-guide-banner" icon="book-outline" label="New here? Read the quick guide"
            sub="A 2-minute tour of logging, mileage & your tax figures" onPress={openGuide}
            right={
              <Pressable testID="home-guide-dismiss" onPress={dismissGuide} hitSlop={10}
                style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="close" size={18} color={colors.dim} />
              </Pressable>
            } />
        </ListCard>
      )}

      {!profile?.legal_name && (
        <ListCard>
          <ListRow testID="home-tax-nudge" icon="alert-circle-outline" iconColor={colors.warm} label="Finish your tax setup"
            sub="Add your registration details so your tax estimates are accurate." onPress={() => router.push("/tax-setup" as any)} />
        </ListCard>
      )}

      {/* Hero — real earnings */}
      <HeroCard testID="money-hero" label={`Your real earnings · ${periodLabel}`} value={mn.take_home} symbol={symbol}
        valueColor={mn.take_home < 0 ? colors.loss : colors.text}>
        <AppText variant="caption" color={colors.dim}>
          {kept != null && mn.take_home > 0 ? `Keep rate ${kept}% · ` : ""}after work expenses & estimated tax
        </AppText>
      </HeroCard>

      <ListCard>
        <ListRow label="Gross earnings" value={fmtMoney(mn.gross, symbol)} />
        <ListRow label="Work expenses" value={fmtMoney(-mn.expenses, symbol)} />
        <ListRow label="Estimated tax" value={fmtMoney(-mn.estimated_tax, symbol)} />
      </ListCard>

      <View style={{ flexDirection: "row", gap: 12, marginBottom: 16 }}>
        <PrimaryButton testID="ledger-add-income" label="Add income" icon="add" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "income" } })} />
        <SecondaryButton testID="expense-add" label="Add expense" icon="remove" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "expense" } })} />
      </View>

      <ListCard label="Quick actions">
        <ListRow testID="expense-scan" icon="camera-outline" label="Scan receipt" onPress={() => router.push("/scan-receipt" as any)} />
        <ListRow testID="hours-add" icon="time-outline" label="Log hours"
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "shift" } })} />
        <ListRow testID="money-insights" icon="analytics-outline" label="Driving insights"
          sub="Best & worst days, platforms, times & trend" onPress={() => router.push("/insights" as any)} />
      </ListCard>

      {/* Performance — one row, expands inline */}
      <ListCard label="Performance">
        <ExpandRow testID="detail-performance" label="Real earnings per hour" value={perHr(perf.real_per_hour)}
          open={openKey === "performance"} onPress={() => toggle("performance")} />
        {openKey === "performance" ? <ListRow label="Gross / hour" value={perHr(perf.gross_per_hour)} /> : null}
        {openKey === "performance" ? <ListRow label="Real / active hour" value={perHr(perf.real_active_per_hour)} /> : null}
        {openKey === "performance" ? <ListRow label="Utilisation" value={perf.utilisation != null ? `${perf.utilisation}%` : "—"} /> : null}
        {openKey === "performance" ? <ListRow label={`${unit} driven`} value={perf.km ? String(perf.km) : "—"} /> : null}
        {openKey === "performance" ? <ListRow label={`Earned / ${unit}`} value={perHr(perf.per_km)} /> : null}
        {openKey === "performance" ? <ListRow label={`Cost / ${unit}`} value={perHr(perf.cost_per_km)} /> : null}
        {openKey === "performance" ? <ListRow label={`Profit / ${unit}`} value={perHr(perf.profit_per_km)} /> : null}
        {openKey === "performance" && perf.by_platform
          ? perf.by_platform.filter((p: any) => p.active_hours > 0 || p.income > 0).map((p: any) => (
            <ListRow key={p.platform} label={p.platform}
              sub={`${p.active_hours > 0 ? `${p.active_hours}h active` : "no active hours"} · ${symbol}${p.income} earned`}
              value={p.per_active_hour != null ? `${symbol}${p.per_active_hour}/hr` : undefined} />
          )) : null}
        {openKey === "performance" && perf.hours === 0
          ? <ListRow label="Log hours to unlock your real $/hour" sub="Use “Log hours” in Quick actions." /> : null}
        {openKey === "performance" && data.trend_pct != null
          ? <ListRow label={`vs last ${period === "year" ? "FY" : period}`}
              value={`${data.trend_pct >= 0 ? "+" : "−"}${Math.abs(data.trend_pct)}%`}
              valueColor={data.trend_pct >= 0 ? colors.profit : colors.loss} /> : null}
      </ListCard>

      {/* Where your money went */}
      {data.where.length > 0 ? (
        <ListCard label="Where your money went">
          <ExpandRow testID="detail-where" label={`Earned ${periodLabel.toLowerCase()}`} value={fmtMoney(mn.gross, symbol)}
            open={openKey === "where"} onPress={() => toggle("where")} />
          {openKey === "where" ? data.where.map((w: any) => (
            <ListRow key={w.label} label={w.label} value={fmtMoney(-w.amount, symbol)} />
          )) : null}
          {openKey === "where" ? <ListRow label="Money you kept" value={fmtMoney(mn.take_home, symbol)} strong
            valueColor={mn.take_home < 0 ? colors.loss : colors.profit} /> : null}
        </ListCard>
      ) : null}

      {/* Tax & insights */}
      <ListCard label="Tax & insights">
        <ExpandRow testID="detail-tax" label="Tax position"
          value={`${behind ? "Behind" : "Ahead"} ${fmtMoney(Math.abs(tp.position), symbol)}`}
          valueColor={behind ? colors.loss : colors.profit}
          open={openKey === "tax"} onPress={() => toggle("tax")} />
        {openKey === "tax" ? <ListRow label="Estimated tax owed" sub={`Year to date · ${tp.tax_year_label}`} value={fmtMoney(tp.owed_ytd, symbol)} /> : null}
        {openKey === "tax" ? <ListRow label="You've set aside" value={fmtMoney(tp.set_aside, symbol)} /> : null}
        {openKey === "tax" ? <ListRow testID="tax-update-setaside" label="Update tax set aside"
          sub={`Set aside about ${tp.recommend_rate}% of profit. Estimate only — not tax advice.`}
          onPress={() => router.push("/tax-saved" as any)} /> : null}
        <ExpandRow testID="detail-deductions" label="Deductions tracked" value={fmtMoney(ded.total, symbol)}
          open={openKey === "deductions"} onPress={() => toggle("deductions")} />
        {openKey === "deductions" ? ded.breakdown.map((b: any) => (
          <ListRow key={b.label} label={b.label} value={fmtMoney(b.amount, symbol)} />
        )) : null}
        {openKey === "deductions" && ded.estimated_tax_impact > 0
          ? <ListRow label="Estimated tax impact" sub="Estimate of tax these deductions may save" value={`≈ ${fmtMoney(ded.estimated_tax_impact, symbol)}`} /> : null}
      </ListCard>

      {/* History */}
      <ListCard label="History">
        <ExpandRow testID="ledger-history-toggle" label={`${rows.length} ${rows.length === 1 ? "entry" : "entries"} · ${periodLabel.toLowerCase()}`}
          open={historyOpen} onPress={() => setHistoryOpen((o) => !o)} />
        {historyOpen && rows.length === 0
          ? <ListRow label="Nothing here yet" sub={`No income or expenses for ${periodLabel.toLowerCase()}.`} /> : null}
        {historyOpen ? rows.map((row) => (
          <ListRow key={`${row.kind}-${row.id}`} testID={`ledger-${row.id}`} icon={row.icon}
            iconColor={row.kind === "income" ? colors.profit : colors.dim}
            label={row.title} sub={`${displayDateShort(row.date)} · ${TREAT_LABEL[row.treatment] || row.treatment}`}
            value={`${row.amount > 0 ? "+" : ""}${fmtMoney(row.amount, symbol)}`}
            valueColor={row.amount > 0 ? colors.profit : colors.text}
            onPress={() => router.push({ pathname: "/entry" as any, params: { type: row.kind, id: row.id } })}
            right={<IconButton icon="trash-outline" size={18} color={colors.dim} testID={`ledger-del-${row.id}`} onPress={() => del(row)} />} />
        )) : null}
      </ListCard>
    </Screen>
  );
}

/** List row that expands/collapses the rows beneath it. */
function ExpandRow({ label, value, valueColor, open, onPress, testID }:
  { label: string; value?: string; valueColor?: string; open: boolean; onPress: () => void; testID?: string }) {
  return <ListRow testID={testID} label={label} value={value} valueColor={valueColor} strong onPress={onPress}
    trailingIcon={open ? "chevron-up" : "chevron-down"} />;
}
