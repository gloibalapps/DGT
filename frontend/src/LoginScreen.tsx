import React from "react";
import { View, ActivityIndicator, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { useTheme } from "@/src/theme";
import { useAuth } from "@/src/auth";
import { AppText, PrimaryButton } from "@/src/ui";

export default function LoginScreen() {
  const { colors } = useTheme();
  const { signIn, signingIn } = useAuth();

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView style={{ flex: 1, padding: 24, justifyContent: "space-between" }}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <View style={{ width: 88, height: 88, borderRadius: 24, backgroundColor: colors.accent,
            alignItems: "center", justifyContent: "center", marginBottom: 24 }}>
            <Ionicons name="car-sport" size={46} color={colors.bg} />
          </View>
          <AppText style={{ fontFamily: "BarlowCondensed-Bold", fontSize: 44, color: colors.text }}>GigTax</AppText>
          <AppText variant="body" color={colors.dim} style={{ textAlign: "center", marginTop: 8, lineHeight: 22, maxWidth: 300 }}>
            Track income, mileage and expenses — and know exactly what to set aside for tax.
          </AppText>
          <View style={{ marginTop: 28, gap: 12, width: "100%", maxWidth: 340 }}>
            {["Sync your cars, trips & reports across phones",
              "Never lose your logbook or receipts",
              "See your tax estimate update live"].map((t) => (
              <View key={t} style={{ flexDirection: "row", alignItems: "center" }}>
                <Ionicons name="checkmark-circle" size={18} color={colors.profit} style={{ marginRight: 10 }} />
                <AppText variant="bodyMed" color={colors.text} style={{ flex: 1 }}>{t}</AppText>
              </View>
            ))}
          </View>
        </View>

        <View>
          {signingIn ? (
            <View style={{ height: 52, alignItems: "center", justifyContent: "center" }}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : (
            <PrimaryButton testID="login-google" label="Continue with Google" icon="logo-google" onPress={signIn} />
          )}
          <AppText variant="caption" color={colors.dim} style={{ textAlign: "center", marginTop: 14, lineHeight: 16 }}>
            We only use your Google account to sign you in and sync your data securely.
          </AppText>
        </View>
      </SafeAreaView>
    </View>
  );
}
