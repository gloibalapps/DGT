import React, { useMemo, useState } from "react";
import { View, ScrollView, Pressable, ActivityIndicator, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";

import { useTheme } from "@/src/theme";
import { useAuth } from "@/src/auth";
import { AppText, PrimaryButton, useToast } from "@/src/ui";
import { useSubscription, Plan } from "@/src/subscription";

const FEATURES = [
  { icon: "car-sport", text: "Unlimited vehicles & logbooks" },
  { icon: "document-text", text: "BAS, Schedule C & CSV tax reports" },
  { icon: "scan", text: "AI receipt scanning" },
  { icon: "cash", text: "Live tax-savings estimates" },
  { icon: "cloud-done", text: "Secure cloud sync across your phones" },
];

// Shown only when RevenueCat isn't running (web preview / Expo Go / keys not set).
const FALLBACK_PLANS: Plan[] = [
  { id: "yearly", title: "Yearly", price: "$99.99", period: "year", trial: true, pkg: null },
  { id: "monthly", title: "Monthly", price: "$19.99", period: "month", trial: true, pkg: null },
];

function parsePrice(s: string): number | null {
  const m = (s || "").replace(/,/g, "").match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

export default function PaywallScreen({ gate = false }: { gate?: boolean }) {
  const { colors } = useTheme();
  const { signOut } = useAuth();
  const toast = useToast();
  const { plans, isActive, managed, restore, presentPaywall } = useSubscription();

  const list = useMemo<Plan[]>(() => {
    const src = plans.length ? [...plans] : FALLBACK_PLANS;
    // Yearly first (recommended).
    return src.sort((a, b) => (a.period === "year" ? -1 : 1));
  }, [plans]);

  const [selectedId, setSelectedId] = useState<string>(
    () => (list.find((p) => p.period === "year") || list[0])?.id
  );
  const [busy, setBusy] = useState(false);

  const selected = list.find((p) => p.id === selectedId) || list[0];

  const savings = useMemo(() => {
    const y = list.find((p) => p.period === "year");
    const m = list.find((p) => p.period === "month");
    const yv = y && parsePrice(y.price);
    const mv = m && parsePrice(m.price);
    if (!yv || !mv) return null;
    const pct = Math.round((1 - yv / (mv * 12)) * 100);
    return pct > 0 ? pct : null;
  }, [list]);

  async function onSubscribe() {
    // In a real native build, show RevenueCat's remote-configured paywall so
    // pricing, trials and layout are managed from the dashboard.
    if (managed) {
      setBusy(true);
      const ok = await presentPaywall();
      setBusy(false);
      if (!ok) toast.show("Purchase didn't complete. Please try again.");
      return;
    }
    // Preview / Expo Go / web — RevenueCat isn't running.
    toast.show("Subscriptions activate once the app is published to the App Store / Google Play.");
  }

  async function onRestore() {
    if (!managed) { toast.show("Restore works in the published app."); return; }
    setBusy(true);
    const ok = await restore();
    setBusy(false);
    toast.show(ok ? "Subscription restored." : "No active subscription found.");
  }

  const cta = selected?.trial ? "Start 7-day free trial" : "Subscribe";
  const priceLine = selected
    ? (selected.trial
        ? `7 days free, then ${selected.price}/${selected.period}. Cancel anytime.`
        : `${selected.price}/${selected.period}. Cancel anytime.`)
    : "";

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={{ padding: 24, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
          {/* Header */}
          <View style={{ alignItems: "center", marginTop: gate ? 8 : 0 }}>
            <View style={{ width: 72, height: 72, borderRadius: 20, backgroundColor: colors.accent,
              alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
              <Ionicons name="rocket" size={38} color={colors.bg} />
            </View>
            <AppText style={{ fontFamily: "BarlowCondensed-Bold", fontSize: 38, color: colors.text }}>
              GigTax Pro
            </AppText>
            <AppText variant="body" color={colors.dim} style={{ textAlign: "center", marginTop: 6, maxWidth: 300, lineHeight: 21 }}>
              Everything you need to track income, mileage and tax — in one place.
            </AppText>
          </View>

          {isActive ? (
            <View style={{ marginTop: 24, padding: 16, borderRadius: 16, backgroundColor: colors.surface,
              borderWidth: 1, borderColor: colors.profit, flexDirection: "row", alignItems: "center" }}>
              <Ionicons name="checkmark-circle" size={22} color={colors.profit} style={{ marginRight: 10 }} />
              <AppText variant="bodySemi" color={colors.text}>You're subscribed to GigTax Pro.</AppText>
            </View>
          ) : null}

          {/* Features */}
          <View style={{ marginTop: 24, gap: 12 }}>
            {FEATURES.map((f) => (
              <View key={f.text} style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: colors.surfaceAlt,
                  alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                  <Ionicons name={f.icon as any} size={18} color={colors.accent} />
                </View>
                <AppText variant="bodyMed" color={colors.text} style={{ flex: 1 }}>{f.text}</AppText>
              </View>
            ))}
          </View>

          {/* Plans */}
          <View style={{ marginTop: 24, gap: 12 }}>
            {list.map((p) => {
              const active = p.id === selectedId;
              const isYear = p.period === "year";
              return (
                <Pressable key={p.id} testID={`plan-${p.period}`} onPress={() => setSelectedId(p.id)}
                  style={{ borderRadius: 16, borderWidth: 2, padding: 16,
                    borderColor: active ? colors.accent : colors.border,
                    backgroundColor: active ? colors.surfaceAlt : colors.surface }}>
                  <View style={{ flexDirection: "row", alignItems: "center" }}>
                    <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, marginRight: 12,
                      borderColor: active ? colors.accent : colors.dim, alignItems: "center", justifyContent: "center" }}>
                      {active ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent }} /> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center" }}>
                        <AppText variant="bodySemi" color={colors.text}>{p.title}</AppText>
                        {isYear && savings ? (
                          <View style={{ marginLeft: 8, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.profit }}>
                            <AppText variant="caption" color={colors.bg} style={{ fontWeight: "700" }}>SAVE {savings}%</AppText>
                          </View>
                        ) : null}
                      </View>
                      {p.trial ? (
                        <AppText variant="caption" color={colors.dim} style={{ marginTop: 2 }}>7-day free trial included</AppText>
                      ) : null}
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <AppText variant="bodySemi" color={colors.text}>{p.price}</AppText>
                      <AppText variant="caption" color={colors.dim}>per {p.period}</AppText>
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* CTA */}
          <View style={{ marginTop: 20 }}>
            {busy ? (
              <View style={{ height: 52, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : (
              <PrimaryButton testID="paywall-subscribe" label={cta} icon="sparkles" onPress={onSubscribe} />
            )}
            <AppText variant="caption" color={colors.dim} style={{ textAlign: "center", marginTop: 10, lineHeight: 16 }}>
              {priceLine}
            </AppText>
          </View>

          {/* Secondary actions */}
          <View style={{ marginTop: 18, alignItems: "center", gap: 14 }}>
            <Pressable testID="paywall-restore" onPress={onRestore} hitSlop={8}>
              <AppText variant="bodyMed" color={colors.accent}>Restore purchases</AppText>
            </Pressable>

            <View style={{ flexDirection: "row", gap: 18 }}>
              <Pressable onPress={() => Linking.openURL("https://gigtax.app/terms")} hitSlop={6}>
                <AppText variant="caption" color={colors.dim}>Terms</AppText>
              </Pressable>
              <Pressable onPress={() => Linking.openURL("https://gigtax.app/privacy")} hitSlop={6}>
                <AppText variant="caption" color={colors.dim}>Privacy</AppText>
              </Pressable>
            </View>

            <AppText variant="caption" color={colors.dim} style={{ textAlign: "center", marginTop: 4, lineHeight: 15, maxWidth: 320 }}>
              Payment is charged to your {Platform.OS === "ios" ? "Apple ID" : "Google Play account"} at confirmation.
              Auto-renews unless cancelled at least 24 hours before the period ends. Manage in your store account settings.
            </AppText>

            {gate ? (
              <Pressable testID="paywall-signout" onPress={signOut} hitSlop={8} style={{ marginTop: 6 }}>
                <AppText variant="caption" color={colors.dim}>Sign out</AppText>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
