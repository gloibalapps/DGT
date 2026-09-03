import React, { useCallback, useState } from "react";
import { View, RefreshControl, Pressable } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api } from "@/src/api";
import { PERIODS, ATO_LINK } from "@/src/config";
import {
  Screen, ScreenHeader, Card, AppText, Money, Spinner, ChipRow,
  PrimaryButton, SecondaryButton, useToast, fmtMoney,
} from "@/src/ui";

function Row({ label, value, symbol = "$", strong, color, sub }:
  { label: string; value: number; symbol?: string; strong?: boolean; color?: string; sub?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7 }}>
      <View style={{ flex: 1 }}>
        <AppText variant={strong ? "bodySemi" : "body"} color={strong ? colors.text : colors.dim}>{label}</AppText>
        {sub ? <AppText variant="caption" color={colors.dim}>{sub}</AppText> : null}
      </View>
      <Money value={value} symbol={symbol} size={strong ? 20 : 16} color={color} />
    </View>
  );
}

export default function Reports() {
  const { colors } = useTheme();
  const { version } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const [period, setPeriod] = useState("quarter");
  const [rep, setRep] = useState<any>(null);
  const [tm, setTm] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const [r, m] = await Promise.all([api.report(period, today), api.taxMileage(today)]);
      setRep(r);
      setTm(m);
    } catch {
      show("Couldn't load report", "error");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period, show]);

  useFocusEffect(useCallback(() => { load(); }, [load, version]));

  const exportCsv = async () => {
    const today = new Date().toLocaleDateString("en-CA");
    const url = await api.exportUrl(period, today);
    await WebBrowser.openBrowserAsync(url);
  };

  return (
    <Screen
      header={
        <View>
          <ScreenHeader subtitle="Tax figures" title="Reports" />
          <ChipRow options={PERIODS as any} value={period} onChange={setPeriod} testIDPrefix="period" />
        </View>
      }
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.accent}
        onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      {loading || !rep ? <Spinner /> : (
        <View>
          <AppText variant="label" color={colors.dim} style={{ marginBottom: 12, marginTop: 4 }}>
            {rep.period_label}
          </AppText>

          {rep.registration_warning ? (
            <Card style={{ marginBottom: 14, borderColor: colors.warm, flexDirection: "row" }}>
              <Ionicons name="warning" size={20} color={colors.warm} style={{ marginRight: 10, marginTop: 2 }} />
              <AppText variant="caption" color={colors.text} style={{ flex: 1 }}>{rep.registration_warning}</AppText>
            </Card>
          ) : null}

          {/* Net profit summary */}
          <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
            <AppText variant="label" color={colors.dim} style={{ marginBottom: 4 }}>NET PROFIT</AppText>
            <Money value={rep.net_profit} symbol={rep.symbol} size={44} signed={false}
              color={rep.net_profit >= 0 ? colors.profit : colors.loss} />
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 10 }} />
            <Row label="Total income" value={rep.total_income} symbol={rep.symbol} />
            <Row label="Total deductions" value={-rep.total_deductions} symbol={rep.symbol} />
          </Card>

          {rep.country === "US" ? (
            <>
              {/* Schedule C summary */}
              <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
                <AppText variant="h2" style={{ marginBottom: 2 }}>Schedule C (Form 1040)</AppText>
                <AppText variant="caption" color={colors.dim} style={{ marginBottom: 8 }}>
                  Estimated profit or loss from your gig business.
                </AppText>
                <Row label="Gross receipts (Line 1)" value={rep.schedule_c.gross_receipts} symbol={rep.symbol} />
                <Row label="Car & truck expenses (Line 9)" value={-rep.schedule_c.car_and_truck} symbol={rep.symbol}
                  sub={`${rep.schedule_c.car_method_label} · ${rep.business_use_pct}% business use`} />
                <Row label="Other business expenses" value={-rep.schedule_c.other_expenses} symbol={rep.symbol} />
                <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
                <Row label="Net profit (Line 31)" value={rep.schedule_c.net_profit} symbol={rep.symbol} strong
                  color={rep.schedule_c.net_profit >= 0 ? colors.profit : colors.loss} />
              </Card>

              {/* Self-employment tax */}
              <Card style={{ marginBottom: 14, borderColor: colors.warm }}>
                <AppText variant="h2" style={{ marginBottom: 2 }}>Set aside for taxes</AppText>
                <AppText variant="caption" color={colors.dim} style={{ marginBottom: 8 }}>
                  Self-employment tax (~15.3%) on your net earnings.
                </AppText>
                <Row label="Net SE earnings (92.35%)" value={rep.se_tax.net_earnings} symbol={rep.symbol} />
                <Row label="Self-employment tax" value={rep.se_tax.amount} symbol={rep.symbol} strong color={colors.warm} />
                {rep.se_tax.state_has_tax ? (
                  <Row label={`State income tax (est. · ${rep.se_tax.state})`} value={rep.se_tax.state_tax} symbol={rep.symbol} color={colors.warm} />
                ) : (
                  <AppText variant="caption" color={colors.dim} style={{ marginTop: 4 }}>
                    {rep.se_tax.state || "Your state"} has no state income tax on gig earnings.
                  </AppText>
                )}
                {rep.se_tax.quarter_due ? (
                  <AppText variant="caption" color={colors.dim} style={{ marginTop: 6 }}>
                    Estimated payment (Form 1040-ES) due {rep.se_tax.quarter_due}.
                  </AppText>
                ) : null}
                <AppText variant="caption" color={colors.dim} style={{ marginTop: 8, lineHeight: 16 }}>{rep.se_tax.note}</AppText>
              </Card>
            </>
          ) : (
            <>
              {/* Vehicle deduction breakdown */}
              <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <AppText variant="h2" style={{ flexShrink: 1, marginRight: 8 }}>Vehicle deduction</AppText>
                  <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, flexShrink: 0 }}>
                    <AppText variant="caption" color={colors.accent}>
                      {rep.business_use_pct}% business{rep.business_use_is_fallback ? " (default)" : ""}
                    </AppText>
                  </View>
                </View>
                <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>
                  Fuel & vehicle costs apportioned by business-use %.
                </AppText>
                {rep.vehicle_deduction.fuel !== 0 ? <Row label="Fuel" value={rep.vehicle_deduction.fuel} symbol={rep.symbol} /> : null}
                {rep.vehicle_deduction.vehicle_costs !== 0 ? <Row label="Vehicle costs" value={rep.vehicle_deduction.vehicle_costs} symbol={rep.symbol} /> : null}
                {rep.vehicle_deduction.recurring_payment !== 0 ? (
                  <Row label="Recurring payment (calculated)" value={rep.vehicle_deduction.recurring_payment} symbol={rep.symbol}
                    sub={rep.vehicle_deduction.recurring_payment_gross ? `${rep.symbol}${rep.vehicle_deduction.recurring_payment_gross} gross × ${rep.business_use_pct}%` : undefined} />
                ) : null}
                <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
                <Row label="Vehicle deduction total" value={rep.vehicle_deduction.total} symbol={rep.symbol} strong />
              </Card>

              {/* Full-claim work expenses */}
              <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
                <AppText variant="h2" style={{ marginBottom: 4 }}>Other work expenses</AppText>
                <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>Claimed in full — not apportioned.</AppText>
                {rep.full_claim.tolls !== 0 ? <Row label="Tolls" value={rep.full_claim.tolls} symbol={rep.symbol} /> : null}
                {rep.full_claim.phone !== 0 ? <Row label="Phone" value={rep.full_claim.phone} symbol={rep.symbol} /> : null}
                {rep.full_claim.other !== 0 ? <Row label="Other" value={rep.full_claim.other} symbol={rep.symbol} /> : null}
                {rep.full_claim.total === 0 ? (
                  <AppText variant="caption" color={colors.dim}>No other work expenses logged this period.</AppText>
                ) : (
                  <>
                    <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
                    <Row label="Total" value={rep.full_claim.total} symbol={rep.symbol} strong />
                  </>
                )}
              </Card>

              {/* BAS / GST */}
              {rep.show_bas ? (
                <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
                  <AppText variant="h2" style={{ marginBottom: 2 }}>BAS / GST summary</AppText>
                  <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>
                    Copy these onto your ATO Business Activity Statement.
                  </AppText>
                  {rep.gst_note ? (
                    <View style={{ flexDirection: "row", alignItems: "flex-start", backgroundColor: colors.surfaceAlt,
                      borderRadius: 10, padding: 10, marginBottom: 10 }}>
                      <Ionicons name="alert-circle" size={16} color={colors.warm} style={{ marginRight: 8, marginTop: 1 }} />
                      <AppText variant="caption" color={colors.text} style={{ flex: 1, lineHeight: 16 }}>{rep.gst_note}</AppText>
                    </View>
                  ) : null}
                  <Row label="G1 — Total sales (incl GST)" value={rep.bas.G1} symbol={rep.symbol} />
                  <Row label="1A — GST on sales" value={rep.bas["1A"]} symbol={rep.symbol} />
                  <Row label="1B — GST on purchases" value={rep.bas["1B"]} symbol={rep.symbol} />
                  <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
                  <Row label="Net GST (1A − 1B)" value={rep.bas.net_gst} symbol={rep.symbol} strong
                    color={rep.bas.net_gst >= 0 ? colors.text : colors.profit} />
                  <AppText variant="caption" color={rep.bas.sanity_ok ? colors.profit : colors.loss} style={{ marginTop: 8 }}>
                    {rep.bas.sanity_ok ? "✓ 1A equals G1 ÷ 11 at the 10% rate" : "⚠ GST sanity check failed"}
                  </AppText>
                </Card>
              ) : (
                <Card style={{ marginBottom: 14, flexDirection: "row" }}>
                  <Ionicons name="information-circle-outline" size={20} color={colors.dim} style={{ marginRight: 10, marginTop: 2 }} />
                  <AppText variant="caption" color={colors.dim} style={{ flex: 1 }}>
                    {rep.work_type === "delivery"
                      ? "No BAS shown — delivery-only drivers register for GST only above $75,000 turnover. Mark yourself registered in Settings if that changes."
                      : "Mark your GST registration as 'registered' in Settings > Tax setup to see your BAS/GST summary."}
                  </AppText>
                </Card>
              )}
            </>
          )}

          {/* Which method is better? — FY-based vehicle-deduction comparison */}
          {tm?.method_comparison ? (() => {
            const mc = tm.method_comparison;
            return (
              <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
                <AppText variant="label" color={colors.dim} style={{ marginBottom: 4 }}>
                  WHICH METHOD IS BETTER? · FY {mc.fy_label}
                </AppText>
                <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
                  <View style={[methodBox, { backgroundColor: colors.surfaceAlt, borderColor: mc.recommend === "logbook" ? colors.profit : colors.border }]}>
                    <AppText variant="caption" color={colors.dim}>{mc.logbook.title}</AppText>
                    <Money value={mc.logbook.deduction} symbol={mc.symbol || rep.symbol} size={22} />
                    <AppText variant="caption" color={colors.dim}>{mc.logbook.business_pct}% of {fmtMoney(mc.logbook.eligible_expenses)}</AppText>
                  </View>
                  <View style={[methodBox, { backgroundColor: colors.surfaceAlt, borderColor: mc.recommend === "cents_per_km" ? colors.profit : colors.border }]}>
                    <AppText variant="caption" color={colors.dim}>{mc.cents_per_km.title}</AppText>
                    <Money value={mc.cents_per_km.deduction} symbol={mc.symbol || rep.symbol} size={22} />
                    <AppText variant="caption" color={colors.dim}>{mc.cents_per_km.detail}</AppText>
                  </View>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 12 }}>
                  <Ionicons name="trophy" size={20} color={colors.warm} style={{ marginRight: 10 }} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySemi" color={colors.profit}>{mc.recommend_label}</AppText>
                    <AppText variant="caption" color={colors.dim}>Potentially higher by {fmtMoney(mc.difference)}</AppText>
                  </View>
                </View>
                <AppText variant="caption" color={colors.dim} style={{ marginTop: 10, lineHeight: 16 }}>{mc.disclaimer}</AppText>
              </Card>
            );
          })() : null}

          {/* ATO Logbook / IRS Mileage Log */}
          {tm?.logbook ? (() => {
            const lb = tm.logbook;
            const isUS = rep.country === "US";
            return (
              <Pressable testID="reports-open-logbook" onPress={() => router.push("/logbook" as any)}>
                <Card style={{ marginBottom: 14, borderColor: colors.accent, flexDirection: "row", alignItems: "center" }}>
                  <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                    <Ionicons name="book-outline" size={22} color={colors.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySemi">{isUS ? "IRS Mileage Log" : "ATO Logbook"}</AppText>
                    {lb.available ? (
                      <AppText variant="caption" color={colors.dim}>
                        {lb.business_pct}% business · {lb.journey_count} trips{isUS ? "" : ` · ${lb.complete ? "12-week period ready" : "in progress"}`}
                      </AppText>
                    ) : (
                      <AppText variant="caption" color={colors.dim}>{isUS ? "Log trips to build your IRS mileage log" : "Classify trips to build your 12-week logbook"}</AppText>
                    )}
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.dim} />
                </Card>
              </Pressable>
            );
          })() : null}

          <View style={{ flexDirection: "row", gap: 10, marginTop: 2 }}>
            {rep.country === "US" ? (
              <SecondaryButton testID="reports-ato" label="IRS Schedule C" icon="open-outline" style={{ flex: 1 }}
                onPress={() => WebBrowser.openBrowserAsync("https://www.irs.gov/forms-pubs/about-schedule-c-form-1040")} />
            ) : (
              <SecondaryButton testID="reports-ato" label="ATO gig guide" icon="open-outline" style={{ flex: 1 }}
                onPress={() => WebBrowser.openBrowserAsync(ATO_LINK)} />
            )}
            <PrimaryButton testID="reports-export" label="Export CSV" icon="download-outline" style={{ flex: 1 }}
              onPress={exportCsv} />
          </View>
        </View>
      )}
    </Screen>
  );
}

const methodBox = {
  flex: 1, borderRadius: 14, padding: 12, borderWidth: 1, gap: 2,
} as const;
