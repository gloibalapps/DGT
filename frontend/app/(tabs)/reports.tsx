import React, { useCallback, useState } from "react";
import { View, RefreshControl } from "react-native";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api } from "@/src/api";
import { PERIODS, ATO_LINK } from "@/src/config";
import {
  Screen, ScreenHeader, Card, AppText, Money, Spinner, ChipRow,
  PrimaryButton, SecondaryButton, useToast,
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
  const [period, setPeriod] = useState("quarter");
  const [rep, setRep] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      setRep(await api.report(period, today));
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
          <Card style={{ marginBottom: 14 }}>
            <AppText variant="label" color={colors.dim} style={{ marginBottom: 4 }}>NET PROFIT</AppText>
            <Money value={rep.net_profit} symbol={rep.symbol} size={44} signed={false}
              color={rep.net_profit >= 0 ? colors.profit : colors.loss} />
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 10 }} />
            <Row label="Total income" value={rep.total_income} symbol={rep.symbol} />
            <Row label="Total deductions" value={-rep.total_deductions} symbol={rep.symbol} />
          </Card>

          {/* Vehicle deduction breakdown */}
          <Card style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <AppText variant="h2">Vehicle deduction</AppText>
              <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                <AppText variant="caption" color={colors.accent}>
                  {rep.business_use_pct}% business{rep.business_use_is_fallback ? " (default)" : ""}
                </AppText>
              </View>
            </View>
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>
              Fuel & vehicle costs apportioned by business-use %.
            </AppText>
            <Row label="Fuel" value={rep.vehicle_deduction.fuel} symbol={rep.symbol} />
            <Row label="Vehicle costs" value={rep.vehicle_deduction.vehicle_costs} symbol={rep.symbol} />
            <Row label="Recurring payment (calculated)" value={rep.vehicle_deduction.recurring_payment} symbol={rep.symbol}
              sub={rep.vehicle_deduction.recurring_payment_gross ? `${rep.symbol}${rep.vehicle_deduction.recurring_payment_gross} gross × ${rep.business_use_pct}%` : undefined} />
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
            <Row label="Vehicle deduction total" value={rep.vehicle_deduction.total} symbol={rep.symbol} strong />
          </Card>

          {/* Full-claim work expenses */}
          <Card style={{ marginBottom: 14 }}>
            <AppText variant="h2" style={{ marginBottom: 4 }}>Other work expenses</AppText>
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>Claimed in full — not apportioned.</AppText>
            <Row label="Tolls" value={rep.full_claim.tolls} symbol={rep.symbol} />
            <Row label="Phone" value={rep.full_claim.phone} symbol={rep.symbol} />
            <Row label="Other" value={rep.full_claim.other} symbol={rep.symbol} />
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
            <Row label="Total" value={rep.full_claim.total} symbol={rep.symbol} strong />
          </Card>

          {/* BAS / GST */}
          {rep.show_bas ? (
            <Card style={{ marginBottom: 14, borderColor: colors.accent }}>
              <AppText variant="h2" style={{ marginBottom: 2 }}>BAS / GST summary</AppText>
              <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>
                Copy these onto your ATO Business Activity Statement.
              </AppText>
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

          <View style={{ flexDirection: "row", gap: 10, marginTop: 2 }}>
            <SecondaryButton testID="reports-ato" label="ATO gig guide" icon="open-outline" style={{ flex: 1 }}
              onPress={() => WebBrowser.openBrowserAsync(ATO_LINK)} />
            <PrimaryButton testID="reports-export" label="Export CSV" icon="download-outline" style={{ flex: 1 }}
              onPress={exportCsv} />
          </View>
        </View>
      )}
    </Screen>
  );
}
