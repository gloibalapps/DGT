import React, { useState } from "react";
import { View, ScrollView, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";

import { useTheme, FONT } from "@/src/theme";
import { useStore } from "@/src/store";
import { AppText, Card, PrimaryButton, Input, Field, ChipRow } from "@/src/ui";
import { COUNTRIES, AU_STATES, WORK_TYPES, PLATFORMS, OWNERSHIP, FREQUENCIES } from "@/src/config";
import { todayISO } from "@/src/api";
import { isValidDate } from "@/src/date";

export default function Onboarding() {
  const { colors } = useTheme();
  const { updateProfile } = useStore();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  const [country, setCountry] = useState("AU");
  const [region, setRegion] = useState("NSW");
  const [workType, setWorkType] = useState<string>("");
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [ownership, setOwnership] = useState<string>("");
  const [acqDate, setAcqDate] = useState("");
  const [recEnabled, setRecEnabled] = useState(false);
  const [recAmount, setRecAmount] = useState("");
  const [recFreq, setRecFreq] = useState("weekly");
  const [recAnchorType, setRecAnchorType] = useState<"acquisition" | "gigstart">("gigstart");
  const [recAnchorDate, setRecAnchorDate] = useState(todayISO());

  const total = 5;

  const canNext = () => {
    if (step === 0) return !!country && !!region;
    if (step === 1) return !!workType;
    if (step === 2) return platforms.length >= 1;
    if (step === 3) return !!ownership;
    return true;
  };

  const togglePlatform = (p: string) =>
    setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const finish = async () => {
    setSaving(true);
    const rec = recEnabled && recAmount && isValidDate(recAnchorDate)
      ? {
          amount: parseFloat(recAmount),
          frequency: recFreq as any,
          anchor_type: recAnchorType,
          anchor_date: recAnchorType === "acquisition" && isValidDate(acqDate) ? acqDate : recAnchorDate,
        }
      : null;
    await updateProfile({
      country, region, work_type: workType as any, platforms,
      vehicle_ownership: ownership as any,
      acquisition_date: isValidDate(acqDate) ? acqDate : null,
      recurring_payment: rec as any,
      onboarded: true,
    });
    router.replace("/(tabs)/home" as any);
  };

  const next = () => {
    if (step < total - 1) setStep(step + 1);
    else finish();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        {/* route-line progress signature */}
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <View style={{ height: 4, backgroundColor: colors.surfaceAlt, borderRadius: 999, overflow: "hidden" }}>
            <LinearGradient colors={colors.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={{ height: 4, width: `${((step + 1) / total) * 100}%` }} />
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 10 }}>
            <AppText variant="label" color={colors.dim}>Step {step + 1} of {total}</AppText>
            {step > 0 ? (
              <Pressable testID="onboarding-back" onPress={() => setStep(step - 1)}>
                <AppText variant="label" color={colors.accent}>Back</AppText>
              </Pressable>
            ) : (
              <AppText variant="label" color={colors.accent}>Drive. Track. Done.</AppText>
            )}
          </View>
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 20 }} showsVerticalScrollIndicator={false}>
          {step === 0 && (
            <View>
              <AppText variant="displaySemi" style={{ fontSize: 28, marginBottom: 4 }}>Where do you drive?</AppText>
              <AppText variant="body" color={colors.dim} style={{ marginBottom: 20 }}>
                Tax rules differ by country. Australia is fully supported today.
              </AppText>
              {COUNTRIES.map((c) => {
                const active = c.code === country;
                return (
                  <Pressable key={c.code} testID={`country-${c.code}`}
                    disabled={!c.active}
                    onPress={() => { setCountry(c.code); }}
                    style={{ marginBottom: 10, opacity: c.active ? 1 : 0.4 }}>
                    <Card style={{ borderColor: active ? colors.accent : colors.border, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                      <View>
                        <AppText variant="bodySemi">{c.name}</AppText>
                        <AppText variant="caption" color={colors.dim}>{c.currency} · {c.distanceUnit}{c.active ? "" : " · coming soon"}</AppText>
                      </View>
                      {active ? <Ionicons name="checkmark-circle" size={22} color={colors.accent} /> : null}
                    </Card>
                  </Pressable>
                );
              })}
              {country === "AU" && (
                <View style={{ marginTop: 14 }}>
                  <AppText variant="label" color={colors.dim} style={{ marginBottom: 8 }}>State / Territory</AppText>
                  <ChipRow options={AU_STATES.map((s) => ({ key: s, label: s }))} value={region}
                    onChange={setRegion} testIDPrefix="state" />
                </View>
              )}
            </View>
          )}

          {step === 1 && (
            <View>
              <AppText variant="displaySemi" style={{ fontSize: 28, marginBottom: 4 }}>What kind of driving?</AppText>
              <AppText variant="body" color={colors.dim} style={{ marginBottom: 20 }}>
                This is the single most important answer — it decides your GST obligations.
              </AppText>
              {WORK_TYPES.map((w) => {
                const active = w.key === workType;
                return (
                  <Pressable key={w.key} testID={`worktype-${w.key}`} onPress={() => setWorkType(w.key)} style={{ marginBottom: 10 }}>
                    <Card style={{ borderColor: active ? colors.accent : colors.border, flexDirection: "row", alignItems: "flex-start" }}>
                      <Ionicons name={w.icon as any} size={24} color={active ? colors.accent : colors.dim} style={{ marginRight: 12, marginTop: 2 }} />
                      <View style={{ flex: 1 }}>
                        <AppText variant="bodySemi">{w.label}</AppText>
                        <AppText variant="caption" color={colors.dim} style={{ marginTop: 3 }}>{w.hint}</AppText>
                      </View>
                      {active ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
                    </Card>
                  </Pressable>
                );
              })}
            </View>
          )}

          {step === 2 && (
            <View>
              <AppText variant="displaySemi" style={{ fontSize: 28, marginBottom: 4 }}>Which platforms?</AppText>
              <AppText variant="body" color={colors.dim} style={{ marginBottom: 20 }}>
                Pick all you drive for. Speeds up logging income later.
              </AppText>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                {PLATFORMS.map((p) => {
                  const active = platforms.includes(p);
                  return (
                    <Pressable key={p} testID={`platform-${p}`} onPress={() => togglePlatform(p)}
                      style={{
                        paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12,
                        backgroundColor: active ? colors.accent : colors.surface,
                        borderWidth: 1, borderColor: active ? colors.accent : colors.border,
                      }}>
                      <AppText variant="bodyMed" color={active ? colors.bg : colors.text}>{p}</AppText>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {step === 3 && (
            <View>
              <AppText variant="displaySemi" style={{ fontSize: 28, marginBottom: 4 }}>Your vehicle</AppText>
              <AppText variant="body" color={colors.dim} style={{ marginBottom: 20 }}>
                Ownership changes what you can claim.
              </AppText>
              {OWNERSHIP.map((o) => {
                const active = o.key === ownership;
                return (
                  <Pressable key={o.key} testID={`ownership-${o.key}`} onPress={() => setOwnership(o.key)} style={{ marginBottom: 10 }}>
                    <Card style={{ borderColor: active ? colors.accent : colors.border }}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                        <AppText variant="bodySemi">{o.label}</AppText>
                        {active ? <Ionicons name="checkmark-circle" size={20} color={colors.accent} /> : null}
                      </View>
                      {active ? (
                        <AppText variant="caption" color={o.key === "rental" ? colors.warm : colors.dim} style={{ marginTop: 6 }}>{o.note}</AppText>
                      ) : null}
                    </Card>
                  </Pressable>
                );
              })}
              <Field label="Vehicle acquisition date (optional)" hint="Format YYYY-MM-DD">
                <Input testID="acq-date" value={acqDate} onChangeText={setAcqDate}
                  placeholder="2025-07-01" keyboardType="numbers-and-punctuation" />
              </Field>
            </View>
          )}

          {step === 4 && (
            <View>
              <AppText variant="displaySemi" style={{ fontSize: 28, marginBottom: 4 }}>Recurring payment</AppText>
              <AppText variant="body" color={colors.dim} style={{ marginBottom: 20 }}>
                Lease, rental or loan? We calculate what's owed automatically. Optional — you can skip.
              </AppText>
              <Pressable testID="recurring-toggle" onPress={() => setRecEnabled(!recEnabled)}>
                <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <AppText variant="bodySemi">I have a recurring vehicle payment</AppText>
                  <View style={{
                    width: 48, height: 28, borderRadius: 999, padding: 3,
                    backgroundColor: recEnabled ? colors.accent : colors.surfaceAlt,
                    alignItems: recEnabled ? "flex-end" : "flex-start",
                  }}>
                    <View style={{ width: 22, height: 22, borderRadius: 999, backgroundColor: "#fff" }} />
                  </View>
                </Card>
              </Pressable>
              {recEnabled && (
                <View>
                  <Field label="Amount per cycle">
                    <Input testID="rec-amount" value={recAmount} onChangeText={setRecAmount}
                      placeholder="250" keyboardType="decimal-pad" />
                  </Field>
                  <Field label="Frequency">
                    <ChipRow options={FREQUENCIES.map((f) => ({ key: f.key, label: f.label }))}
                      value={recFreq} onChange={setRecFreq} testIDPrefix="freq" />
                  </Field>
                  <Field label="Count from">
                    <ChipRow
                      options={[{ key: "gigstart", label: "Gig-work start" }, { key: "acquisition", label: "Vehicle acquisition" }]}
                      value={recAnchorType} onChange={(k) => setRecAnchorType(k as any)} testIDPrefix="anchor" />
                  </Field>
                  <Field label="Anchor date" hint="Format YYYY-MM-DD">
                    <Input testID="rec-anchor-date" value={recAnchorDate} onChangeText={setRecAnchorDate}
                      placeholder="2026-01-01" keyboardType="numbers-and-punctuation" />
                  </Field>
                </View>
              )}
            </View>
          )}
        </ScrollView>

        <SafeAreaView edges={["bottom"]} style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <PrimaryButton testID="onboarding-next" label={step === total - 1 ? (saving ? "Setting up…" : "Start driving") : "Continue"}
            onPress={next} disabled={!canNext() || saving} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}
