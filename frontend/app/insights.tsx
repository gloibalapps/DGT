import React, { useCallback, useState } from "react";
import { View, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { api, todayISO } from "@/src/api";
import { displayDateShort } from "@/src/date";
import {
  AppText, Card, IconButton, Spinner, EmptyState, Money, fmtMoney,
} from "@/src/ui";

function ShiftRow({ s, symbol, color, colors }: { s: any; symbol: string; color: string; colors: any }) {
  const timeRange = s.start_time ? `${s.start_time}${s.end_time ? `–${s.end_time}` : ""}` : "";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", borderLeftWidth: 3, borderLeftColor: color, paddingLeft: 10 }}>
      <View style={{ flex: 1 }}>
        <AppText variant="bodySemi">{displayDateShort(s.date)}{timeRange ? ` · ${timeRange}` : ""}</AppText>
        <AppText variant="caption" color={colors.dim}>
          {fmtMoney(s.income, symbol)} · {s.hours}h{s.platform ? ` · ${s.platform}` : ""}
        </AppText>
      </View>
      <AppText variant="h2" color={color}>{symbol}{s.per_hour}/hr</AppText>
    </View>
  );
}

/** Vertical bars: weekly earnings, with the hours logged that week underneath. */
function WeeklyBars({ weeks, symbol }: { weeks: any[]; symbol: string }) {
  const { colors } = useTheme();
  const H = 96;
  const max = Math.max(1, ...weeks.map((w) => Math.max(0, w.income)));
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginTop: 12 }}>
      {weeks.map((w, i) => {
        const h = Math.max(3, (Math.max(0, w.income) / max) * H);
        return (
          <View key={i} style={{ flex: 1, alignItems: "center" }}>
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4, fontSize: 10 }}>
              {w.income >= 1000 ? `${symbol}${Math.round(w.income / 100) / 10}k` : `${symbol}${Math.round(w.income)}`}
            </AppText>
            <View style={{ height: H, justifyContent: "flex-end" }}>
              <View style={{ width: 18, height: h, borderRadius: 4, backgroundColor: colors.profit }} />
            </View>
            <AppText variant="caption" color={colors.dim} style={{ marginTop: 6, fontSize: 10 }}>{w.label}</AppText>
            <AppText variant="caption" color={w.hours > 0 ? colors.accent : colors.dim} style={{ fontSize: 10 }}>
              {w.hours > 0 ? `${w.hours}h` : "—"}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}

/** Horizontal bars per weekday for the chosen metric. */
function WeekdayBars({ data, metric, symbol, bestKey }:
  { data: any[]; metric: "per_hour" | "income"; symbol: string; bestKey: string | null }) {
  const { colors } = useTheme();
  const val = (d: any) => (metric === "per_hour" ? (d.per_hour || 0) : d.income);
  const max = Math.max(1, ...data.map(val));
  return (
    <View style={{ gap: 8, marginTop: 12 }}>
      {data.map((d) => {
        const v = val(d);
        const best = d.short === bestKey && v > 0;
        const w = `${Math.max(2, (v / max) * 100)}%`;
        return (
          <View key={d.weekday} style={{ flexDirection: "row", alignItems: "center" }}>
            <AppText variant="caption" color={colors.dim} style={{ width: 34 }}>{d.short}</AppText>
            <View style={{ flex: 1, height: 22, backgroundColor: colors.surfaceAlt, borderRadius: 6, overflow: "hidden" }}>
              <View style={{ height: 22, width: w as any, borderRadius: 6, backgroundColor: best ? colors.profit : colors.accent, opacity: v > 0 ? 1 : 0.25 }} />
            </View>
            <AppText variant="caption" color={best ? colors.profit : colors.text}
              style={{ width: 66, textAlign: "right", fontVariant: ["tabular-nums"] }}>
              {v > 0 ? (metric === "per_hour" ? `${symbol}${v}/h` : fmtMoney(v, symbol)) : "—"}
            </AppText>
          </View>
        );
      })}
    </View>
  );
}

export default function Insights() {
  const { colors } = useTheme();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api.insights(todayISO()));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const symbol = data?.symbol || "$";

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="arrow-back" testID="insights-back" onPress={() => router.back()} />
          <AppText variant="h2">Driving insights</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>

      {loading ? <Spinner /> : (!data?.has_income ? (
        <EmptyState icon="analytics-outline" title="No insights yet"
          subtitle="Log some income — and your online hours per shift — to see your weekly trend and your most profitable days." />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
          {/* Headline */}
          {data.best_hourly_day ? (
            <Card style={{ marginBottom: 14, borderColor: colors.profit, flexDirection: "row", alignItems: "center" }}>
              <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: colors.surfaceAlt,
                alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                <Ionicons name="trophy" size={22} color={colors.warm} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText variant="bodySemi">{data.best_hourly_day.name}s pay best</AppText>
                <AppText variant="caption" color={colors.dim}>
                  You earn about {symbol}{data.best_hourly_day.per_hour}/hr on {data.best_hourly_day.name}s
                </AppText>
              </View>
            </Card>
          ) : data.best_earning_day ? (
            <Card style={{ marginBottom: 14, borderColor: colors.profit, flexDirection: "row", alignItems: "center" }}>
              <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: colors.surfaceAlt,
                alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                <Ionicons name="trophy" size={22} color={colors.warm} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText variant="bodySemi">{data.best_earning_day.name}s are your biggest earners</AppText>
                <AppText variant="caption" color={colors.dim}>
                  {fmtMoney(data.best_earning_day.income, symbol)} earned on {data.best_earning_day.name}s · log your online hours to see {symbol}/hr
                </AppText>
              </View>
            </Card>
          ) : null}

          {/* Weekly hours vs earnings */}
          <Card style={{ marginBottom: 14 }}>
            <AppText variant="h2">Weekly recap</AppText>
            <AppText variant="caption" color={colors.dim}>
              Earnings and online hours · last {data.weeks_back} weeks
            </AppText>
            <WeeklyBars weeks={data.weekly} symbol={symbol} />
            {data.avg_per_hour != null ? (
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14, backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 12 }}>
                <Ionicons name="speedometer-outline" size={18} color={colors.accent} style={{ marginRight: 10 }} />
                <AppText variant="bodyMed" style={{ flex: 1 }}>Average earnings</AppText>
                <Money value={data.avg_per_hour} symbol={symbol} size={20} />
                <AppText variant="caption" color={colors.dim} style={{ marginLeft: 2 }}>/hr</AppText>
              </View>
            ) : (
              <AppText variant="caption" color={colors.dim} style={{ marginTop: 12, lineHeight: 16 }}>
                Tap “Log hours” on the Money tab to record your online time — then this recap shows your real {symbol}/hour.
              </AppText>
            )}
          </Card>

          {/* Best days to drive */}
          <Card style={{ marginBottom: 14 }}>
            <AppText variant="h2">Best days to drive</AppText>
            <AppText variant="caption" color={colors.dim}>
              {data.has_hours
                ? `Earnings per online hour by weekday · last ${data.weekday_weeks} weeks`
                : `Earnings by weekday · last ${data.weekday_weeks} weeks`}
            </AppText>
            <WeekdayBars
              data={data.by_weekday}
              metric={data.has_hours ? "per_hour" : "income"}
              symbol={symbol}
              bestKey={data.has_hours ? (data.best_hourly_day?.short || null) : (data.best_earning_day?.short || null)}
            />
          </Card>

          {/* Best time to drive (needs timed shifts) */}
          {data.has_timed ? (
            <Card style={{ marginBottom: 14 }}>
              <AppText variant="h2">Best time to drive</AppText>
              <AppText variant="caption" color={colors.dim}>Earnings per online hour by time of day</AppText>
              <View style={{ gap: 8, marginTop: 12 }}>
                {data.by_timeofday.map((s: any) => {
                  const max = Math.max(1, ...data.by_timeofday.map((x: any) => x.per_hour || 0));
                  const v = s.per_hour || 0;
                  const best = data.best_timeofday && s.key === data.best_timeofday.key && v > 0;
                  return (
                    <View key={s.key} style={{ flexDirection: "row", alignItems: "center" }}>
                      <View style={{ width: 76 }}>
                        <AppText variant="caption" color={best ? colors.profit : colors.text}>{s.label}</AppText>
                        <AppText variant="caption" color={colors.dim} style={{ fontSize: 10 }}>{s.sub}</AppText>
                      </View>
                      <View style={{ flex: 1, height: 20, backgroundColor: colors.surfaceAlt, borderRadius: 6, overflow: "hidden" }}>
                        <View style={{ height: 20, width: `${Math.max(2, (v / max) * 100)}%` as any, borderRadius: 6,
                          backgroundColor: best ? colors.profit : colors.accent, opacity: v > 0 ? 1 : 0.25 }} />
                      </View>
                      <AppText variant="caption" color={best ? colors.profit : colors.text}
                        style={{ width: 62, textAlign: "right" }}>{v > 0 ? `${symbol}${v}/h` : "—"}</AppText>
                    </View>
                  );
                })}
              </View>
            </Card>
          ) : null}

          {/* Best & worst shift (timed) */}
          {data.best_shift ? (
            <Card style={{ marginBottom: 14 }}>
              <AppText variant="h2" style={{ marginBottom: 8 }}>Your best shift</AppText>
              <ShiftRow s={data.best_shift} symbol={symbol} color={colors.profit} colors={colors} />
              {data.worst_shift ? (
                <>
                  <AppText variant="h2" style={{ marginTop: 14, marginBottom: 8 }}>Toughest shift</AppText>
                  <ShiftRow s={data.worst_shift} symbol={symbol} color={colors.loss} colors={colors} />
                </>
              ) : null}
            </Card>
          ) : data.has_hours ? (
            <Card style={{ marginBottom: 14 }}>
              <AppText variant="h2">Best shift</AppText>
              <AppText variant="caption" color={colors.dim} style={{ marginTop: 4, lineHeight: 16 }}>
                Add a start &amp; end time when you log hours to unlock your best shift and best time of day.
              </AppText>
            </Card>
          ) : null}

          <AppText variant="caption" color={colors.dim} style={{ textAlign: "center", lineHeight: 16 }}>
            Insights are estimates based on what you’ve logged. The more income and online hours you record, the sharper they get.
          </AppText>
        </ScrollView>
      ))}
    </View>
  );
}
