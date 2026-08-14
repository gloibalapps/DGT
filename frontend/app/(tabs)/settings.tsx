import React, { useCallback, useState, useEffect } from "react";
import { View, Pressable, ScrollView, Linking } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api } from "@/src/api";
import {
  isAutotrackEnabled, enableAutotrack, disableAutotrack,
} from "@/src/autotrack";
import {
  WORK_TYPES, OWNERSHIP, PLATFORMS, FREQUENCIES, AU_STATES, COUNTRIES,
} from "@/src/config";
import {
  Screen, ScreenHeader, Card, AppText, Spinner, ChipRow, Input, Field,
  PrimaryButton, useToast, DateField,
} from "@/src/ui";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ marginBottom: 18 }}>
      <AppText variant="label" color={colors.dim} style={{ marginBottom: 8, marginLeft: 4 }}>{title.toUpperCase()}</AppText>
      <Card>{children}</Card>
    </View>
  );
}

export default function Settings() {
  const { colors, mode, toggle } = useTheme();
  const { profile, updateProfile, version } = useStore();
  const { show } = useToast();
  const router = useRouter();

  const [bizPct, setBizPct] = useState<number | null>(null);
  const [autoOn, setAutoOn] = useState(false);
  const [name, setName] = useState("");
  const [ownership, setOwnership] = useState("own");
  const [recEnabled, setRecEnabled] = useState(false);
  const [recAmount, setRecAmount] = useState("");
  const [recFreq, setRecFreq] = useState("weekly");
  const [recAnchorType, setRecAnchorType] = useState<"acquisition" | "gigstart">("gigstart");
  const [recAnchorDate, setRecAnchorDate] = useState("");

  useEffect(() => {
    if (!profile) return;
    setName(profile.driver_name || "");
    setOwnership(profile.vehicle_ownership);
    const r = profile.recurring_payment;
    setRecEnabled(!!r);
    setRecAmount(r ? String(r.amount) : "");
    setRecFreq(r?.frequency || "weekly");
    setRecAnchorType(r?.anchor_type || "gigstart");
    setRecAnchorDate(r?.anchor_date || "");
  }, [profile]);

  const loadPct = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const rep = await api.report("year", today);
      setBizPct(rep.business_use_pct);
    } catch { /* ignore */ }
  }, []);
  useFocusEffect(useCallback(() => { loadPct(); isAutotrackEnabled().then(setAutoOn); }, [loadPct, version]));

  const toggleAuto = async () => {
    if (autoOn) {
      await disableAutotrack();
      setAutoOn(false);
      show("Automatic drive detection turned off", "info");
      return;
    }
    const res = await enableAutotrack();
    if (res.ok) {
      setAutoOn(true);
      show("Auto detection on — drives log themselves", "success");
    } else if (res.reason === "unsupported") {
      show("Auto tracking needs a native build — not Expo Go or web preview", "error");
    } else {
      show("Background location permission is required", "error");
      if (res.canAskAgain === false) Linking.openSettings();
    }
  };

  if (!profile) return <Screen><Spinner /></Screen>;

  const ownMeta = OWNERSHIP.find((o) => o.key === ownership);

  const saveVehicle = async () => {
    const rec = recEnabled && recAmount && recAnchorDate
      ? { amount: parseFloat(recAmount), frequency: recFreq as any, anchor_type: recAnchorType, anchor_date: recAnchorDate }
      : null;
    if (recEnabled && !rec) { show("Enter the amount and pick a start date", "error"); return; }
    const p = await updateProfile({ vehicle_ownership: ownership as any, recurring_payment: rec as any });
    if (!p) { show("Couldn't save — try again", "error"); return; }
    show("Vehicle details saved", "success");
  };

  const taxComplete = !!profile.legal_name && (profile.registration_status === "registered" || profile.registration_status === "not_registered");

  return (
    <Screen header={<ScreenHeader subtitle="Configuration" title="Settings" />} scroll>
      {/* Driver */}
      <Section title="Driver">
        <Field label="Your name" hint="Shown on your dashboard">
          <Input testID="set-driver-name" value={name} onChangeText={setName}
            placeholder="e.g. Alex" returnKeyType="done"
            onBlur={() => updateProfile({ driver_name: name.trim() || null })}
            onSubmitEditing={() => updateProfile({ driver_name: name.trim() || null })} />
        </Field>
      </Section>

      {/* Appearance */}
      <Section title="Appearance">
        <Pressable testID="theme-toggle" onPress={toggle}
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name={mode === "dark" ? "moon" : "sunny"} size={20} color={colors.accent} style={{ marginRight: 10 }} />
            <AppText variant="bodyMed">{mode === "dark" ? "Dark" : "Light"} theme</AppText>
          </View>
          <View style={{
            width: 48, height: 28, borderRadius: 999, padding: 3,
            backgroundColor: mode === "dark" ? colors.surfaceAlt : colors.accent,
            alignItems: mode === "dark" ? "flex-start" : "flex-end",
          }}>
            <View style={{ width: 22, height: 22, borderRadius: 999, backgroundColor: "#fff" }} />
          </View>
        </Pressable>
      </Section>

      {/* Automatic drive detection */}
      <Section title="Automatic tracking">
        <Pressable testID="autotrack-toggle" onPress={toggleAuto}
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <AppText variant="bodyMed">Detect drives automatically</AppText>
            <AppText variant="caption" color={colors.dim}>
              Off by default. When on, GigTax logs each drive in the background and asks you to tag it Business or Personal later — no start/stop needed. Requires a native build.
            </AppText>
          </View>
          <View style={{
            width: 48, height: 28, borderRadius: 999, padding: 3,
            backgroundColor: autoOn ? colors.accent : colors.surfaceAlt,
            alignItems: autoOn ? "flex-end" : "flex-start",
          }}>
            <View style={{ width: 22, height: 22, borderRadius: 999, backgroundColor: "#fff" }} />
          </View>
        </Pressable>
      </Section>

      {/* Location */}
      <Section title="Country & region">
        <AppText variant="bodyMed" style={{ marginBottom: 8 }}>
          {COUNTRIES.find((c) => c.code === profile.country)?.name || profile.country}
        </AppText>
        <ChipRow options={AU_STATES.map((s) => ({ key: s, label: s }))} value={profile.region || "NSW"}
          onChange={(r) => updateProfile({ region: r })} testIDPrefix="set-state" />
      </Section>

      {/* Work type */}
      <Section title="Work type">
        {WORK_TYPES.map((w) => {
          const active = w.key === profile.work_type;
          return (
            <Pressable key={w.key} testID={`set-worktype-${w.key}`} onPress={() => updateProfile({ work_type: w.key as any })}
              style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8 }}>
              <Ionicons name={active ? "radio-button-on" : "radio-button-off"} size={20}
                color={active ? colors.accent : colors.dim} style={{ marginRight: 10 }} />
              <AppText variant="bodyMed" style={{ flex: 1 }}>{w.label}</AppText>
            </Pressable>
          );
        })}
      </Section>

      {/* Business use % read only */}
      <Section title="Business-use %">
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1 }}>
            <AppText variant="body" color={colors.dim}>Calculated this financial year (read-only)</AppText>
            <AppText variant="caption" color={colors.dim}>Derived from your tagged trips — a real logbook, not a guess.</AppText>
          </View>
          <AppText style={{ fontFamily: "BarlowCondensed-Bold", fontSize: 34, color: colors.accent, fontVariant: ["tabular-nums"] }}>
            {bizPct == null ? "—" : `${bizPct}%`}
          </AppText>
        </View>
      </Section>

      {/* Vehicle ownership + recurring payment — SAME card */}
      <Section title="Vehicle & recurring payment">
        {OWNERSHIP.map((o) => {
          const active = o.key === ownership;
          return (
            <Pressable key={o.key} testID={`set-ownership-${o.key}`} onPress={() => setOwnership(o.key)}
              style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7 }}>
              <Ionicons name={active ? "radio-button-on" : "radio-button-off"} size={20}
                color={active ? colors.accent : colors.dim} style={{ marginRight: 10 }} />
              <AppText variant="bodyMed" style={{ flex: 1 }}>{o.label}</AppText>
            </Pressable>
          );
        })}
        {ownMeta ? (
          <AppText variant="caption" color={ownMeta.key === "rental" ? colors.warm : colors.dim}
            style={{ marginTop: 6, marginBottom: 10 }}>{ownMeta.note}</AppText>
        ) : null}

        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 8 }} />

        <Pressable testID="set-recurring-toggle" onPress={() => setRecEnabled(!recEnabled)}
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: recEnabled ? 12 : 0 }}>
          <AppText variant="bodyMed">Recurring vehicle payment</AppText>
          <View style={{
            width: 48, height: 28, borderRadius: 999, padding: 3,
            backgroundColor: recEnabled ? colors.accent : colors.surfaceAlt,
            alignItems: recEnabled ? "flex-end" : "flex-start",
          }}>
            <View style={{ width: 22, height: 22, borderRadius: 999, backgroundColor: "#fff" }} />
          </View>
        </Pressable>

        {recEnabled && (
          <View>
            <Field label="Amount per cycle">
              <Input testID="set-rec-amount" value={recAmount} onChangeText={setRecAmount} keyboardType="decimal-pad" placeholder="250" />
            </Field>
            <Field label="Frequency">
              <ChipRow options={FREQUENCIES.map((f) => ({ key: f.key, label: f.label }))} value={recFreq} onChange={setRecFreq} testIDPrefix="set-freq" />
            </Field>
            <Field label="Count from">
              <ChipRow options={[{ key: "gigstart", label: "Gig-work start" }, { key: "acquisition", label: "Vehicle acquisition" }]}
                value={recAnchorType} onChange={(k) => setRecAnchorType(k as any)} testIDPrefix="set-anchor" />
            </Field>
            <Field label="Payment start date">
              <DateField testID="set-rec-anchor" value={recAnchorDate} onChange={setRecAnchorDate} maxToday />
            </Field>
          </View>
        )}
        <PrimaryButton testID="set-vehicle-save" label="Save vehicle details" onPress={saveVehicle} style={{ marginTop: 6 }} />
      </Section>

      {/* Deduction method (AU) */}
      <Section title="Deduction method">
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Ionicons name="lock-closed" size={16} color={colors.dim} style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodyMed">Logbook method</AppText>
            <AppText variant="caption" color={colors.dim}>
              Australia uses the logbook method. Cents-per-km is capped at 5,000 business km/year (88c/km FY25-26, 91c from 1 Jul 2026) — not offered, since full-time drivers exceed the cap in weeks.
            </AppText>
          </View>
        </View>
      </Section>

      {/* Platforms */}
      <Section title="Platforms">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {PLATFORMS.map((p) => {
            const active = profile.platforms.includes(p);
            return (
              <Pressable key={p} testID={`set-platform-${p}`}
                onPress={() => {
                  const next = active ? profile.platforms.filter((x) => x !== p) : [...profile.platforms, p];
                  updateProfile({ platforms: next });
                }}
                style={{
                  paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
                  backgroundColor: active ? colors.accent : colors.surfaceAlt,
                  borderWidth: 1, borderColor: active ? colors.accent : colors.border,
                }}>
                <AppText variant="label" color={active ? colors.bg : colors.dim}>{p}</AppText>
              </Pressable>
            );
          })}
        </View>
      </Section>

      {/* Tax setup */}
      <Pressable testID="set-tax-setup" onPress={() => router.push("/tax-setup" as any)} style={{ marginBottom: 30 }}>
        <Card style={{ flexDirection: "row", alignItems: "center", borderColor: taxComplete ? colors.profit : colors.warm }}>
          <Ionicons name={taxComplete ? "shield-checkmark" : "shield-outline"} size={22}
            color={taxComplete ? colors.profit : colors.warm} style={{ marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodySemi">Tax setup</AppText>
            <AppText variant="caption" color={colors.dim}>
              {taxComplete ? "Complete — registration, method & details on file." : "Add legal name, registration status and more."}
            </AppText>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.dim} />
        </Card>
      </Pressable>
    </Screen>
  );
}
