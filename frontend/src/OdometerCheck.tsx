import React, { useEffect, useState } from "react";
import { View } from "react-native";

import { useTheme } from "@/src/theme";
import { api, TripT, VehicleT, todayISO } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { AppText, Card, Field, Input, PrimaryButton, SectionLabel, useToast } from "@/src/ui";

/**
 * Day odometer check: the driver types the odometer at the start and end of a
 * shift; we compare it with the GPS km the app logged today for this car and,
 * on save, re-calibrate the car so future GPS drives match the odometer.
 * Already-logged trips are left untouched.
 */
export function OdometerCheck({ vehicle, trips, unit, onCalibrated }:
  { vehicle: VehicleT; trips: TripT[]; unit: string; onCalibrated: () => Promise<void> | void }) {
  const { colors } = useTheme();
  const { show } = useToast();
  const date = todayISO();
  const key = `gigtax.odocheck.${vehicle.id}.${date}`;
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [saving, setSaving] = useState(false);
  // "start|end" of the readings already used for a correction — today's trips
  // were logged at the old calibration, so re-applying would compound it.
  const [applied, setApplied] = useState("");

  useEffect(() => {
    storage.getItem<string>(key, "")
      .then((raw) => { const v = raw ? JSON.parse(raw) : null; setStart(v?.start || ""); setEnd(v?.end || ""); setApplied(v?.applied || ""); })
      .catch(() => {});
  }, [key]);
  const persist = (s: string, e: string, a = applied) => { storage.setItem(key, JSON.stringify({ start: s, end: e, applied: a })); };

  const gpsKm = Math.round(trips
    .filter((t) => t.date === date && t.source === "gps" && t.vehicle_id === vehicle.id)
    .reduce((s, t) => s + (t.distance_km || 0), 0) * 10) / 10;
  const s = parseFloat(start), e = parseFloat(end);
  const odoKm = !isNaN(s) && !isNaN(e) && e > s ? Math.round((e - s) * 10) / 10 : null;
  const diffPct = odoKm != null && gpsKm > 0 ? Math.round(((gpsKm - odoKm) / odoKm) * 1000) / 10 : null;
  const curCal = vehicle.gps_calibration_pct || 100;
  const newCal = odoKm != null && gpsKm > 0
    ? Math.min(150, Math.max(50, Math.round(curCal * (odoKm / gpsKm) * 10) / 10)) : null;
  const readingKey = `${start}|${end}`;
  const alreadyApplied = applied !== "" && applied === readingKey;
  const canCorrect = !alreadyApplied && newCal != null && gpsKm >= 5 && Math.abs(diffPct || 0) >= 1;

  const correct = async () => {
    if (!canCorrect || !vehicle.id || newCal == null) return;
    setSaving(true);
    try {
      await api.updateVehicle(vehicle.id, { gps_calibration_pct: newCal });
      setApplied(readingKey); persist(start, end, readingKey);
      await onCalibrated();
      show(`${vehicle.make_model || vehicle.registration || "Car"} GPS corrected to ${newCal}% for future drives`, "success");
    } catch { show("Couldn't save the correction — try again", "error"); }
    finally { setSaving(false); }
  };

  const diffColor = diffPct == null ? colors.text : Math.abs(diffPct) <= 3 ? colors.profit : colors.loss;

  return (
    <View testID="odo-day-check" style={{ marginBottom: 16 }}>
      <SectionLabel text="Day odometer check" style={{ marginLeft: 4 }} />
      <Card>
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12, lineHeight: 18 }}>
          Type your odometer at the start and end of today&apos;s shift to see how close the GPS is.
        </AppText>
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Field label="Start odometer">
              <Input testID="odo-start" value={start} keyboardType="decimal-pad" placeholder="e.g. 42150"
                onChangeText={(v) => { setStart(v); persist(v, end); }} />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="End odometer">
              <Input testID="odo-end" value={end} keyboardType="decimal-pad" placeholder="e.g. 42400"
                onChangeText={(v) => { setEnd(v); persist(start, v); }} />
            </Field>
          </View>
        </View>
        {[
          ["Odometer", odoKm != null ? `${odoKm} ${unit}` : "—"],
          ["App GPS today", `${gpsKm} ${unit}`],
        ].map(([l, v], i) => (
          <View key={l} style={{ flexDirection: "row", justifyContent: "space-between", minHeight: 44, alignItems: "center",
            borderTopWidth: i === 0 ? 0 : 1, borderTopColor: colors.divider }}>
            <AppText variant="body" color={colors.rowLabel}>{l}</AppText>
            <AppText variant="bodySemi" style={{ fontVariant: ["tabular-nums"] }}>{v}</AppText>
          </View>
        ))}
        <View style={{ flexDirection: "row", justifyContent: "space-between", minHeight: 44, alignItems: "center",
          borderTopWidth: 1, borderTopColor: colors.divider }}>
          <AppText variant="bodySemi">Difference</AppText>
          <AppText testID="odo-diff" variant="bodySemi" color={diffColor} style={{ fontVariant: ["tabular-nums"] }}>
            {diffPct == null ? "—" : `${diffPct > 0 ? "+" : ""}${diffPct}%`}
          </AppText>
        </View>
        {odoKm != null && gpsKm === 0 ? (
          <AppText variant="caption" color={colors.dim} style={{ marginTop: 4 }}>
            No GPS drives logged today for this car yet.
          </AppText>
        ) : null}
        {alreadyApplied ? (
          <AppText testID="odo-applied" variant="caption" color={colors.profit} style={{ marginTop: 4 }}>
            Corrected to {curCal}% — future GPS drives in this car will match your odometer.
          </AppText>
        ) : canCorrect ? (
          <PrimaryButton testID="odo-correct" style={{ marginTop: 12 }} disabled={saving}
            label={saving ? "Saving…" : `Correct future drives (${curCal}% → ${newCal}%)`} onPress={correct} />
        ) : diffPct != null && gpsKm >= 5 ? (
          <AppText variant="caption" color={colors.profit} style={{ marginTop: 4 }}>GPS matches your odometer — no correction needed.</AppText>
        ) : null}
      </Card>
    </View>
  );
}
