import React, { useCallback, useState } from "react";
import { View, Pressable, Linking, Platform } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { api } from "@/src/api";
import { AppText, Card, HeroCard, IconButton, ListCard, ListRow, PrimaryButton, Screen, Select, Spinner, UnderlineTabs, fmtMoney, useToast } from "@/src/ui";
import { auDate, fmtDur, UEJob } from "@/src/ueParse";

const A = (n: number) => fmtMoney(n, "A$");
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function Guarantee() {
  const { colors } = useTheme();
  const router = useRouter();
  const { show } = useToast();
  const [cycle, setCycle] = useState<string | undefined>(undefined);
  const [data, setData] = useState<any>(null);
  const [week, setWeek] = useState<number | null>(null);
  const [order, setOrder] = useState<"newest" | "oldest">("newest");

  const load = useCallback(async (c?: string) => {
    try { setData(await api.ueGuarantee(c)); } catch { show("Couldn't load the guarantee", "error"); }
  }, [show]);
  useFocusEffect(useCallback(() => { load(cycle); }, [load, cycle]));

  const exportXlsx = async () => {
    const url = await api.ueExportUrl(data.cycle_start);
    if (Platform.OS === "web") window.open(url, "_blank"); else Linking.openURL(url);
  };

  if (!data) return <Screen><Spinner /></Screen>;
  const t = data.total;
  const owed = t.top_up > 0;
  const rateColor = (r: number | null) => (r == null ? colors.text : r >= data.rate ? colors.profit : colors.loss);

  const header = (
    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 }}>
      <IconButton testID="g-back" icon="chevron-back" onPress={() => (week != null ? setWeek(null) : router.back())} />
      <AppText variant="title" style={{ flex: 1 }} numberOfLines={1}>{week != null ? `Week ${week + 1}` : "Guarantee"}</AppText>
      <IconButton testID="g-add" icon="add" onPress={() => router.push("/ue-jobs" as any)} />
    </View>
  );

  if (week != null) {
    const w = data.weeks[week];
    const jobs: UEJob[] = data.jobs.filter((j: UEJob) => j.date >= w.start && j.date <= w.end);
    const days = Array.from(new Set(jobs.map((j) => j.date))).sort();
    if (order === "newest") days.reverse();
    return (
      <Screen scroll header={header}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <IconButton testID="g-week-prev" icon="chevron-back" color={week === 0 ? colors.border : colors.accent} onPress={() => week > 0 && setWeek(week - 1)} />
          <AppText variant="bodySemi">{auDate(w.start)} – {auDate(w.end)}</AppText>
          <IconButton testID="g-week-next" icon="chevron-forward" color={week === 2 ? colors.border : colors.accent} onPress={() => week < 2 && setWeek(week + 1)} />
        </View>
        <ListCard>
          <ListRow label="Jobs" value={String(w.jobs)} />
          <ListRow label="Earnings" value={A(w.earnings)} />
          <ListRow label="Engaged time" value={fmtDur(w.engaged_sec)} />
          <ListRow testID="g-week-rate" label="Effective rate" value={w.effective_rate == null ? "—" : `${A(w.effective_rate)}/hr`} valueColor={rateColor(w.effective_rate)} strong />
        </ListCard>
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 16, marginLeft: 4 }}>
          Earnings include {A(w.promo_total)} in promotions. Weekly figures are a guide — the guarantee is assessed over the whole cycle.
        </AppText>
        <UnderlineTabs options={[{ key: "newest", label: "Newest" }, { key: "oldest", label: "Oldest" }]} value={order}
          onChange={(k) => setOrder(k as any)} testIDPrefix="g-order" />
        <View style={{ height: 16 }} />
        {days.length === 0 ? <AppText variant="caption" color={colors.dim}>No jobs this week.</AppText> : days.map((d) => {
          const dj = jobs.filter((j) => j.date === d);
          const list = order === "newest" ? [...dj].reverse() : dj;
          return (
            <ListCard key={d} label={`${DAY[new Date(d + "T00:00:00").getDay()]} ${auDate(d)}`}>
              {list.map((j) => (
                <ListRow key={j.id} label={j.type === "Promotion" ? "Promotion" : `${j.start_time} · ${j.type === "Package" ? "Package" : "Delivery"}`}
                  sub={j.type === "Promotion" ? undefined : `${fmtDur(j.duration_sec)}${j.km ? ` · ${j.km} km` : ""}`}
                  value={j.amount == null ? "—" : A(j.amount)}
                  onPress={() => router.push({ pathname: "/ue-jobs" as any, params: { date: j.date } })} />
              ))}
            </ListCard>
          );
        })}
      </Screen>
    );
  }

  return (
    <Screen scroll header={header}>
      <Select testID="g-cycle" title="Cycle" value={data.cycle_start} style={{ marginBottom: 16 }}
        onChange={(k) => { setCycle(k); load(k); }}
        options={data.cycles.map((c: any, i: number) => ({ key: c.start, label: `${auDate(c.start)} – ${auDate(c.end)}${i === 0 ? " (current)" : ""}` }))} />

      <HeroCard testID="g-status" label={owed ? "Uber owes you" : "Guarantee met"} value={owed ? t.top_up : t.earnings}
        symbol="A$" valueColor={owed ? colors.loss : colors.profit}>
        <AppText variant="caption" color={owed ? colors.loss : colors.profit}>
          {owed ? `Uber owes A$${t.top_up.toFixed(2)} top-up this cycle` : "Your earnings are at or above the guarantee"}
        </AppText>
      </HeroCard>

      {data.mismatches.length ? (
        <ListCard label="Check your Uber Eats income">
          {data.mismatches.map((m: any) => (
            <ListRow key={m.date} testID={`g-mismatch-${m.date}`} icon="warning-outline" iconColor={colors.warm}
              label={`${auDate(m.date)}: logged ${A(m.income_logged)}, jobs ${A(m.jobs_total)}`}
              sub="Your daily Uber Eats total doesn't match the jobs entered" />
          ))}
        </ListCard>
      ) : null}

      <ListCard label="Cycle totals">
        <ListRow label="Earnings (incl. promotions)" value={A(t.earnings)} />
        <ListRow label="Engaged time" value={fmtDur(t.engaged_sec)} />
        <ListRow label="Effective rate" value={t.effective_rate == null ? "—" : `${A(t.effective_rate)}/hr`} valueColor={rateColor(t.effective_rate)} />
        <ListRow label={`Guaranteed (${A(data.rate)}/hr · ${data.vehicle_type})`} value={A(t.guaranteed)} strong />
      </ListCard>

      <AppText variant="section" style={{ marginBottom: 8, marginLeft: 4 }}>Weeks</AppText>
      {data.weeks.map((w: any) => (
        <Pressable key={w.index} testID={`g-week-${w.index}`} onPress={() => setWeek(w.index)}>
          <Card style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ flex: 1 }}>
                <AppText variant="bodySemi">Week {w.index + 1} · {auDate(w.start)} – {auDate(w.end)}</AppText>
                <AppText variant="caption" color={colors.dim} style={{ fontVariant: ["tabular-nums"] }}>
                  {w.jobs} job{w.jobs === 1 ? "" : "s"} · {fmtDur(w.engaged_sec)} · {A(w.earnings)}
                </AppText>
              </View>
              <AppText variant="bodySemi" color={rateColor(w.effective_rate)}>{w.effective_rate == null ? "—" : `${A(w.effective_rate)}/hr`}</AppText>
              <Ionicons name="chevron-forward" size={18} color={colors.dim} style={{ marginLeft: 6 }} />
            </View>
          </Card>
        </Pressable>
      ))}
      <PrimaryButton testID="g-export" label="Export spreadsheet for Uber support" icon="download-outline" onPress={exportXlsx}
        style={{ marginTop: 4, marginBottom: 32 }} />
    </Screen>
  );
}
