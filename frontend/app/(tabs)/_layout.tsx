import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, FONT } from "@/src/theme";

const ICONS: Record<string, { on: any; off: any }> = {
  home: { on: "wallet", off: "wallet-outline" },
  trips: { on: "car-sport", off: "car-sport-outline" },
  reports: { on: "bar-chart", off: "bar-chart-outline" },
  ask: { on: "sparkles", off: "sparkles-outline" },
  settings: { on: "person-circle", off: "person-circle-outline" },
};

export default function TabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // Add the device's bottom inset (Android system nav bar / iOS home indicator)
  // so the tab bar is never hidden behind the OS navigation.
  const bottomInset = insets.bottom;
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.dim,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 60 + bottomInset,
          paddingTop: 6,
          paddingBottom: Math.max(bottomInset, 10),
        },
        tabBarLabelStyle: { fontFamily: FONT.medium, fontSize: 11 },
        tabBarIcon: ({ focused, color, size }) => {
          const set = ICONS[route.name] || ICONS.home;
          return <Ionicons name={focused ? set.on : set.off} size={size} color={color} />;
        },
      })}
    >
      <Tabs.Screen name="home" options={{ title: "Money", tabBarButtonTestID: "tab-home" }} />
      <Tabs.Screen name="trips" options={{ title: "Mileage", tabBarButtonTestID: "tab-trips" }} />
      <Tabs.Screen name="reports" options={{ title: "Reports", tabBarButtonTestID: "tab-reports" }} />
      <Tabs.Screen name="ask" options={{ title: "Ask", tabBarButtonTestID: "tab-ask" }} />
      <Tabs.Screen name="settings" options={{ title: "Profile", tabBarButtonTestID: "tab-settings" }} />
    </Tabs>
  );
}
