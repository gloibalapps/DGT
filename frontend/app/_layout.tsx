import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { ThemeProvider } from "@/src/theme";
import { AppProvider } from "@/src/store";
import { ToastProvider } from "@/src/ui";
import { AuthProvider, useAuth } from "@/src/auth";
import { SubscriptionProvider, useSubscription } from "@/src/subscription";
import PaywallScreen from "@/src/PaywallScreen";
import LoginScreen from "@/src/LoginScreen";
import { syncAutotrack } from "@/src/autotrack";
import { maybeAutoBackup } from "@/src/backup";

LogBox.ignoreAllLogs(true);
SplashScreen.preventAutoHideAsync();

// Set to `true` to enforce the RevenueCat subscription paywall gate.
// OFF for now — RevenueCat integration deferred at user's request.
const SUB_GATE_ENABLED = false;

function SubGate() {
  const { loading, managed, isActive } = useSubscription();
  if (loading) return null;
  // The gate only enforces when RevenueCat is truly running (native build with
  // keys). In web preview / Expo Go it's bypassed so the app stays testable.
  if (SUB_GATE_ENABLED && managed && !isActive) return <PaywallScreen gate />;
  return (
    <AppProvider>
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="onboarding" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="entry" options={{ presentation: "modal" }} />
          <Stack.Screen name="scan-receipt" options={{ presentation: "modal" }} />
          <Stack.Screen name="tax-setup" options={{ presentation: "modal" }} />
          <Stack.Screen name="vehicle" options={{ presentation: "modal" }} />
          <Stack.Screen name="paywall" options={{ presentation: "modal" }} />
          <Stack.Screen name="manual" options={{ presentation: "modal" }} />
          <Stack.Screen name="weekly-goal" options={{ presentation: "modal" }} />
          <Stack.Screen name="tax-saved" options={{ presentation: "modal" }} />
          <Stack.Screen name="insights" />
          <Stack.Screen name="money-detail" />
          <Stack.Screen name="logbook" />
        </Stack>
      </View>
    </AppProvider>
  );
}

// Set to `true` to enforce the Google login gate.
// Currently OFF: user was locked out because Google sign-in is blocked by the
// OAuth consent screen (Testing mode / test-users allowlist). Re-enable once the
// consent screen is published to production (or the user's Gmail is a test user).
const AUTH_ENABLED = false;

function AuthGate() {
  const { user, loading } = useAuth();
  if (loading) return null;  // splash stays until any stored session resolves
  if (AUTH_ENABLED && !user) return <LoginScreen />;  // Google sign-in gate
  return (
    <SubscriptionProvider>
      <SubGate />
    </SubscriptionProvider>
  );
}

export default function RootLayout() {
  const [iconsLoaded, iconErr] = useIconFonts();
  const [fontsLoaded, fontErr] = useFonts({
    "BarlowCondensed-Bold": require("../assets/fonts/BarlowCondensed-Bold.ttf"),
    "BarlowCondensed-SemiBold": require("../assets/fonts/BarlowCondensed-SemiBold.ttf"),
    "Inter": require("../assets/fonts/Inter.ttf"),
  });

  const ready = (iconsLoaded || iconErr) && (fontsLoaded || fontErr);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  useEffect(() => {
    syncAutotrack();
    maybeAutoBackup();
  }, []);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <AuthGate />
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
