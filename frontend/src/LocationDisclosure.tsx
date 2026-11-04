// Prominent disclosure for background location (Google Play User Data policy).
// Shown BEFORE any background-location system prompt. "Continue" persists
// acceptance; "No thanks" persists the decline and the caller must NOT request
// background permission (manual drives fall back to foreground-only tracking).
import React, { useCallback, useRef, useState } from "react";
import { Modal, View, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { AppText, PrimaryButton, SecondaryButton } from "@/src/ui";
import { setBackgroundDisclosure } from "@/src/autotrack";

export const DISCLOSURE_TITLE = "Drivers Gig Tax uses your location in the background";
export const DISCLOSURE_BODY =
  "Drivers Gig Tax collects location data to enable automatic drive detection and to record your mileage logbook, " +
  "even when the app is closed or not in use.";
export const DISCLOSURE_DETAIL = [
  "Location is used only on your phone to measure each drive's distance. We save the distance and start/end times, not your GPS route, and we never use location for ads or sell it.",
  "On the next screen, choose \u201CAllow all the time\u201D (Android) or \u201CChange to Always Allow\u201D (iPhone) so drives are recorded with the screen off.",
  "You can turn this off anytime in Profile \u203A Tracking or your phone settings. If you say no, you can still add trips manually or track a drive with the app open.",
];

export function useLocationDisclosure() {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback(() => new Promise<boolean>((resolve) => {
    resolver.current = resolve;
    setOpen(true);
  }), []);

  const finish = async (ok: boolean) => {
    await setBackgroundDisclosure(ok);
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  const element = (
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => finish(false)}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 20 }}>
        <View testID="bg-location-disclosure" style={{ width: "100%", maxWidth: 420, maxHeight: "90%", backgroundColor: colors.surface, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: colors.border }}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Ionicons name="location" size={30} color={colors.accent} style={{ marginBottom: 10 }} />
            <AppText variant="h2" style={{ marginBottom: 10 }}>{DISCLOSURE_TITLE}</AppText>
            <AppText variant="bodySemi" style={{ marginBottom: 12, lineHeight: 22 }}>{DISCLOSURE_BODY}</AppText>
            {DISCLOSURE_DETAIL.map((t, i) => (
              <AppText key={i} variant="body" color={colors.dim} style={{ marginBottom: 10, lineHeight: 21 }}>{t}</AppText>
            ))}
          </ScrollView>
          <PrimaryButton testID="bg-disclosure-accept" label="Continue" onPress={() => finish(true)} style={{ marginTop: 8 }} />
          <SecondaryButton testID="bg-disclosure-decline" label="No thanks" onPress={() => finish(false)} style={{ marginTop: 10 }} />
        </View>
      </View>
    </Modal>
  );
  return { ask, element };
}
