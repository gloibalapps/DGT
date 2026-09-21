import React, { useCallback, useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";

import { useTheme, FONT } from "@/src/theme";
import { api, todayISO } from "@/src/api";
import {
  AppText, Card, IconButton, Spinner, EmptyState, Badge,
} from "@/src/ui";
import { ScrollView } from "react-native";

const PURPOSE_LABELS: Record<string, string> = {
  collect: "Collecting an order", deliver: "Delivering an order",
  between_jobs: "Between jobs", other_business: "Other business",
  home: "Going home", shopping: "Shopping",
  appointment: "Appointment", personal_other: "Personal travel",
};

export default function Logbook() {
  const { colors } = useTheme();
  const router = useRouter();
  const [lb, setLb] = useState<any>(null);
  const [unit, setUnit] = useState("km");
  const [isUS, setIsUS] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const tm = await api.taxMileage(todayISO());
      setLb(tm.logbook);
      setUnit(tm.distance_unit || "km");
      setIsUS(tm.country === "US");
    } finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const typeColor = (t: string) => t === "personal" ? colors.dim : t === "mixed" ? colors.warm : colors.profit;
  const typeLabel = (t: string) => t === "personal" ? "Private" : t === "mixed" ? "Mixed" : "Business";

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="arrow-back" testID="logbook-back" onPress={() => router.back()} />
          <AppText variant="h2">{isUS ? "IRS Mileage Log" : "ATO Logbook"}</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>

      {loading ? <Spinner /> : (!lb?.available ? (
        <EmptyState icon="book-outline" title="No logbook yet"
          subtitle={isUS ? "Log business and personal trips to build your IRS mileage log." : "Classify some business and private trips to build your 12-week ATO logbook."} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
          <Card style={{ marginBottom: 14, alignItems: "center" }}>
            <AppText variant="label" color={colors.dim}>{isUS ? "BUSINESS USE (TAX YEAR)" : "12-WEEK BUSINESS USE"}</AppText>
            <AppText style={{ fontFamily: FONT.display, fontSize: 60, color: colors.accent, fontVariant: ["tabular-nums"] }}>
              {lb.business_pct}%
            </AppText>
            <AppText variant="caption" color={colors.dim}>{lb.period_label}</AppText>
            <View style={{ flexDirection: "row", gap: 24, marginTop: 10 }}>
              <View style={{ alignItems: "center" }}>
                <AppText variant="bodySemi" color={colors.profit}>{lb.business_km} {unit}</AppText>
                <AppText variant="caption" color={colors.dim}>Business</AppText>
              </View>
              <View style={{ alignItems: "center" }}>
                <AppText variant="bodySemi">{lb.total_km} {unit}</AppText>
                <AppText variant="caption" color={colors.dim}>Total</AppText>
              </View>
              <View style={{ alignItems: "center" }}>
                <AppText variant="bodySemi">{lb.journey_count}</AppText>
                <AppText variant="caption" color={colors.dim}>Journeys</AppText>
              </View>
            </View>
            {!lb.complete ? (
              <View style={{ marginTop: 12, backgroundColor: colors.surfaceAlt, borderRadius: 10, padding: 10 }}>
                <AppText variant="caption" color={colors.warm}>
                  In progress — keep logging until you reach a continuous 12-week period.
                </AppText>
              </View>
            ) : null}
          </Card>

          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12, marginLeft: 4 }}>{lb.note}</AppText>

          <AppText variant="h2" style={{ marginBottom: 10 }}>Journeys</AppText>
          {lb.journeys.map((j: any) => (
            <Card key={j.id} style={{ marginBottom: 8, paddingVertical: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <AppText variant="bodySemi" style={{ fontVariant: ["tabular-nums"] }}>{j.distance_km} {unit}</AppText>
                <Badge label={typeLabel(j.type)} color={typeColor(j.type)} bg={colors.surfaceAlt} />
              </View>
              <AppText variant="caption" color={colors.dim} style={{ marginTop: 4 }}>
                {j.date_label}
                {j.purpose ? ` · ${PURPOSE_LABELS[j.purpose] || j.purpose}` : ""}
                {j.from_label || j.to_label ? ` · ${j.from_label || "?"} → ${j.to_label || "?"}` : ""}
              </AppText>
            </Card>
          ))}
        </ScrollView>
      ))}
    </View>
  );
}
