import React from "react";
import { View, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { AppText, DateField, Input, Select } from "@/src/ui";
import { UEJob, UEType, parseDuration, durationPreview, normTime, missingFields, durToText } from "@/src/ueParse";

/** Editable text form of a job (what the boxes show). */
export interface Draft {
  key: string; id?: string; date: string; time: string; type: UEType; dur: string; amount: string; km: string;
  dup?: boolean; dirty?: boolean;
}

let _k = 0;
export const newKey = () => `d${Date.now()}${_k++}`;

export const toJob = (d: Draft): UEJob => ({
  id: d.id, date: d.date, type: d.type,
  start_time: d.type === "Promotion" ? "" : normTime(d.time),
  duration_sec: d.type === "Promotion" ? 0 : parseDuration(d.dur) || 0,
  amount: d.amount.trim() === "" || isNaN(+d.amount) ? null : Math.round(+d.amount * 100) / 100,
  km: d.km.trim() === "" || isNaN(+d.km) ? null : +d.km,
});

export const fromJob = (j: UEJob): Draft => ({
  key: j.id || newKey(), id: j.id, date: j.date, time: j.start_time || "", type: j.type,
  dur: durToText(j.duration_sec), amount: j.amount == null ? "" : String(j.amount), km: j.km == null ? "" : String(j.km),
});

const TYPES = [
  { key: "DELIVERY", label: "Delivery" },
  { key: "Package", label: "Package" },
  { key: "Promotion", label: "Promotion" },
];

export function UEJobRow({ d, onChange, onDelete, onSave, testID }:
  { d: Draft; onChange: (d: Draft) => void; onDelete: () => void; onSave?: () => void; testID?: string }) {
  const { colors } = useTheme();
  const miss = missingFields(toJob(d));
  const promo = d.type === "Promotion";
  const border = d.dup ? colors.loss : miss.length ? colors.warm : colors.border;
  const set = (patch: Partial<Draft>) => onChange({ ...d, ...patch, dup: false, dirty: true });
  return (
    <View testID={testID} style={{ backgroundColor: colors.surface, borderRadius: 20, borderWidth: d.dup || miss.length ? 2 : 1,
      borderColor: border, padding: 16, marginBottom: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8, gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Select testID={`${testID}-type`} value={d.type} onChange={(k) => set({ type: k as UEType })} options={TYPES} title="Type" />
        </View>
        {d.dup ? (
          <View style={{ backgroundColor: colors.loss, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
            <AppText variant="section" color="#FFFFFF">DUPLICATE</AppText>
          </View>
        ) : null}
        <Pressable testID={`${testID}-delete`} onPress={onDelete} hitSlop={8}
          style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="trash-outline" size={20} color={colors.dim} />
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Date</AppText>
          <DateField testID={`${testID}-date`} value={d.date} onChange={(v) => set({ date: v })} />
        </View>
        {!promo ? (
          <View style={{ flex: 1 }}>
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Start</AppText>
            <Input testID={`${testID}-time`} value={d.time} onChangeText={(v) => set({ time: v })}
              onBlur={() => { const n = normTime(d.time); if (n) onChange({ ...d, time: n }); }} placeholder="12:03 PM" />
          </View>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        {!promo ? (
          <View style={{ flex: 1.6 }}>
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Duration</AppText>
            <Input testID={`${testID}-dur`} value={d.dur} onChangeText={(v) => set({ dur: v })} placeholder="38m 36s" />
            <AppText testID={`${testID}-dur-preview`} variant="caption"
              color={durationPreview(d.dur) === "Not recognised" ? colors.loss : colors.dim} style={{ marginTop: 2 }}>
              {durationPreview(d.dur) || " "}
            </AppText>
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Amount A$</AppText>
          <Input testID={`${testID}-amount`} value={d.amount} onChangeText={(v) => set({ amount: v })} keyboardType="decimal-pad" placeholder="24.59" />
        </View>
        {!promo ? (
          <View style={{ flex: 0.8 }}>
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 4 }}>Km</AppText>
            <Input testID={`${testID}-km`} value={d.km} onChangeText={(v) => set({ km: v })} keyboardType="decimal-pad" placeholder="opt." />
          </View>
        ) : null}
      </View>
      {miss.length ? (
        <AppText testID={`${testID}-missing`} variant="caption" color={colors.warm} style={{ marginTop: 6 }}>Please fill in: {miss.join(", ")}</AppText>
      ) : null}
      {onSave && d.dirty && !miss.length ? (
        <Pressable testID={`${testID}-save`} onPress={onSave} style={{ minHeight: 44, justifyContent: "center", alignItems: "flex-end" }}>
          <AppText variant="bodySemi" color={colors.accent}>Save changes</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
