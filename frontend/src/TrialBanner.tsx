import React from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/src/theme";
import { AppText } from "@/src/ui";
import { useSubscription } from "@/src/subscription";

// Thin banner above the tabs: days left in the 14-day trial (last 7 days, or
// always when expired = read-only). Tapping opens the paywall.
export default function TrialBanner() {
  const { server, isActive, expired } = useSubscription();
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  if (!server || isActive || server.is_demo) return null;
  let text: string | null = null;
  if (expired) text = "Trial ended — read-only. Tap to subscribe.";
  else if (server.state === "trial" && server.days_left != null && server.days_left <= 7)
    text = `${server.days_left} day${server.days_left === 1 ? "" : "s"} left in your free trial`;
  if (!text) return null;
  return (
    <Pressable testID="trial-banner" onPress={() => router.push("/paywall" as any)}
      style={{ paddingTop: insets.top + 6, paddingBottom: 8, paddingHorizontal: 16,
        backgroundColor: expired ? colors.surfaceAlt : colors.accent }}>
      <View style={{ alignItems: "center" }}>
        <AppText variant="caption" color={expired ? colors.text : "#FFFFFF"}>{text}</AppText>
      </View>
    </Pressable>
  );
}
