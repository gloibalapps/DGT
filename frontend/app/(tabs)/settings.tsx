import React, { useCallback, useState, useEffect } from "react";
import { View, Pressable, ScrollView, Linking } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { useAuth } from "@/src/auth";
import { useSubscription } from "@/src/subscription";
import { api } from "@/src/api";
import {
  isAutotrackEnabled, enableAutotrack, disableAutotrack,
} from "@/src/autotrack";
import {
  WORK_TYPES, platformsForWorkType, AU_STATES, US_STATES, US_NO_INCOME_TAX_STATES, COUNTRIES, flagUrl,
} from "@/src/config";
import {
  Screen, ScreenHeader, Card, AppText, Spinner, ChipRow, Input, Field,
  PrimaryButton, useToast,
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
  const { profile, updateProfile, version, vehicles, activeVehicleId, setActiveVehicle } = useStore();
  const { user, signOut } = useAuth();
  const { isActive: subActive } = useSubscription();
  const { show } = useToast();
  const router = useRouter();

  const [bizPct, setBizPct] = useState<number | null>(null);
  const [autoOn, setAutoOn] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (!profile) return;
    setName(profile.driver_name || "");
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

  const taxComplete = !!profile.legal_name && (profile.registration_status === "registered" || profile.registration_status === "not_registered");

  return (
    <Screen header={<ScreenHeader subtitle="Configuration" title="Settings" />} scroll>
      {/* Account */}
      {user ? (
        <Section title="Account">
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {user.picture ? (
              <Image source={{ uri: user.picture }} style={{ width: 44, height: 44, borderRadius: 22, marginRight: 12 }} contentFit="cover" />
            ) : (
              <View style={{ width: 44, height: 44, borderRadius: 22, marginRight: 12, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="person" size={22} color={colors.dim} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <AppText variant="bodySemi">{user.name || "Signed in"}</AppText>
              <AppText variant="caption" color={colors.dim}>{user.email}</AppText>
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
            <Ionicons name="cloud-done-outline" size={15} color={colors.profit} style={{ marginRight: 6 }} />
            <AppText variant="caption" color={colors.dim}>Your data syncs securely across your phones.</AppText>
          </View>
          <Pressable testID="set-signout" onPress={signOut}
            style={{ marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "center",
              paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}>
            <Ionicons name="log-out-outline" size={18} color={colors.loss} style={{ marginRight: 8 }} />
            <AppText variant="bodySemi" color={colors.loss}>Sign out</AppText>
          </Pressable>
        </Section>
      ) : null}

      {/* Subscription */}
      <Section title="Subscription">
        <Pressable testID="set-subscription" onPress={() => router.push("/paywall" as any)}
          style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
            alignItems: "center", justifyContent: "center", marginRight: 12 }}>
            <Ionicons name="rocket" size={20} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="bodySemi">{subActive ? "GigTax Pro" : "Upgrade to GigTax Pro"}</AppText>
            <AppText variant="caption" color={colors.dim}>
              {subActive ? "Your subscription is active" : "7-day free trial · monthly or yearly"}
            </AppText>
          </View>
          {subActive ? (
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.profit }}>
              <AppText variant="caption" color={colors.bg} style={{ fontWeight: "700" }}>ACTIVE</AppText>
            </View>
          ) : (
            <Ionicons name="chevron-forward" size={20} color={colors.dim} />
          )}
        </Pressable>
      </Section>

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

      {/* Country & region */}
      <Section title="Country">
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 10 }}>
          Tax rules differ by country. Switching updates your reports, mileage rates and currency.
        </AppText>
        {COUNTRIES.map((c) => {
          const active = c.code === profile.country;
          return (
            <Pressable key={c.code} testID={`set-country-${c.code}`}
              disabled={!c.active}
              onPress={() => {
                if (c.code === profile.country) return;
                updateProfile({ country: c.code as any, region: c.code === "AU" ? (profile.region || "NSW") : (c.code === "US" ? (profile.region || "CA") : null) } as any);
                show(`Switched to ${c.name}`, "success");
              }}
              style={{ marginBottom: 8, opacity: c.active ? 1 : 0.4 }}>
              <View style={{
                flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 10,
                borderWidth: 1, borderColor: active ? colors.accent : colors.border,
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
                  <Image source={{ uri: flagUrl(c.code, 160) }}
                    style={{ width: 40, height: 27, borderRadius: 5, marginRight: 12, borderWidth: 1, borderColor: colors.border }}
                    contentFit="cover" />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySemi">{c.name}</AppText>
                    <AppText variant="caption" color={colors.dim}>{c.currency} · {c.distanceUnit}{c.active ? "" : " · coming soon"}</AppText>
                  </View>
                </View>
                {active ? <Ionicons name="checkmark-circle" size={22} color={colors.accent} /> : null}
              </View>
            </Pressable>
          );
        })}
        {profile.country === "AU" ? (
          <View style={{ marginTop: 8 }}>
            <AppText variant="label" color={colors.dim} style={{ marginBottom: 8 }}>STATE / TERRITORY</AppText>
            <ChipRow options={AU_STATES.map((s) => ({ key: s, label: s }))} value={profile.region || "NSW"}
              onChange={(r) => updateProfile({ region: r })} testIDPrefix="set-state" />
          </View>
        ) : null}
        {profile.country === "US" ? (
          <View style={{ marginTop: 8 }}>
            <AppText variant="label" color={colors.dim} style={{ marginBottom: 8 }}>STATE</AppText>
            <ChipRow options={US_STATES.map((s) => ({ key: s, label: s }))} value={profile.region || "CA"}
              onChange={(r) => updateProfile({ region: r })} testIDPrefix="set-usstate" />
            <AppText variant="caption" color={colors.dim} style={{ marginTop: 8 }}>
              {US_NO_INCOME_TAX_STATES.includes(profile.region || "")
                ? `${profile.region} has no state income tax. Reports estimate federal tax only.`
                : "Used for future state income-tax guidance. Reports currently estimate federal tax only."}
            </AppText>
          </View>
        ) : null}
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

      {/* Vehicles — manage all cars here */}
      <Section title="Vehicles">
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>
          Add each car you drive for. Trips, expenses, odometer and recurring payments are tracked per vehicle.
        </AppText>
        {vehicles.map((v) => {
          const active = v.id === activeVehicleId;
          const label = v.registration || v.make_model || "Vehicle";
          const sub = v.registration && v.make_model ? v.make_model : "Tap to add rego, model & odometer";
          return (
            <View key={v.id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10,
              borderTopWidth: 1, borderTopColor: colors.border }}>
              <Pressable testID={`set-vehicle-${v.id}`} onPress={() => router.push(`/vehicle?id=${v.id}` as any)}
                style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
                  alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                  <Ionicons name="car-sport" size={20} color={colors.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySemi">{label}</AppText>
                  <AppText variant="caption" color={colors.dim}>{sub}</AppText>
                </View>
              </Pressable>
              {active ? (
                <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.profit }}>
                  <AppText variant="caption" color={colors.bg} style={{ fontWeight: "700" }}>ACTIVE</AppText>
                </View>
              ) : (
                <Pressable testID={`set-vehicle-activate-${v.id}`} onPress={() => v.id && setActiveVehicle(v.id)} hitSlop={8}>
                  <AppText variant="caption" color={colors.accent}>Set active</AppText>
                </Pressable>
              )}
            </View>
          );
        })}
        <PrimaryButton testID="set-add-vehicle" label="Add vehicle" icon="add" onPress={() => router.push("/vehicle" as any)} style={{ marginTop: 12 }} />
      </Section>

      {/* Deduction method */}
      <Section title="Deduction method">
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Ionicons name={profile.country === "US" ? "git-compare" : "lock-closed"} size={16} color={colors.dim} style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodyMed">{profile.country === "US" ? "Standard mileage vs actual" : "Logbook method"}</AppText>
            <AppText variant="caption" color={colors.dim}>
              {profile.country === "US"
                ? "United States — GigTax compares the IRS standard mileage rate (72.5¢/mi Jan–Jun 2026, 76¢ from 1 Jul) against your actual expenses and recommends the larger deduction on Schedule C."
                : "Australia uses the logbook method. Cents-per-km is capped at 5,000 business km/year (88c/km FY25-26, 91c from 1 Jul 2026) — not offered, since full-time drivers exceed the cap in weeks."}
            </AppText>
          </View>
        </View>
      </Section>

      {/* Work type */}
      <Section title="Work type">
        {WORK_TYPES.map((w) => {
          const active = w.key === profile.work_type;
          return (
            <Pressable key={w.key} testID={`set-worktype-${w.key}`} onPress={() => {
                const allowed = platformsForWorkType(w.key).map((p) => p.name);
                updateProfile({
                  work_type: w.key as any,
                  platforms: profile.platforms.filter((p) => allowed.includes(p)),
                });
              }}
              style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8 }}>
              <Ionicons name={active ? "radio-button-on" : "radio-button-off"} size={20}
                color={active ? colors.accent : colors.dim} style={{ marginRight: 10 }} />
              <AppText variant="bodyMed" style={{ flex: 1 }}>{w.label}</AppText>
            </Pressable>
          );
        })}
      </Section>

      {/* Platforms */}
      <Section title="Platforms">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {platformsForWorkType(profile.work_type).map((p) => {
            const active = profile.platforms.includes(p.name);
            return (
              <Pressable key={p.name} testID={`set-platform-${p.name}`}
                onPress={() => {
                  const next = active ? profile.platforms.filter((x) => x !== p.name) : [...profile.platforms, p.name];
                  updateProfile({ platforms: next });
                }}
                style={{
                  paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
                  backgroundColor: active ? colors.accent : colors.surfaceAlt,
                  borderWidth: 1, borderColor: active ? colors.accent : colors.border,
                }}>
                <AppText variant="label" color={active ? colors.bg : colors.dim}>{p.name}</AppText>
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
