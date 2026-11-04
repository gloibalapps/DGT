import { Stack, usePathname } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { LogBox, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { StatusBar } from "expo-status-bar";
import { ThemeProvider, useTheme } from "@/src/theme";
import { AppProvider } from "@/src/store";
import { ToastProvider } from "@/src/ui";
import { AuthProvider, useAuth } from "@/src/auth";
import { SubscriptionProvider, useSubscription } from "@/src/subscription";
import PaywallScreen from "@/src/PaywallScreen";
import LoginScreen from "@/src/LoginScreen";
import { syncAutotrack } from "@/src/autotrack";

// Any screen error shows a recoverable "Try again" screen instead of closing the app.
export { ErrorBoundary } from "expo-router";

LogBox.ignoreAllLogs(true);
SplashScreen.preventAutoHideAsync();

// Set to `true` to enforce the RevenueCat subscription paywall gate.
// OFF for now — RevenueCat integration deferred at user's request.
const SUB_GATE_ENABLED = false;

function ThemedStatusBar() {
  const { mode } = useTheme();
  return <StatusBar style={mode === "light" ? "dark" : "light"} />;
}

function SubGate() {
  const { loading, managed, isActive, expired, paywallHit } = useSubscription();
  // Server-enforced trial: once the 14-day trial is over (and the server has
  // PAYWALL_ENFORCED on) show the paywall first. The driver can always continue
  // in read-only mode to view, export and back up their data or delete their
  // account; any write then gets a 402 that re-opens the paywall.
  const [readOnlyOk, setReadOnlyOk] = useState(false);
  useEffect(() => { if (paywallHit) setReadOnlyOk(false); }, [paywallHit]);
  if (loading) return null;
  if (expired && !isActive && !readOnlyOk) {
    return <PaywallScreen gate expired onContinueReadOnly={() => setReadOnlyOk(true)} />;
  }
  // Legacy client-only gate (RevenueCat SDK running, no server status). Kept off.
  if (SUB_GATE_ENABLED && managed && !isActive) return <PaywallScreen gate />;
  return (
    <AppProvider>
      <View style={{ flex: 1 }}>
        <ThemedStatusBar />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="onboarding" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="entry" options={{ presentation: "modal" }} />
          <Stack.Screen name="scan-receipt" options={{ presentation: "modal" }} />
          <Stack.Screen name="invoice-review" options={{ presentation: "modal" }} />
          <Stack.Screen name="tax-setup" options={{ presentation: "modal" }} />
          <Stack.Screen name="vehicle" options={{ presentation: "modal" }} />
          <Stack.Screen name="paywall" options={{ presentation: "modal" }} />
          <Stack.Screen name="manual" options={{ presentation: "modal" }} />
          <Stack.Screen name="weekly-goal" options={{ presentation: "modal" }} />
          <Stack.Screen name="tax-saved" options={{ presentation: "modal" }} />
          <Stack.Screen name="insights" />
          <Stack.Screen name="ue-jobs" />
          <Stack.Screen name="guarantee" />
          <Stack.Screen name="money-detail" />
          <Stack.Screen name="logbook" />
        </Stack>
      </View>
    </AppProvider>
  );
}

// Set to `true` to enforce the Google login gate.
const AUTH_ENABLED = true;

function AuthGate() {
  const { user, loading } = useAuth();
  const pathname = usePathname();
  // Legal pages must be publicly reachable (Google OAuth consent screen + app
  // store review) even when the login gate is on.
  const isPublic = pathname === "/privacy" || pathname === "/terms";
  if (loading) return null;  // splash stays until any stored session resolves
  if (AUTH_ENABLED && !user && !isPublic) return <LoginScreen />;  // Google sign-in gate
  return (
    <SubscriptionProvider>
      <SubGate />
    </SubscriptionProvider>
  );
}

export default function RootLayout() {
  const [iconsLoaded, iconErr] = useIconFonts();
  const [fontsLoaded, fontErr] = useFonts({
    "Inter-Regular": require("../assets/fonts/Inter-Regular.ttf"),
    "Inter-Medium": require("../assets/fonts/Inter-Medium.ttf"),
    "Inter-SemiBold": require("../assets/fonts/Inter-SemiBold.ttf"),
    "Inter-Bold": require("../assets/fonts/Inter-Bold.ttf"),
  });

  const ready = (iconsLoaded || iconErr) && (fontsLoaded || fontErr);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  useEffect(() => {
    // Defer non-UI work so it doesn't compete with the first screen's data load.
    const t1 = setTimeout(() => { syncAutotrack(); }, 1500);
    return () => clearTimeout(t1);
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
