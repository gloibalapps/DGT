import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Platform } from "react-native";
import { useTheme, FONT } from "@/src/theme";

const ICONS: Record<string, { on: any; off: any }> = {
  home: { on: "speedometer", off: "speedometer-outline" },
  trips: { on: "navigate", off: "navigate-outline" },
  expenses: { on: "receipt", off: "receipt-outline" },
  reports: { on: "bar-chart", off: "bar-chart-outline" },
  settings: { on: "settings", off: "settings-outline" },
};

export default function TabsLayout() {
  const { colors } = useTheme();
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
          height: Platform.OS === "ios" ? 88 : 66,
          paddingTop: 6,
          paddingBottom: Platform.OS === "ios" ? 28 : 8,
        },
        tabBarLabelStyle: { fontFamily: FONT.medium, fontSize: 11 },
        tabBarIcon: ({ focused, color, size }) => {
          const set = ICONS[route.name] || ICONS.home;
          return <Ionicons name={focused ? set.on : set.off} size={size} color={color} />;
        },
      })}
    >
      <Tabs.Screen name="home" options={{ title: "Home", tabBarButtonTestID: "tab-home" }} />
      <Tabs.Screen name="trips" options={{ title: "Trips", tabBarButtonTestID: "tab-trips" }} />
      <Tabs.Screen name="expenses" options={{ title: "Expenses", tabBarButtonTestID: "tab-expenses" }} />
      <Tabs.Screen name="reports" options={{ title: "Reports", tabBarButtonTestID: "tab-reports" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarButtonTestID: "tab-settings" }} />
    </Tabs>
  );
}
