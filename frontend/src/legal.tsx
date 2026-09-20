import React from "react";
import { View, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { useTheme } from "@/src/theme";
import { AppText, IconButton } from "@/src/ui";

export interface LegalSection { heading: string; body: string[] }

export function LegalDoc({
  title, updated, intro, sections, testIDPrefix,
}: {
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
  testIDPrefix: string;
}) {
  const { colors } = useTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID={`${testIDPrefix}-close`} onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
          <AppText variant="h2">{title}</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>Last updated: {updated}</AppText>
        <AppText variant="body" color={colors.dim} style={{ marginBottom: 20, lineHeight: 22 }}>{intro}</AppText>
        {sections.map((s, i) => (
          <View key={i} style={{ marginBottom: 20 }}>
            <AppText variant="bodySemi" style={{ marginBottom: 8, fontSize: 16 }}>{`${i + 1}. ${s.heading}`}</AppText>
            {s.body.map((p, j) => (
              <AppText key={j} variant="body" color={colors.dim} style={{ marginBottom: 8, lineHeight: 22 }}>{p}</AppText>
            ))}
          </View>
        ))}
        <AppText variant="caption" color={colors.dim} style={{ marginTop: 8 }}>
          GigTax by Global Apps AI · Contact: globalappsai@gmail.com
        </AppText>
      </ScrollView>
    </View>
  );
}
