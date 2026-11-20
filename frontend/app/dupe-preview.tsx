import React from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "@/src/theme";
import { AppText } from "@/src/ui";
import { BatchSavedLine, DuplicateCard, PossibleHintLine } from "@/src/DuplicateCard";

// Fictional coloured blocks, drawn for this preview. Not a person's receipt.
const THIS_SCAN = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAfElEQVR42u3YvQmAMBAG0Ch29rZi53YuYOmMYie2mcIJFEHxL+/qFPe4j0tIVnZj2Kg4VOH1lYePFwBA6oDi+NG6ae/sbJknEQIAAPjVGj2410wAACCZt9AlW0GEAAAAvIVEKJUIVX18qsudX1oRAgAAAHCRnb9NTCBhwAqoYRLkLi0wHQAAAABJRU5ErkJggg==";
const SAVED = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAi0lEQVR42mN88e4Lw1AGTAxDHIx6YKABCzJHXdNsqLj75vVTWDyALDGYAXJAj+aBQZUH6JAfqJ5ER5PQqAdGPTDqgVEPjFZk9KlxRmNg1AOjHqBvJl6z9chgcF+It81oEhr1wKgHRj0w6oFRD4x6YAg2JQjW4aMxMOoBrEloCE0RQADj6CTfqAcoAwBGVxXMMxHENgAAAABJRU5ErkJggg==";

const mine = { merchant: "Northside Servo", date: "2026-04-02", time: "07:14", amount: 63.4, image: THIS_SCAN };
const saved = { merchant: "Northside Servo", date: "2026-04-02", time: "07:10", amount: 63.4, image: SAVED };

/** Dev preview of the three review-screen states. No account data. */
export default function DupePreview() {
  const { colors } = useTheme();
  const noop = () => {};
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <AppText variant="h2" style={{ padding: 16 }}>Receipt review</AppText>
      </SafeAreaView>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <AppText variant="section" style={{ marginBottom: 8 }}>Strong or likely</AppText>
        <DuplicateCard mine={mine} saved={saved} onDiscard={noop} onKeep={noop} onView={noop} />
        <AppText variant="section" style={{ marginBottom: 8 }}>Batch</AppText>
        <BatchSavedLine text="2 of 6 look already saved" />
        <DuplicateCard mine={mine} saved={saved} onDiscard={noop} onKeep={noop} onView={noop} />
        <AppText variant="section" style={{ marginBottom: 8 }}>Possible</AppText>
        <PossibleHintLine />
      </ScrollView>
    </View>
  );
}
