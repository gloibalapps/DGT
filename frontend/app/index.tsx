import { Redirect } from "expo-router";
import { View } from "react-native";
import { useStore } from "@/src/store";
import { useTheme } from "@/src/theme";
import { Spinner } from "@/src/ui";

export default function Index() {
  const { profile, loading } = useStore();
  const { colors } = useTheme();

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}><Spinner /></View>;
  }
  if (!profile?.onboarded) return <Redirect href={"/onboarding" as any} />;
  return <Redirect href={"/(tabs)/home" as any} />;
}
