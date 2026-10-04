import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, ScrollView, Pressable, Modal } from "react-native";
import { useFocusEffect } from "expo-router";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, IncomeT, ExpenseT } from "@/src/api";
import { CATEGORIES } from "@/src/config";
import { isoToAU } from "@/src/date";
import { RANGE_OPTIONS, rangeFor, type RangeKey } from "@/src/reportRange";
import {
  Screen, ScreenHeader, Card, AppText, Money, Spinner, ChipRow, DateField, useToast, fmtMoney,
} from "@/src/ui";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "income", label: "Income" },
  { key: "expenses", label: "Expenses" },
  { key: "providers", label: "Providers" },
  { key: "profit", label: "Profitability" },
  { key: "gst", label: "GST" },
  { key: "tax", label: "Tax" },
  { key: "km", label: "Kilometres" },
];

const CAT_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

export default function Reports() {
  const { colors } = useTheme();
  const { show } = useToast();
  const [rangeKey, setRangeKey] = useState<RangeKey>("fy_to_date");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [tab, setTab] = useState("overview");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [income, setIncome] = useState<IncomeT[]>([]);
  const [expenses, setExpenses] = useState<ExpenseT[]>([]);
  const [drill, setDrill] = useState<{ title: string; rows: { label: string; sub?: string; amount: number }[] } | null>(null);

  const { start, end } = useMemo(() => rangeFor(rangeKey, customStart, customEnd), [rangeKey, customStart, customEnd]);

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

  const toggleProvider = (p: string) => {
    setProviders((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);
  };

  return (
    <Screen>
      <View style={{ paddingBottom: 8 }}>
        <ScreenHeader subtitle="Analytics & tax figures" title="Reports" />
        {/* Date range */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }} style={{ maxHeight: 44, marginBottom: 8 }}>
          {RANGE_OPTIONS.map((o) => {
            const active = o.key === rangeKey;
            return (
              <Pressable key={o.key} testID={`range-${o.key}`} onPress={() => setRangeKey(o.key)}
                style={{ height: 34, paddingHorizontal: 14, borderRadius: 999, alignItems: "center", justifyContent: "center",
                  backgroundColor: active ? colors.accent : colors.surfaceAlt, borderWidth: 1, borderColor: active ? colors.accent : colors.border }}>
                <AppText variant="bodyMed" color={active ? colors.bg : colors.dim}>{o.label}</AppText>
              </Pressable>
            );
          })}
        </ScrollView>
        {rangeKey === "custom" ? (
          <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 16, marginBottom: 6 }}>
            <View style={{ flex: 1 }}><DateField testID="range-custom-start" value={customStart} onChange={setCustomStart} maxToday /></View>
            <View style={{ flex: 1 }}><DateField testID="range-custom-end" value={customEnd} onChange={setCustomEnd} maxToday /></View>
          </View>
        ) : null}
        {/* Provider multi-select */}
        {data?.all_providers?.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }} style={{ maxHeight: 44 }}>
            <Pressable testID="prov-all" onPress={() => setProviders([])}
              style={chip(colors, providers.length === 0)}>
              <AppText variant="bodyMed" color={providers.length === 0 ? colors.bg : colors.dim}>All providers</AppText>
            </Pressable>
            {data.all_providers.map((p: string) => {
              const on = providers.includes(p);
              return (
                <Pressable key={p} testID={`prov-${p}`} onPress={() => toggleProvider(p)} style={chip(colors, on)}>
                  <AppText variant="bodyMed" color={on ? colors.bg : colors.dim}>{p}</AppText>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
        {/* Sub-tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }} style={{ maxHeight: 44, marginTop: 8 }}>
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <Pressable key={t.key} testID={`rtab-${t.key}`} onPress={() => setTab(t.key)} style={chip(colors, active)}>
                <AppText variant="bodyMed" color={active ? colors.bg : colors.dim}>{t.label}</AppText>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {loading || !data ? <Spinner /> : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
            {isoToAU(data.start)} – {isoToAU(data.end)}
          </AppText>

          {tab === "overview" ? (
            <>
              <Card style={{ marginBottom: 14 }}>
                <AppText variant="label" color={colors.dim}>NET PROFIT (EST.)</AppText>
                <Money value={data.tax.taxable_profit} symbol={sym} size={44} color={data.tax.taxable_profit >= 0 ? colors.profit : colors.loss} />
                <AppText variant="caption" color={colors.dim}>Gross income {money(data.income.gross)} · expenses {money(data.expenses.total)}</AppText>
              </Card>
              <Grid>
                <Stat c={colors} label="Gross income" value={money(data.income.gross)} onPress={drillIncome} />
                <Stat c={colors} label="Total expenses" value={money(data.expenses.total)} />
                <Stat c={colors} label="GST collected" value={money(data.gst.collected)} />
                <Stat c={colors} label="GST credits" value={money(data.gst.credits)} />
                <Stat c={colors} label="Net GST (est.)" value={money(data.gst.net_payable)} />
                <Stat c={colors} label="Income tax (est.)" value={money(data.tax.income_tax_est)} />
                <Stat c={colors} label="Total km" value={numOr(data.km.total, "km")} />
                <Stat c={colors} label="Business km" value={numOr(data.km.business, "km")} />
                <Stat c={colors} label="Cost / km" value={perOr(data.metrics.cost_per_km, sym)} />
                <Stat c={colors} label="Earnings / km" value={perOr(data.metrics.earnings_per_km, sym)} />
                <Stat c={colors} label="Earnings / hour" value={perOr(data.metrics.earnings_per_hour, sym)} />
                <Stat c={colors} label="Trips" value={String(data.km.trips)} />
              </Grid>
            </>
          ) : null}

          {tab === "income" ? (
            <>
              <Card style={{ marginBottom: 14 }}>
                <Pressable onPress={drillIncome}>
                  <AppText variant="label" color={colors.dim}>TOTAL INCOME</AppText>
                  <Money value={data.income.gross} symbol={sym} size={40} />
                  <AppText variant="caption" color={colors.accent}>{data.income.count} transactions · tap to view</AppText>
                </Pressable>
              </Card>
              <SectionTitle c={colors} text="By provider" />
              <Card>
                {Object.keys(data.income.by_provider).length === 0 ? <Empty c={colors} /> :
                  Object.entries(data.income.by_provider).map(([p, v]: any, i) => (
                    <Row key={p} c={colors} first={i === 0} label={p} value={money(v)} />
                  ))}
              </Card>
              <NotEnough c={colors} text="Base / tips / bonuses breakdown isn't recorded in GigTax yet, so income is shown as a single provider total." />
            </>
          ) : null}

          {tab === "expenses" ? (
            <>
              <Card style={{ marginBottom: 14 }}>
                <AppText variant="label" color={colors.dim}>TOTAL EXPENSES</AppText>
                <Money value={data.expenses.total} symbol={sym} size={40} />
                <AppText variant="caption" color={colors.dim}>{data.expenses.count} transactions · tap a category</AppText>
              </Card>
              <Card>
                {Object.keys(data.expenses.by_category).length === 0 ? <Empty c={colors} /> :
                  Object.entries(data.expenses.by_category).map(([cat, v]: any, i) => (
                    <Pressable key={cat} testID={`exp-cat-${cat}`} onPress={() => drillExpenseCat(cat)}>
                      <Row c={colors} first={i === 0} label={CAT_LABEL[cat] || cat}
                        value={money(v)} sub={`GST ${money(data.expenses.gst_by_category[cat] || 0)}`} chevron />
                    </Pressable>
                  ))}
                {data.expenses.recurring_gross > 0 ? (
                  <Row c={colors} first={false} label="Rental / lease / finance" value={money(data.expenses.recurring_gross)} sub="auto-calculated" />
                ) : null}
              </Card>
            </>
          ) : null}

          {tab === "providers" ? (
            <>
              <SectionTitle c={colors} text="Provider performance" />
              {data.providers.length === 0 ? <Card><Empty c={colors} /></Card> : (
                <Card>
                  {data.providers.map((r: any, i: number) => {
                    const pctW = data.income.gross > 0 ? Math.max(4, Math.round((r.gross / data.income.gross) * 100)) : 0;
                    return (
                      <View key={r.provider} style={{ paddingVertical: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.border }}>
                        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                          <AppText variant="bodySemi">{r.provider}</AppText>
                          <Money value={r.gross} symbol={sym} size={18} />
                        </View>
                        <View style={{ height: 6, borderRadius: 999, backgroundColor: colors.surfaceAlt, marginVertical: 6 }}>
                          <View style={{ width: `${pctW}%`, height: 6, borderRadius: 999, backgroundColor: colors.accent }} />
                        </View>
                        <AppText variant="caption" color={colors.dim}>
                          {r.pct_of_income}% of income · {r.hours != null ? `${r.hours}h · ${perOr(r.per_hour, sym)}/h` : "hours not logged"}
                        </AppText>
                      </View>
                    );
                  })}
                </Card>
              )}
              <NotEnough c={colors} text="Per-provider km & expenses aren't tracked (expenses/trips aren't tagged to a platform), so only income & hours are shown." />
            </>
          ) : null}

          {tab === "profit" ? (
            <Card>
              <AppText variant="label" color={colors.dim}>OPERATING PROFIT</AppText>
              <Money value={data.profitability.operating_profit} symbol={sym} size={40}
                color={data.profitability.operating_profit >= 0 ? colors.profit : colors.loss} />
              <View style={{ marginTop: 8 }}>
                <Row c={colors} first label="Net profit margin" value={data.metrics.net_profit_margin == null ? "Not enough data" : `${data.metrics.net_profit_margin}%`} />
                <Row c={colors} first={false} label="Gross $/hour" value={perOr(data.metrics.earnings_per_hour, sym)} />
                <Row c={colors} first={false} label="Net $/hour" value={perOr(data.metrics.net_per_hour, sym)} />
                <Row c={colors} first={false} label="Gross $/km" value={perOr(data.metrics.earnings_per_km, sym)} />
                <Row c={colors} first={false} label="Net $/km" value={perOr(data.metrics.net_per_business_km, sym)} />
                <Row c={colors} first={false} label="Expense $/km" value={perOr(data.metrics.cost_per_km, sym)} />
              </View>
            </Card>
          ) : null}

          {tab === "gst" ? (
            <>
              <Card style={{ marginBottom: 14 }}>
                <AppText variant="label" color={colors.dim}>NET GST (EST.)</AppText>
                <Money value={data.gst.net_payable} symbol={sym} size={40} color={data.gst.net_payable >= 0 ? colors.loss : colors.profit} />
                <AppText variant="caption" color={colors.dim}>{data.gst.net_payable >= 0 ? "Estimated payable" : "Estimated refund"}</AppText>
              </Card>
              <Card>
                <Row c={colors} first label="GST-inclusive income" value={money(data.gst.inclusive_income)} />
                <Row c={colors} first={false} label="GST collected (1A)" value={money(data.gst.collected)} />
                <Row c={colors} first={false} label="GST credits (1B)" value={money(data.gst.credits)} />
                <Row c={colors} first={false} label="Net GST" value={money(data.gst.net_payable)} />
              </Card>
              <NotEnough c={colors} text="Estimate from records entered in GigTax — not a lodged BAS." />
            </>
          ) : null}

          {tab === "tax" ? (
            <>
              <Card style={{ marginBottom: 14 }}>
                <Row c={colors} first label="Gross business income" value={money(data.tax.gross_income)} />
                <Row c={colors} first={false} label="Allowable expenses" value={`– ${money(data.tax.total_deductions)}`} />
                <Row c={colors} first={false} label="Taxable profit (est.)" value={money(data.tax.taxable_profit)} strong />
              </Card>
              <Card>
                <AppText variant="label" color={colors.dim}>ESTIMATED INCOME TAX</AppText>
                <Money value={data.tax.income_tax_est} symbol={sym} size={40} color={colors.loss} />
                <AppText variant="caption" color={colors.dim} style={{ marginTop: 4 }}>
                  Business-use {data.tax.business_use_pct}% · running costs apportioned {money(data.tax.deduction_breakdown.apportioned_running)}, full-claim {money(data.tax.deduction_breakdown.full_claim)}
                </AppText>
              </Card>
              <NotEnough c={colors} text="Estimate only — uses your recorded income & expenses for this period." />
            </>
          ) : null}

          {tab === "km" ? (
            !data.km.has_data ? <Card><Empty c={colors} /></Card> : (
              <>
                <Card style={{ marginBottom: 14 }}>
                  <AppText variant="label" color={colors.dim}>BUSINESS KILOMETRES</AppText>
                  <Money value={data.km.business} symbol="" size={44} />
                  <AppText variant="caption" color={colors.dim}>{data.km.business_use_pct}% business use · {data.km.trips} trips</AppText>
                </Card>
                <Card>
                  <Row c={colors} first label="Total km" value={`${data.km.total} km`} />
                  <Row c={colors} first={false} label="Business km" value={`${data.km.business} km`} />
                  <Row c={colors} first={false} label="Private km" value={`${data.km.private} km`} />
                  <Row c={colors} first={false} label="Income / business km" value={perOr(data.metrics.income_per_business_km, sym)} />
                  <Row c={colors} first={false} label="Expense / business km" value={perOr(data.metrics.expense_per_business_km, sym)} />
                </Card>
              </>
            )
          ) : null}
        </ScrollView>
      )}

      {/* Drill-down modal */}
      <Modal visible={!!drill} transparent animationType="slide" onRequestClose={() => setDrill(null)}>
        <Pressable onPress={() => setDrill(null)} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: "80%", borderWidth: 1, borderColor: colors.border }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16 }}>
              <AppText variant="h2">{drill?.title}</AppText>
              <Pressable testID="drill-close" onPress={() => setDrill(null)} hitSlop={10}>
                <AppText variant="bodySemi" color={colors.accent}>Done</AppText>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}>
              {drill?.rows.length === 0 ? <Empty c={colors} /> : drill?.rows.map((r, i) => (
                <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.border }}>
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodyMed" numberOfLines={1}>{r.label}</AppText>
                    {r.sub ? <AppText variant="caption" color={colors.dim}>{r.sub}</AppText> : null}
                  </View>
                  <Money value={r.amount} symbol={sym} size={16} />
                </View>
              ))}
              {drill && drill.rows.length > 0 ? (
                <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 14, borderTopWidth: 2, borderTopColor: colors.border, marginTop: 4 }}>
                  <AppText variant="bodySemi">Total</AppText>
                  <Money value={drill.rows.reduce((s, r) => s + r.amount, 0)} symbol={sym} size={18} />
                </View>
              ) : null}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

function chip(colors: any, active: boolean) {
  return {
    height: 34, paddingHorizontal: 14, borderRadius: 999, alignItems: "center" as const, justifyContent: "center" as const,
    backgroundColor: active ? colors.accent : colors.surfaceAlt, borderWidth: 1, borderColor: active ? colors.accent : colors.border,
  };
}

function Grid({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>{children}</View>;
}

function Stat({ c, label, value, onPress }: { c: any; label: string; value: string; onPress?: () => void }) {
  const Inner = (
    <Card style={{ flex: 1, minWidth: "45%" }}>
      <AppText variant="caption" color={c.dim}>{label}</AppText>
      <AppText variant="h2" style={{ marginTop: 4 }} numberOfLines={1}>{value}</AppText>
      {onPress ? <AppText variant="caption" color={c.accent} style={{ marginTop: 2 }}>Tap to view</AppText> : null}
    </Card>
  );
  if (onPress) return <Pressable onPress={onPress} style={{ flexBasis: "47%", flexGrow: 1 }}>{Inner}</Pressable>;
  return <View style={{ flexBasis: "47%", flexGrow: 1 }}>{Inner}</View>;
}

function Row({ c, label, value, sub, first, strong, chevron }:
  { c: any; label: string; value: string; sub?: string; first: boolean; strong?: boolean; chevron?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border }}>
      <View style={{ flex: 1 }}>
        <AppText variant={strong ? "bodySemi" : "bodyMed"}>{label}</AppText>
        {sub ? <AppText variant="caption" color={c.dim}>{sub}</AppText> : null}
      </View>
      <AppText variant={strong ? "bodySemi" : "bodyMed"} color={strong ? c.text : c.dim}>{value}</AppText>
      {chevron ? <AppText variant="bodyMed" color={c.accent} style={{ marginLeft: 8 }}>›</AppText> : null}
    </View>
  );
}

function SectionTitle({ c, text }: { c: any; text: string }) {
  return <AppText variant="label" color={c.dim} style={{ marginBottom: 8, marginLeft: 4, marginTop: 4 }}>{text.toUpperCase()}</AppText>;
}

function Empty({ c }: { c: any }) {
  return <AppText variant="bodyMed" color={c.dim} style={{ paddingVertical: 8 }}>Not enough data for this period.</AppText>;
}

function NotEnough({ c, text }: { c: any; text: string }) {
  return <AppText variant="caption" color={c.dim} style={{ marginTop: 10, lineHeight: 16 }}>{text}</AppText>;
}

function numOr(n: number, unit: string) { return n > 0 ? `${n} ${unit}` : "Not enough data"; }
function perOr(n: number | null, sym: string) { return n == null ? "Not enough data" : fmtMoney(n, sym); }
