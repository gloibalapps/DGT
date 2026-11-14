import { Redirect } from "expo-router";
import { View } from "react-native";
import { useStore } from "@/src/store";
import { useTheme } from "@/src/theme";
import { Spinner, AppText, PrimaryButton } from "@/src/ui";

export default function Index() {
  const { profile, loading, loadError, reloadProfile } = useStore();
  const { colors } = useTheme();

  if (loading) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }}><Spinner /></View>;
  }

  // A successful load ALWAYS returns a profile object (the backend auto-creates a
  // default one). So a NULL profile means the fetch failed — never treat that as
  // "new user" and drop them into onboarding (that would look like a data reset).
  // Show a lightweight retry state and try again instead.
  if (!profile) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 24 }}>
        {loadError ? (
          <>
            <AppText variant="bodySemi" style={{ textAlign: "center", marginBottom: 6 }}>Couldn’t reach your data</AppText>
            <AppText variant="caption" color={colors.dim} style={{ textAlign: "center", marginBottom: 18 }}>
              Check your connection — your records are safe and will load once you’re back online.
            </AppText>
            <PrimaryButton testID="index-retry" label="Try again" icon="refresh" onPress={() => void reloadProfile()} />
          </>
        ) : (
          <Spinner />
        )}
      </View>
    );
  }

  if (!profile.onboarded) return <Redirect href={"/onboarding" as any} />;
  return <Redirect href={"/(tabs)/home" as any} />;
}
