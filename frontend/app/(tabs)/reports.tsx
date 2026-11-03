import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, ScrollView, Pressable, Modal } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useStore } from "@/src/store";
import { ueEnabled } from "@/src/ueParse";

import { useTheme } from "@/src/theme";
import { api, IncomeT, ExpenseT } from "@/src/api";
import { CATEGORIES } from "@/src/config";
import { isoToAU } from "@/src/date";
import { RANGE_OPTIONS, rangeFor, type RangeKey } from "@/src/reportRange";
import {
  Screen, ScreenHeader, AppText, Money, Spinner, DateField, useToast, fmtMoney,
  Select, UnderlineTabs, HeroCard, ListCard, ListRow,
} from "@/src/ui";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "income", label: "Income" },
  { key: "expenses", label: "Expenses" },
  { key: "tax", label: "Tax" },
];

const CAT_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

export default function Reports() {
  const { colors } = useTheme();
  const { profile } = useStore();
  const router = useRouter();
  const { show } = useToast();
  const [rangeKey, setRangeKey] = useState<RangeKey>("fy_to_date");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [provider, setProvider] = useState("all");
  const [tab, setTab] = useState("overview");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [income, setIncome] = useState<IncomeT[]>([]);
  const [expenses, setExpenses] = useState<ExpenseT[]>([]);
  const [drill, setDrill] = useState<{ title: string; rows: { label: string; sub?: string; amount: number }[] } | null>(null);

  const { start, end } = useMemo(() => rangeFor(rangeKey, customStart, customEnd), [rangeKey, customStart, customEnd]);
  const providers = useMemo(() => (provider === "all" ? [] : [provider]), [provider]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, inc, exp] = await Promise.all([
        api.reportAnalytics(start, end, providers),
        api.listIncome(),
        api.listExpenses(),
      ]);
      setData(a); setIncome(inc); setExpenses(exp);
    } catch { show("Couldn't load reports", "error"); }
    finally { setLoading(false); }
  }, [start, end, providers]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const sym = "$";
  const money = (n: number) => fmtMoney(n, sym);
  const inRange = (d: string) => d >= start && d <= end;
  const provOk = (p?: string | null) => providers.length === 0 || providers.includes(p || "Other");

  // ---- drill-downs (reconcile exactly with the shown totals) ----
  const drillIncome = () => {
    const rows = income.filter((i) => inRange(i.date) && provOk(i.platform))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((i) => ({ label: i.platform || "Other", sub: isoToAU(i.date), amount: i.amount }));
    setDrill({ title: "Income transactions", rows });
  };
  const drillExpenseCat = (cat: string) => {
    const rows = expenses.filter((e) => inRange(e.date) && e.category === cat)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((e) => ({ label: e.merchant || CAT_LABEL[e.category] || e.category, sub: isoToAU(e.date), amount: e.amount }));
    setDrill({ title: `${CAT_LABEL[cat] || cat} transactions`, rows });
  };

  const providerOptions = [
    { key: "all", label: "All providers" },
    ...((data?.all_providers || []) as string[]).map((p) => ({ key: p, label: p })),
  ];
  const signColor = (n: number) => (n < 0 ? colors.loss : colors.text);

  return (
    <Screen>
      <ScreenHeader title="Reports" />
      <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: 20, marginBottom: 8 }}>
        <View style={{ flex: 1 }}>
          <Select testID="range-select" title="Period" value={rangeKey} onChange={(k) => setRangeKey(k as RangeKey)}
            options={RANGE_OPTIONS} />
        </View>
        <View style={{ flex: 1 }}>
          <Select testID="provider-select" title="Provider" value={provider} onChange={setProvider}
            options={providerOptions} />
        </View>
      </View>
      {rangeKey === "custom" ? (
        <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: 20, marginBottom: 8 }}>
          <View style={{ flex: 1 }}><DateField testID="range-custom-start" value={customStart} onChange={setCustomStart} maxToday /></View>
          <View style={{ flex: 1 }}><DateField testID="range-custom-end" value={customEnd} onChange={setCustomEnd} maxToday /></View>
        </View>
      ) : null}
      <UnderlineTabs options={TABS} value={tab} onChange={setTab} testIDPrefix="rtab" />

      {loading || !data ? <Spinner /> : (
        <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 12, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          <AppText testID="report-range" variant="caption" color={colors.dim} style={{ marginBottom: 16 }}>
            {isoToAU(data.start)} – {isoToAU(data.end)}
          </AppText>

          {tab === "overview" ? (
            <>
              {ueEnabled(profile) ? (
                <ListCard>
                  <ListRow testID="reports-ue-guarantee" icon="fast-food-outline" label="Uber Eats Guarantee"
                    sub="Engaged-time cycle, top-up owed & export" onPress={() => router.push("/guarantee" as any)} />
                </ListCard>
              ) : null}
              <HeroCard testID="hero-net-profit" label="Net profit (est.)" value={data.tax.taxable_profit} symbol={sym}
                valueColor={signColor(data.tax.taxable_profit)}>
                <AppText variant="caption" color={colors.dim} style={{ fontVariant: ["tabular-nums"] }}>
                  Income {money(data.tax.gross_income)} · Deductions {money(data.tax.total_deductions)}
                </AppText>
                {data.expenses.recurring_gross > 0 ? (
                  <AppText variant="caption" color={colors.dim} style={{ marginTop: 2 }}>
                    Includes vehicle rental/lease {money(data.expenses.recurring_gross)}
                  </AppText>
                ) : null}
              </HeroCard>
              <ListCard label="GST">
                <ListRow label="GST collected" value={money(data.gst.collected)} />
                <ListRow label="GST credits" value={money(data.gst.credits)} />
                <ListRow label={data.gst.net_payable >= 0 ? "Net GST payable" : "Net GST refund"}
                  value={money(Math.abs(data.gst.net_payable))} strong />
              </ListCard>
              <ListCard>
                <ListRow testID="row-income-tax" label="Income tax (est.)" value={money(data.tax.income_tax_est)}
                  strong onPress={() => setTab("tax")} />
              </ListCard>
              <ListCard label="Kilometres & performance">
                <ListRow label="Total km" value={numOr(data.km.total, "km")} />
                <ListRow label="Business km" value={numOr(data.km.business, "km")} />
                <ListRow label="Trips" value={String(data.km.trips)} />
                <ListRow label="Earnings / km" value={perOr(data.metrics.earnings_per_km, sym)} />
                <ListRow label="Cost / km" value={perOr(data.metrics.cost_per_km, sym)} />
                <ListRow label="Earnings / hour" value={perOr(data.metrics.earnings_per_hour, sym)} />
              </ListCard>
            </>
          ) : null}

          {tab === "income" ? (
            <>
              <HeroCard label="Total income" value={data.income.gross} symbol={sym}>
                <AppText variant="caption" color={colors.dim}>{data.income.count} transactions</AppText>
              </HeroCard>
              <ListCard>
                <ListRow testID="row-income-all" label="View all transactions" onPress={drillIncome} />
              </ListCard>
              <ListCard label="By provider">
                {data.providers.length === 0 ? <ListRow label="Not enough data for this period" /> :
                  data.providers.map((r: any) => (
                    <ListRow key={r.provider} label={r.provider} value={money(r.gross)}
                      sub={`${r.pct_of_income}% of income · ${r.hours != null ? `${r.hours}h · ${perOr(r.per_hour, sym)}/h` : "hours not logged"}`} />
                  ))}
              </ListCard>
              <Helper c={colors} text="Base / tips / bonuses aren't recorded separately, so income is shown as a provider total." />
            </>
          ) : null}

          {tab === "expenses" ? (
            <>
              <HeroCard label="Total expenses" value={data.expenses.total + (data.expenses.recurring_gross || 0)} symbol={sym}>
                <AppText variant="caption" color={colors.dim} style={{ fontVariant: ["tabular-nums"] }}>
                  Entered {money(data.expenses.total)}{data.expenses.recurring_gross > 0 ? ` · Vehicle rental/lease ${money(data.expenses.recurring_gross)}` : ""}
                </AppText>
              </HeroCard>
              <ListCard label="By category">
                {Object.keys(data.expenses.by_category).length === 0 && !(data.expenses.recurring_gross > 0)
                  ? <ListRow label="Not enough data for this period" /> : null}
                {Object.entries(data.expenses.by_category).map(([cat, v]: any) => (
                  <ListRow key={cat} testID={`exp-cat-${cat}`} label={CAT_LABEL[cat] || cat} value={money(v)}
                    sub={`GST ${money(data.expenses.gst_by_category[cat] || 0)}`} onPress={() => drillExpenseCat(cat)} />
                ))}
                {data.expenses.recurring_gross > 0 ? (
                  <ListRow label="Rental / lease / finance" value={money(data.expenses.recurring_gross)} sub="Auto-calculated from your vehicles" />
                ) : null}
              </ListCard>
            </>
          ) : null}

          {tab === "tax" ? (
            <>
              <HeroCard label="Estimated income tax" value={data.tax.income_tax_est} symbol={sym}>
                <AppText variant="caption" color={colors.dim}>Business use {data.tax.business_use_pct}%</AppText>
              </HeroCard>
              <ListCard label="Taxable profit">
                <ListRow label="Gross business income" value={money(data.tax.gross_income)} />
                <ListRow label="Vehicle running (apportioned)" value={`– ${money(data.tax.deduction_breakdown.apportioned_running)}`} />
                <ListRow label="Other expenses (full claim)" value={`– ${money(data.tax.deduction_breakdown.full_claim)}`} />
                <ListRow label="Taxable profit (est.)" value={money(data.tax.taxable_profit)} valueColor={signColor(data.tax.taxable_profit)} strong />
              </ListCard>
              <ListCard label="GST (BAS estimate)">
                <ListRow label="GST-inclusive income" value={money(data.gst.inclusive_income)} />
                <ListRow label="GST collected (1A)" value={money(data.gst.collected)} />
                <ListRow label="GST credits (1B)" value={money(data.gst.credits)} />
                <ListRow label="Net GST" value={money(data.gst.net_payable)} strong />
              </ListCard>
              <ListCard label="Profitability">
                <ListRow label="Operating profit" value={money(data.profitability.operating_profit)} valueColor={signColor(data.profitability.operating_profit)} />
                <ListRow label="Net profit margin" value={data.metrics.net_profit_margin == null ? "Not enough data" : `${data.metrics.net_profit_margin}%`} />
                <ListRow label="Net $ / hour" value={perOr(data.metrics.net_per_hour, sym)} />
                <ListRow label="Net $ / business km" value={perOr(data.metrics.net_per_business_km, sym)} />
                <ListRow label="Private km" value={numOr(data.km.private, "km")} />
              </ListCard>
              <Helper c={colors} text="Estimate from records entered in the app — not a lodged return or BAS." />
            </>
          ) : null}
        </ScrollView>
      )}

      {/* Drill-down sheet */}
      <Modal visible={!!drill} transparent animationType="slide" onRequestClose={() => setDrill(null)}>
        <Pressable onPress={() => setDrill(null)} style={{ flex: 1, backgroundColor: "rgba(15,23,42,0.4)", justifyContent: "flex-end" }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "80%" }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20 }}>
              <AppText variant="h2">{drill?.title}</AppText>
              <Pressable testID="drill-close" onPress={() => setDrill(null)} hitSlop={10} style={{ minHeight: 44, justifyContent: "center" }}>
                <AppText variant="bodySemi" color={colors.accent}>Done</AppText>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}>
              {drill?.rows.length === 0 ? <AppText variant="body" color={colors.dim}>Not enough data for this period.</AppText> : drill?.rows.map((r, i) => (
                <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 48, paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.divider }}>
                  <View style={{ flex: 1 }}>
                    <AppText variant="body" color={colors.rowLabel} numberOfLines={1}>{r.label}</AppText>
                    {r.sub ? <AppText variant="caption" color={colors.dim}>{r.sub}</AppText> : null}
                  </View>
                  <Money value={r.amount} symbol={sym} size={15} />
                </View>
              ))}
              {drill && drill.rows.length > 0 ? (
                <View style={{ flexDirection: "row", justifyContent: "space-between", minHeight: 48, alignItems: "center", borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4 }}>
                  <AppText variant="bodySemi">Total</AppText>
                  <Money value={drill.rows.reduce((s, r) => s + r.amount, 0)} symbol={sym} size={15} />
                </View>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

function Helper({ c, text }: { c: any; text: string }) {
  return <AppText variant="caption" color={c.dim} style={{ marginTop: -4, marginBottom: 16, lineHeight: 18, paddingHorizontal: 4 }}>{text}</AppText>;
}

function numOr(n: number, unit: string) { return n > 0 ? `${n} ${unit}` : "Not enough data"; }
function perOr(n: number | null, sym: string) { return n == null ? "Not enough data" : fmtMoney(n, sym); }
