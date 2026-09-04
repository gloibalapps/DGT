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
  PrimaryButton, SecondaryButton, IconButton, Badge, EmptyState, useToast, fmtMoney,
} from "@/src/ui";

const CAT_META: Record<string, { label: string; icon: any }> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, { label: c.label, icon: c.icon }]),
);
const TREAT_LABEL: Record<string, string> = Object.fromEntries(
  TAX_TREATMENTS.map((t) => [t.key, t.label]),
);

type Period = "today" | "week" | "month" | "year";
const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "This FY" },
];

interface Row { kind: "income" | "expense"; id: string; date: string; amount: number; title: string; subtitle: string; icon: any; treatment: string }

function periodRange(period: Period, country: string) {
  const now = new Date();
  const iso = (d: Date) => d.toLocaleDateString("en-CA");
  if (period === "today") { const t = iso(now); return { start: t, end: t }; }
  if (period === "week") {
    const diff = (now.getDay() + 6) % 7;
    const mon = new Date(now); mon.setDate(now.getDate() - diff);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { start: iso(mon), end: iso(sun) };
  }
  if (period === "month") {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { start: iso(s), end: iso(e) };
  }
  if (country === "US") return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` };
  const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return { start: `${y}-07-01`, end: `${y + 1}-06-30` };
}

/** Small stat tile used across Performance. */
function Stat({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexBasis: "31%", flexGrow: 1, backgroundColor: highlight ? colors.accent + "22" : colors.surfaceAlt,
      borderRadius: 12, padding: 12, borderWidth: highlight ? 1 : 0, borderColor: colors.accent }}>
      <AppText style={{ fontFamily: FONT.display, fontSize: 20, color: highlight ? colors.accent : colors.text, fontVariant: ["tabular-nums"] }}
        numberOfLines={1} adjustsFontSizeToFit>{value}</AppText>
      <AppText variant="caption" color={colors.dim} style={{ marginTop: 2 }}>{label}</AppText>
      {sub ? <AppText variant="caption" color={colors.dim} style={{ fontSize: 10 }}>{sub}</AppText> : null}
    </View>
  );
}

/** Money Now / Reports-style label + value row. */
function LineRow({ label, value, symbol, color, strong }:
  { label: string; value: number; symbol: string; color?: string; strong?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}>
      <AppText variant={strong ? "bodySemi" : "bodyMed"} color={colors.onGradient}
        style={strong ? undefined : { opacity: 0.8 }}>{label}</AppText>
      <Money value={value} symbol={symbol} size={strong ? 18 : 16} color={color} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} />
    </View>
  );
}

/** Collapsible "harmonica" card — closed by default, expands inline for review. */
function Accordion({ title, summary, open, onToggle, children, borderColor, testID }: {
  title: string; summary?: React.ReactNode; open: boolean; onToggle: () => void;
  children: React.ReactNode; borderColor?: string; testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Card style={{ marginBottom: 12, borderColor: borderColor || colors.border }}>
      <Pressable testID={testID} onPress={onToggle} hitSlop={6}
        style={{ flexDirection: "row", alignItems: "center" }}>
        <AppText variant="h2" style={{ flex: 1 }}>{title}</AppText>
        {!open && summary ? <View style={{ marginRight: 10, alignItems: "flex-end" }}>{summary}</View> : null}
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={20} color={colors.dim} />
      </Pressable>
      {open ? <View style={{ marginTop: 12 }}>{children}</View> : null}
    </Card>
  );
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
  const range = useMemo(() => periodRange(period, country), [period, country]);

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

  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();
  const firstName = (profile?.driver_name || "").trim().split(" ")[0];

  const mn = data.money_now;
  const perf = data.performance;
  const tp = data.tax_position;
  const ded = data.deductions;
  const periodLabel = PERIODS.find((p) => p.key === period)?.label || "";

  const takeStr = fmtMoney(mn.take_home, symbol);
  const takeSize = takeStr.length > 13 ? 30 : takeStr.length > 11 ? 36 : takeStr.length > 9 ? 42 : 48;
  const kept = mn.keep_rate;

  return (
    <Screen
      header={<ScreenHeader subtitle={firstName ? `${greeting}, ${firstName}` : greeting} title="Money" />}
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(period); }} />}
    >
      {/* Period tabs */}
      <View style={{ flexDirection: "row", backgroundColor: colors.surfaceAlt, borderRadius: 999, padding: 3, marginBottom: 14 }}>
        {PERIODS.map((p) => {
          const active = p.key === period;
          return (
            <Pressable key={p.key} testID={`money-period-${p.key}`} onPress={() => setPeriod(p.key)}
              style={{ flex: 1, paddingVertical: 8, borderRadius: 999, alignItems: "center",
                backgroundColor: active ? colors.accent : "transparent" }}>
              <AppText variant="caption" style={{ fontWeight: "700" }} color={active ? colors.bg : colors.dim}>{p.label}</AppText>
            </Pressable>
          );
        })}
      </View>

      {!profile?.legal_name && (
        <Pressable testID="home-tax-nudge" onPress={() => router.push("/tax-setup" as any)} style={{ marginBottom: 14 }}>
          <Card style={{ flexDirection: "row", alignItems: "center", borderColor: colors.warm }}>
            <Ionicons name="alert-circle" size={22} color={colors.warm} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <AppText variant="bodySemi">Finish your tax setup</AppText>
              <AppText variant="caption" color={colors.dim}>Add your registration details so your tax estimates are accurate.</AppText>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.dim} />
          </Card>
        </Pressable>
      )}

      {/* ============ MONEY NOW (headline — always visible) ============ */}
      <GradientCard style={{ marginBottom: 12 }}>
        <AppText variant="label" color={colors.onGradient} style={{ opacity: 0.85 }}>
          YOUR REAL EARNINGS · {periodLabel.toUpperCase()}
        </AppText>
        <View style={{ marginTop: 6 }}>
          <Money value={mn.take_home} symbol={symbol} size={takeSize} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.4}
            color={mn.take_home >= 0 ? "#FFFFFF" : "#FF7A7A"} />
        </View>
        <AppText variant="caption" color={colors.onGradient} style={{ opacity: 0.75, marginTop: 2 }}>
          After work expenses • after estimated tax
        </AppText>

        {kept != null ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12,
            backgroundColor: "rgba(255,255,255,0.16)", borderRadius: 12, padding: 12 }}>
            <View style={{ alignItems: "center", marginRight: 14 }}>
              <AppText style={{ fontFamily: FONT.display, fontSize: 30, color: "#2BD47D" }}>{kept}%</AppText>
              <AppText variant="caption" color={colors.onGradient} style={{ opacity: 0.8 }}>KEEP RATE</AppText>
            </View>
            <AppText variant="bodyMed" color={colors.onGradient} style={{ flex: 1, opacity: 0.95 }}>
              You keep about {symbol}{Math.round(kept)} of every {symbol}100 you earn.
            </AppText>
          </View>
        ) : null}

        <View style={{ height: 1, backgroundColor: "rgba(255,255,255,0.18)", marginVertical: 12 }} />
        <LineRow label="Gross earnings" value={mn.gross} symbol={symbol} color="#FFFFFF" />
        <LineRow label="Work expenses" value={-mn.expenses} symbol={symbol} color="#FF7A7A" />
        <LineRow label="Estimated tax" value={-mn.estimated_tax} symbol={symbol} color="#FF7A7A" />
      </GradientCard>

      {/* Quick actions */}
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
        <PrimaryButton testID="ledger-add-income" label="Add income" icon="add" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "income" } })} />
        <PrimaryButton testID="expense-add" label="Add expense" icon="remove" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "expense" } })} />
      </View>
      <View style={{ flexDirection: "row", gap: 10, marginBottom: 14 }}>
        <SecondaryButton testID="expense-scan" label="Scan receipt" icon="camera-outline" style={{ flex: 1 }}
          onPress={() => router.push("/scan-receipt" as any)} />
        <SecondaryButton testID="hours-add" label="Log hours" icon="time-outline" style={{ flex: 1 }}
          onPress={() => router.push({ pathname: "/entry" as any, params: { type: "shift" } })} />
      </View>

      {/* ============ PERFORMANCE ============ */}
      <Accordion testID="detail-performance" title="Performance" open={openKey === "performance"} onToggle={() => toggle("performance")}
        summary={<AppText variant="bodySemi" color={colors.accent}>{perf.real_per_hour != null ? `${symbol}${perf.real_per_hour}/hr` : "—"}</AppText>}>
        <AppText variant="caption" color={colors.dim} style={{ marginTop: -4, marginBottom: 8 }}>
          What your driving is really worth · {periodLabel.toLowerCase()}
        </AppText>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Stat label="real / hour" highlight value={perf.real_per_hour != null ? `${symbol}${perf.real_per_hour}` : "—"} />
          <Stat label="gross / hour" value={perf.gross_per_hour != null ? `${symbol}${perf.gross_per_hour}` : "—"} />
          <Stat label="real / active hr" highlight value={perf.real_active_per_hour != null ? `${symbol}${perf.real_active_per_hour}` : "—"} />
          <Stat label="utilisation" value={perf.utilisation != null ? `${perf.utilisation}%` : "—"} />
          <Stat label={`${unit} driven`} value={perf.km ? String(perf.km) : "—"} />
          <Stat label={`earned / ${unit}`} value={perf.per_km != null ? `${symbol}${perf.per_km}` : "—"} />
          <Stat label={`cost / ${unit}`} value={perf.cost_per_km != null ? `${symbol}${perf.cost_per_km}` : "—"} />
          <Stat label={`profit / ${unit}`} value={perf.profit_per_km != null ? `${symbol}${perf.profit_per_km}` : "—"} />
        </View>
        {perf.by_platform && perf.by_platform.some((p: any) => p.active_hours > 0) ? (
          <View style={{ marginTop: 12 }}>
            <AppText variant="label" color={colors.dim} style={{ marginBottom: 6 }}>BY APP · $/ACTIVE HOUR</AppText>
            {perf.by_platform.filter((p: any) => p.active_hours > 0 || p.income > 0).map((p: any) => (
              <View key={p.platform} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.border }}>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySemi">{p.platform}</AppText>
                  <AppText variant="caption" color={colors.dim}>
                    {p.active_hours > 0 ? `${p.active_hours}h active` : "no active hours"} · {symbol}{p.income} earned
                  </AppText>
                </View>
                {p.per_active_hour != null ? <AppText variant="bodySemi" color={colors.profit}>{symbol}{p.per_active_hour}/hr</AppText> : null}
              </View>
            ))}
          </View>
        ) : null}
        {perf.hours === 0 ? (
          <AppText variant="caption" color={colors.dim} style={{ marginTop: 10 }}>
            Tap “Log hours” above to record your online time and unlock your real {symbol}/hour.
          </AppText>
        ) : null}
        {data.trend_pct != null ? (
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
            <Ionicons name={data.trend_pct >= 0 ? "trending-up" : "trending-down"} size={16}
              color={data.trend_pct >= 0 ? colors.profit : colors.loss} style={{ marginRight: 6 }} />
            <AppText variant="caption" color={colors.dim}>
              Real earnings {Math.abs(data.trend_pct)}% {data.trend_pct >= 0 ? "higher" : "lower"} than last {period === "year" ? "FY" : period}
            </AppText>
          </View>
        ) : null}
      </Accordion>

      {/* Where your money went */}
      {data.where.length > 0 ? (() => {
        const maxAmt = Math.max(mn.take_home, ...data.where.map((w: any) => w.amount));
        return (
          <Accordion testID="detail-where" title="Where your money went" open={openKey === "where"} onToggle={() => toggle("where")}
            summary={<AppText variant="bodySemi" color={colors.profit}>kept {fmtMoney(mn.take_home, symbol)}</AppText>}>
            <AppText variant="caption" color={colors.dim} style={{ marginTop: -4, marginBottom: 12 }}>
              You earned {fmtMoney(mn.gross, symbol)} {periodLabel.toLowerCase()}
            </AppText>
            {data.where.map((w: any) => (
              <View key={w.label} style={{ marginBottom: 10 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                  <AppText variant="bodyMed" color={colors.dim}>{w.label}</AppText>
                  <Money value={w.amount} symbol={symbol} size={15} color={colors.loss} />
                </View>
                <View style={{ height: 6, borderRadius: 999, backgroundColor: colors.surfaceAlt, overflow: "hidden" }}>
                  <View style={{ height: 6, borderRadius: 999, backgroundColor: colors.loss, opacity: 0.7,
                    width: `${Math.max(2, (w.amount / maxAmt) * 100)}%` }} />
                </View>
              </View>
            ))}
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 8 }} />
            <View style={{ marginBottom: 4 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                <AppText variant="bodySemi" color={colors.profit}>Money you kept</AppText>
                <Money value={mn.take_home} symbol={symbol} size={18} color={colors.profit} />
              </View>
              <View style={{ height: 8, borderRadius: 999, backgroundColor: colors.surfaceAlt, overflow: "hidden" }}>
                <View style={{ height: 8, borderRadius: 999, backgroundColor: colors.profit,
                  width: `${Math.max(2, (Math.max(0, mn.take_home) / maxAmt) * 100)}%` }} />
              </View>
            </View>
          </Accordion>
        );
      })() : null}

      {/* ============ TAX & INTELLIGENCE ============ */}
      <AppText variant="label" color={colors.dim} style={{ marginBottom: 10, marginLeft: 2 }}>TAX & INSIGHTS</AppText>

      {/* Tax position */}
      <Accordion testID="detail-tax" title="Tax position" open={openKey === "tax"} onToggle={() => toggle("tax")}
        borderColor={tp.status === "behind" ? colors.loss : colors.profit}
        summary={<AppText variant="bodySemi" color={tp.status === "behind" ? colors.loss : colors.profit}>
          {tp.status === "behind" ? "Behind" : "Ahead"} {fmtMoney(Math.abs(tp.position), symbol)}
        </AppText>}>
        <AppText variant="caption" color={colors.dim} style={{ marginTop: -4, marginBottom: 6 }}>Year to date · {tp.tax_year_label}</AppText>
        <LineRowLight label="Estimated tax owed" value={tp.owed_ytd} symbol={symbol} />
        <LineRowLight label="You've set aside" value={tp.set_aside} symbol={symbol} />
        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: 10, height: 10, borderRadius: 5, marginRight: 8,
            backgroundColor: tp.status === "behind" ? colors.loss : colors.profit }} />
          <AppText variant="bodySemi" color={tp.status === "behind" ? colors.loss : colors.profit}>
            {tp.status === "behind" ? "Behind" : "Ahead"} by {fmtMoney(Math.abs(tp.position), symbol)}
          </AppText>
        </View>
        <AppText variant="caption" color={colors.dim} style={{ marginTop: 8, lineHeight: 16 }}>
          Set aside about {tp.recommend_rate}% of your profit as you earn. Estimate only — not tax advice.
        </AppText>
        <PrimaryButton testID="tax-update-setaside" label="Update tax set aside" icon="wallet-outline"
          style={{ marginTop: 12 }} onPress={() => router.push("/tax-saved" as any)} />
      </Accordion>

      {/* Deductions tracked */}
      <Accordion testID="detail-deductions" title="Deductions tracked" open={openKey === "deductions"} onToggle={() => toggle("deductions")}
        summary={<AppText variant="bodySemi" color={colors.accent}>{fmtMoney(ded.total, symbol)}</AppText>}>
        <AppText variant="caption" color={colors.dim} style={{ marginTop: -4 }}>Year to date · {ded.tax_year_label}</AppText>
        <Money value={ded.total} symbol={symbol} size={34} color={colors.accent} style={{ marginTop: 6 }} />
        {ded.breakdown.map((b: any) => (
          <LineRowLight key={b.label} label={b.label} value={b.amount} symbol={symbol} />
        ))}
        {ded.estimated_tax_impact > 0 ? (
          <AppText variant="caption" color={colors.dim} style={{ marginTop: 8, lineHeight: 16 }}>
            Estimated tax impact ≈ {fmtMoney(ded.estimated_tax_impact, symbol)} — an estimate of tax these deductions may save, not a guarantee.
          </AppText>
        ) : null}
      </Accordion>

      {/* Driving insights (now the single home for best/worst analysis) */}
      <Pressable testID="money-insights" onPress={() => router.push("/insights" as any)} style={{ marginBottom: 14 }}>
        <Card style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
            alignItems: "center", justifyContent: "center", marginRight: 12 }}>
            <Ionicons name="analytics-outline" size={20} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="bodySemi">Driving insights</AppText>
            <AppText variant="caption" color={colors.dim}>Best & worst days, best platform, top times & weekly trend</AppText>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.dim} />
        </Card>
      </Pressable>

      {/* History (collapsible) */}
      <Pressable testID="ledger-history-toggle" onPress={() => setHistoryOpen((o) => !o)} hitSlop={8}
        style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
        <AppText variant="h2">History</AppText>
        {rows.length > 0 ? (
          <AppText variant="caption" color={colors.dim} style={{ marginLeft: 8 }}>
            {rows.length} {rows.length > 1 ? "entries" : "entry"} · {periodLabel.toLowerCase()}
          </AppText>
        ) : null}
        <Ionicons name={historyOpen ? "chevron-up" : "chevron-down"} size={20} color={colors.dim} style={{ marginLeft: 6 }} />
      </Pressable>
      {historyOpen ? (
        rows.length === 0 ? (
          <EmptyState icon="swap-vertical-outline" title="Nothing here yet"
            subtitle={`No income or expenses for ${periodLabel.toLowerCase()}. Add one above or change the period.`} />
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

function LineRowLight({ label, value, symbol }: { label: string; value: number; symbol: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 5 }}>
      <AppText variant="bodyMed" color={colors.dim}>{label}</AppText>
      <Money value={value} symbol={symbol} size={16} />
    </View>
  );
}
