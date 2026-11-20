import React from "react";
import { View } from "react-native";
import { Image } from "expo-image";

import { displayDate } from "@/src/date";
import { useTheme } from "@/src/theme";
import { AppText, SecondaryButton, fmtMoney } from "@/src/ui";

export interface DupeSide {
  merchant: string;
  date: string;
  time: string;
  amount: number | null;
  image?: string | null;
}

function source(image?: string | null): string | null {
  if (!image) return null;
  if (image.startsWith("data:")) return image;
  const mime = image.startsWith("iVBOR") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${image}`;
}

function Side({ side, label, testID }: { side: DupeSide; label: string; testID: string }) {
  const { colors } = useTheme();
  const uri = source(side.image);
  const when = [side.date ? displayDate(side.date) : "", side.time].filter(Boolean).join(" · ");
  return (
    <View testID={testID} style={{ flex: 1, minWidth: 0 }}>
      <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>{label}</AppText>
      {uri ? (
        <Image source={{ uri }} style={{ width: "100%", height: 96, borderRadius: 12, backgroundColor: colors.surfaceAlt }} contentFit="cover" />
      ) : (
        <View style={{ height: 96, borderRadius: 12, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border }} />
      )}
      <AppText variant="bodySemi" numberOfLines={1} style={{ marginTop: 8 }}>{side.merchant || "Supplier"}</AppText>
      <AppText variant="caption" color={colors.dim} numberOfLines={1}>{when || "—"}</AppText>
      <AppText variant="bodyMed">{side.amount == null || Number.isNaN(side.amount) ? "—" : fmtMoney(side.amount)}</AppText>
    </View>
  );
}

/** Inline review card. Saving stays available; nothing here is styled as an error. */
export function DuplicateCard({
  mine, saved, onDiscard, onKeep, onView,
}: {
  mine: DupeSide;
  saved: DupeSide;
  onDiscard: () => void;
  onKeep: () => void;
  onView: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View testID="dupe-card" style={{
      backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border,
      padding: 14, marginBottom: 16,
    }}>
      <AppText variant="h2" style={{ marginBottom: 12 }}>Looks like you've already saved this one</AppText>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Side testID="dupe-new" label="This scan" side={mine} />
        <Side testID="dupe-saved" label="Saved" side={saved} />
      </View>
      <SecondaryButton testID="dupe-discard" label="Same receipt, don't save" onPress={onDiscard} style={{ marginTop: 14 }} />
      <SecondaryButton testID="dupe-keep" label="Different purchase, keep both" onPress={onKeep} style={{ marginTop: 8 }} />
      <SecondaryButton testID="dupe-view" label="View saved receipt" onPress={onView} style={{ marginTop: 8 }} />
    </View>
  );
}

export function PossibleHintLine() {
  const { colors } = useTheme();
  return (
    <AppText testID="dupe-hint" variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
      A saved expense for the same amount at this supplier is a day apart.
    </AppText>
  );
}

export function BatchSavedLine({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <AppText testID="dupe-batch" variant="body" color={colors.dim} style={{ marginBottom: 10 }}>{text}</AppText>
  );
}
