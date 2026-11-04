import { Tabs } from "expo-router";
import { Text, View } from "react-native";
import TrialBanner from "@/src/TrialBanner";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, FONT } from "@/src/theme";

// Line icons only; the active tab is shown by colour + weight.
const ICONS: Record<string, any> = {
  home: "wallet-outline",
  trips: "car-outline",
  reports: "bar-chart-outline",
  ask: "chatbubble-ellipses-outline",
  settings: "person-circle-outline",
};

export default function TabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // 72px bar plus the device's bottom inset (Android nav bar / iOS home indicator).
  const bottomInset = insets.bottom;
  return (
    <View style={{ flex: 1 }}>
    <TrialBanner />
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.dim,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 72 + bottomInset,
          paddingTop: 10,
          paddingBottom: Math.max(bottomInset, 12),
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarLabel: ({ focused, color, children }) => (
          <Text style={{ fontFamily: focused ? FONT.semibold : FONT.regular, fontSize: 11, color, marginTop: 2 }}>{children}</Text>
        ),
        tabBarIcon: ({ color }) => <Ionicons name={ICONS[route.name] || ICONS.home} size={24} color={color} />,
      })}
    >
      <Tabs.Screen name="home" options={{ title: "Money", tabBarButtonTestID: "tab-home" }} />
      <Tabs.Screen name="trips" options={{ title: "Mileage", tabBarButtonTestID: "tab-trips" }} />
      <Tabs.Screen name="reports" options={{ title: "Reports", tabBarButtonTestID: "tab-reports" }} />
      <Tabs.Screen name="ask" options={{ title: "Ask", tabBarButtonTestID: "tab-ask" }} />
      <Tabs.Screen name="settings" options={{ title: "Profile", tabBarButtonTestID: "tab-settings" }} />
    </Tabs>
    </View>
  );
}
