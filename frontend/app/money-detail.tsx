import React, { useCallback, useState } from "react";
import { View, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme, FONT } from "@/src/theme";
import { api } from "@/src/api";
import { displayDateShort } from "@/src/date";
import {
  AppText, Card, Money, Spinner, IconButton, PrimaryButton, SecondaryButton, fmtMoney,
} from "@/src/ui";

const TITLES: Record<string, string> = {
  "money-now": "Real earnings",
  performance: "Performance",
  where: "Where your money went",
  tax: "Tax position",
  deductions: "Deductions tracked",
  bestworst: "Best & worst",
};

function Line({ label, value, symbol, color, strong, sub }:
  { label: string; value: number; symbol: string; color?: string; strong?: boolean; sub?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7 }}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <AppText variant={strong ? "bodySemi" : "bodyMed"} color={strong ? colors.text : colors.dim}>{label}</AppText>
        {sub ? <AppText variant="caption" color={colors.dim}>{sub}</AppText> : null}
      </View>
      <Money value={value} symbol={symbol} size={strong ? 20 : 16} color={color} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} />
    </View>
  );
}

function BigStat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <AppText variant="bodyMed">{label}</AppText>
        <AppText style={{ fontFamily: FONT.display, fontSize: 24, color: color || colors.text, fontVariant: ["tabular-nums"] }}>{value}</AppText>
      </View>
      {sub ? <AppText variant="caption" color={colors.dim} style={{ marginTop: 2 }}>{sub}</AppText> : null}
    </View>
  );
}

export default function MoneyDetail() {
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ section?: string; period?: string }>();
  const section = (params.section || "money-now") as string;
  const period = (params.period || "week") as string;

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      setData(await api.money(period, today));
    } finally { setLoading(false); }
  }, [period]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const symbol = data?.symbol || "$";
  const unit = data?.distance_unit || "km";

  const body = () => {
    if (!data) return null;
    const mn = data.money_now, perf = data.performance, tp = data.tax_position, ded = data.deductions;

    if (section === "money-now") {
      return (
        <>
          <Card style={{ marginBottom: 14, alignItems: "center" }}>
            <AppText variant="label" color={colors.dim}>YOUR REAL EARNINGS</AppText>
            <Money value={mn.take_home} symbol={symbol} size={44} color={mn.take_home >= 0 ? colors.profit : colors.loss}
              numberOfLines={1} adjustsFontSizeToFit style={{ marginTop: 4 }} />
            <AppText variant="caption" color={colors.dim}>after expenses • after estimated tax</AppText>
          </Card>
          <Card style={{ marginBottom: 14 }}>
            <AppText variant="h2" style={{ marginBottom: 4 }}>The full picture</AppText>
            <Line label="Gross earnings" value={mn.gross} symbol={symbol} strong />
            <Line label="Work expenses" value={-mn.expenses} symbol={symbol} color={colors.loss} />
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />
            <Line label="Profit before tax" value={mn.profit_before_tax} symbol={symbol} strong />
            <Line label="Estimated tax" value={-mn.estimated_tax} symbol={symbol} color={colors.loss}
              sub={`~${mn.effective_tax_rate}% effective rate`} />
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />
            <Line label="Money after tax" value={mn.take_home} symbol={symbol} color={colors.profit} strong />
          </Card>
          {mn.keep_rate != null ? (
            <Card style={{ marginBottom: 14, alignItems: "center" }}>
              <AppText style={{ fontFamily: FONT.display, fontSize: 54, color: colors.profit }}>{mn.keep_rate}%</AppText>
              <AppText variant="bodySemi">Keep rate</AppText>
              <AppText variant="caption" color={colors.dim} style={{ textAlign: "center", marginTop: 4, lineHeight: 16 }}>
                You keep about {symbol}{Math.round(mn.keep_rate)} of every {symbol}100 you earn, after work costs and estimated tax.
              </AppText>
            </Card>
          ) : null}
          <AppText variant="caption" color={colors.dim} style={{ textAlign: "center", lineHeight: 16 }}>
            Estimated tax uses your year-to-date effective rate applied to this period’s profit. An estimate, not tax advice.
          </AppText>
        </>
      );
    }

    if (section === "performance") {
      const stat = (label: string, v: number | null, unitTxt: string, hi?: boolean) => (
        <BigStat label={label} color={hi ? colors.accent : undefined}
          value={v != null ? (unitTxt.startsWith("/") || unitTxt === "" ? `${symbol}${v}${unitTxt}` : `${v}${unitTxt}`) : "—"} />
      );
      return (
        <Card>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 2 }}>
            {perf.hours} hours online{perf.active_hours ? ` · ${perf.active_hours} active` : ""} · {perf.km} {unit} driven
          </AppText>
          {stat("Real $/hour", perf.real_per_hour, "/hr", true)}
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Take-home ÷ online hours — what you keep per hour logged on.</AppText>
          {stat("Gross $/hour", perf.gross_per_hour, "/hr")}
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Total earnings ÷ online hours, before any costs.</AppText>
          {perf.active_hours ? (
            <>
              {stat("Real $/active hour", perf.real_active_per_hour, "/hr", true)}
              <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Take-home ÷ hours actually on a job (making money).</AppText>
              <BigStat label="Utilisation" color={colors.accent}
                value={perf.utilisation != null ? `${perf.utilisation}%` : "—"} />
              <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Active ÷ online — how much of your time on the road actually paid.</AppText>
              {perf.by_platform && perf.by_platform.some((p: any) => p.active_hours > 0) ? (
                <View style={{ marginTop: 8, marginBottom: 4 }}>
                  <AppText variant="label" color={colors.dim} style={{ marginBottom: 8 }}>BY APP</AppText>
                  {perf.by_platform.filter((p: any) => p.active_hours > 0 || p.income > 0).map((p: any) => (
                    <View key={p.platform} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                      paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
                      <View style={{ flex: 1 }}>
                        <AppText variant="bodySemi">{p.platform}</AppText>
                        <AppText variant="caption" color={colors.dim}>
                          {p.active_hours > 0 ? `${p.active_hours}h active` : "no active hours"} · {symbol}{p.income} earned
                        </AppText>
                      </View>
                      {p.per_active_hour != null ? (
                        <AppText variant="bodySemi" color={colors.profit}>{symbol}{p.per_active_hour}/hr</AppText>
                      ) : null}
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          ) : (
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>
              Log active hours per app when you add hours to unlock your $/active hour and utilisation.
            </AppText>
          )}
          {stat(`Earned / ${unit}`, perf.per_km, "/" + unit)}
          {stat(`Cost / ${unit}`, perf.cost_per_km, "/" + unit)}
          {stat(`Profit / ${unit}`, perf.profit_per_km, "/" + unit)}
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Earned minus running costs, per {unit} — is all that driving worth it?</AppText>
          {data.trend_pct != null ? (
            <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12 }}>
              <Ionicons name={data.trend_pct >= 0 ? "trending-up" : "trending-down"} size={16}
                color={data.trend_pct >= 0 ? colors.profit : colors.loss} style={{ marginRight: 6 }} />
              <AppText variant="caption" color={colors.dim}>
                Real earnings {Math.abs(data.trend_pct)}% {data.trend_pct >= 0 ? "higher" : "lower"} than last period
              </AppText>
            </View>
          ) : null}
        </Card>
      );
    }

    if (section === "where") {
      const maxAmt = Math.max(mn.take_home, ...data.where.map((w: any) => w.amount), 1);
      return (
        <Card>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
            You earned {fmtMoney(mn.gross, symbol)} — here’s where it went.
          </AppText>
          {data.where.map((w: any) => (
            <View key={w.label} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                <AppText variant="bodyMed" color={colors.dim}>{w.label}
                  <AppText variant="caption" color={colors.dim}>  {mn.gross > 0 ? `${Math.round((w.amount / mn.gross) * 100)}%` : ""}</AppText>
                </AppText>
                <Money value={w.amount} symbol={symbol} size={15} color={colors.loss} />
              </View>
              <View style={{ height: 8, borderRadius: 999, backgroundColor: colors.surfaceAlt, overflow: "hidden" }}>
                <View style={{ height: 8, borderRadius: 999, backgroundColor: colors.loss, opacity: 0.7, width: `${Math.max(2, (w.amount / maxAmt) * 100)}%` }} />
              </View>
            </View>
          ))}
          <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
            <AppText variant="bodySemi" color={colors.profit}>Money you kept</AppText>
            <Money value={mn.take_home} symbol={symbol} size={20} color={colors.profit} />
          </View>
          <View style={{ height: 10, borderRadius: 999, backgroundColor: colors.surfaceAlt, overflow: "hidden" }}>
            <View style={{ height: 10, borderRadius: 999, backgroundColor: colors.profit, width: `${Math.max(2, (Math.max(0, mn.take_home) / maxAmt) * 100)}%` }} />
          </View>
        </Card>
      );
    }

    if (section === "tax") {
      return (
        <>
          <Card style={{ marginBottom: 14, borderColor: tp.status === "behind" ? colors.loss : colors.profit }}>
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Year to date · {tp.tax_year_label}</AppText>
            <Line label="Estimated tax owed" value={tp.owed_ytd} symbol={symbol} strong />
            <Line label="You've set aside" value={tp.set_aside} symbol={symbol} strong />
            <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ width: 12, height: 12, borderRadius: 6, marginRight: 8,
                backgroundColor: tp.status === "behind" ? colors.loss : colors.profit }} />
              <AppText variant="h2" color={tp.status === "behind" ? colors.loss : colors.profit}>
                {tp.status === "behind" ? "Behind" : "Ahead"} by {fmtMoney(Math.abs(tp.position), symbol)}
              </AppText>
            </View>
            <AppText variant="caption" color={colors.dim} style={{ marginTop: 8, lineHeight: 16 }}>
              A good habit: set aside about {tp.recommend_rate}% of your profit as you earn, so tax time never surprises you. Estimate only — not tax advice.
            </AppText>
          </Card>
          <PrimaryButton testID="detail-update-setaside" label="Update tax set aside" icon="wallet-outline"
            onPress={() => router.push("/tax-saved" as any)} />
          <SecondaryButton testID="detail-open-reports" label="See full tax report" icon="document-text-outline" style={{ marginTop: 10 }}
            onPress={() => router.back()} />
        </>
      );
    }

    if (section === "deductions") {
      return (
        <Card>
          <AppText variant="caption" color={colors.dim}>Year to date · {ded.tax_year_label}</AppText>
          <Money value={ded.total} symbol={symbol} size={44} color={colors.accent} style={{ marginTop: 4, marginBottom: 8 }} />
          {ded.breakdown.map((b: any) => (
            <Line key={b.label} label={b.label} value={b.amount} symbol={symbol} />
          ))}
          {ded.estimated_tax_impact > 0 ? (
            <>
              <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
              <Line label="Estimated tax impact" value={ded.estimated_tax_impact} symbol={symbol} color={colors.profit} strong />
              <AppText variant="caption" color={colors.dim} style={{ marginTop: 6, lineHeight: 16 }}>
                An estimate of the tax these tracked deductions may save you — based on your effective rate. Not a guaranteed refund.
              </AppText>
            </>
          ) : null}
        </Card>
      );
    }

    if (section === "bestworst") {
      const dayCard = (d: any, title: string, color: string) => d ? (
        <Card style={{ marginBottom: 14, borderColor: color }}>
          <AppText variant="label" color={colors.dim}>{title}</AppText>
          <AppText variant="h2" style={{ marginTop: 2 }}>{displayDateShort(d.date)}</AppText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            <BigMini label="earned" value={fmtMoney(d.income, symbol)} />
            <BigMini label="real $/hr" value={d.real_per_hour != null ? `${symbol}${d.real_per_hour}` : "—"} hi color={color} />
            <BigMini label={`$/${unit}`} value={d.per_km != null ? `${symbol}${d.per_km}` : "—"} />
            <BigMini label="hours" value={`${d.hours}`} />
            <BigMini label={unit} value={`${d.km}`} />
            <BigMini label="profit b/tax" value={fmtMoney(d.profit_before_tax, symbol)} />
          </View>
        </Card>
      ) : null;
      return (
        <>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 10 }}>Ranked by real {symbol}/hour · {data.intel_label}</AppText>
          {dayCard(data.best_day, "🟢 BEST DAY", colors.profit)}
          {dayCard(data.worst_day, "🔴 WORST DAY", colors.loss)}
          {!data.best_day ? (
            <AppText variant="caption" color={colors.dim}>Log income and online hours to unlock best/worst day.</AppText>
          ) : null}
          {data.platforms?.length ? (
            <Card>
              <AppText variant="h2" style={{ marginBottom: 6 }}>By platform</AppText>
              {data.platforms.map((p: any) => (
                <View key={p.name} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7,
                  borderTopWidth: 1, borderTopColor: colors.border }}>
                  <View>
                    <AppText variant="bodyMed">{p.name}</AppText>
                    <AppText variant="caption" color={colors.dim}>{p.hours > 0 ? `${p.hours}h` : "no hours logged"}</AppText>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Money value={p.income} symbol={symbol} size={16} />
                    {p.per_hour != null ? <AppText variant="caption" color={colors.profit}>{symbol}{p.per_hour}/hr</AppText> : null}
                  </View>
                </View>
              ))}
            </Card>
          ) : null}
        </>
      );
    }
    return null;
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="arrow-back" testID="detail-back" onPress={() => router.back()} />
          <AppText variant="h2">{TITLES[section] || "Details"}</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>
      {loading || !data ? <Spinner /> : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
          <AppText variant="label" color={colors.dim} style={{ marginBottom: 12 }}>{data.period_label}</AppText>
          {body()}
        </ScrollView>
      )}
    </View>
  );
}

function BigMini({ label, value, hi, color }: { label: string; value: string; hi?: boolean; color?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexBasis: "31%", flexGrow: 1, backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 10 }}>
      <AppText style={{ fontFamily: FONT.display, fontSize: 18, color: hi ? (color || colors.accent) : colors.text, fontVariant: ["tabular-nums"] }}
        numberOfLines={1} adjustsFontSizeToFit>{value}</AppText>
      <AppText variant="caption" color={colors.dim} style={{ fontSize: 11 }}>{label}</AppText>
    </View>
  );
}
