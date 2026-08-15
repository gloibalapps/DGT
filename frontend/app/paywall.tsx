import React from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/src/theme";
import PaywallScreen from "@/src/PaywallScreen";

export default function Paywall() {
  const router = useRouter();
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PaywallScreen />
      <Pressable testID="paywall-close" onPress={() => router.back()} hitSlop={10}
        style={{ position: "absolute", top: 52, right: 20, width: 36, height: 36, borderRadius: 18,
          backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name="close" size={22} color={colors.text} />
      </Pressable>
    </View>
  );
}
