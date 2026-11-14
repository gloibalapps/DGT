import React, { useState } from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import {
  AppText, Card, Input, Field, IconButton, PrimaryButton, SecondaryButton, useToast,
} from "@/src/ui";

export default function WeeklyGoal() {
  const { colors } = useTheme();
  const { profile, updateProfile } = useStore();
  const { show } = useToast();
  const router = useRouter();

  const symbol = profile?.country === "UK" ? "£" : "$";
  const current = profile?.weekly_goal;
  const [amount, setAmount] = useState(current != null ? String(current) : "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { show("Enter a target amount", "error"); return; }
    setSaving(true);
    const ok = await updateProfile({ weekly_goal: Math.round(amt * 100) / 100 });
    setSaving(false);
    if (ok) { show("Weekly goal set", "success"); router.back(); }
    else show("Couldn't save — try again", "error");
  };

  const clear = async () => {
    setSaving(true);
    const ok = await updateProfile({ weekly_goal: null });
    setSaving(false);
    if (ok) { show("Weekly goal removed", "info"); router.back(); }
    else show("Couldn't update — try again", "error");
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID="goal-close" onPress={() => router.back()} />
          <AppText variant="h2">Weekly goal</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 20 }} keyboardShouldPersistTaps="handled">
          <Card style={{ marginBottom: 16 }}>
            <AppText variant="body" color={colors.dim} style={{ lineHeight: 20 }}>
              Set the earnings target you’re aiming for each week (Mon–Sun). GigTax shows your
              progress on the Money tab so you always know how close you are.
            </AppText>
          </Card>

          <Field label={`Weekly earnings target (${symbol})`}>
            <Input testID="goal-amount" value={amount} onChangeText={setAmount}
              keyboardType="decimal-pad" placeholder="1000" returnKeyType="done" />
          </Field>
        </ScrollView>

        <SafeAreaView edges={["bottom"]} style={{ paddingHorizontal: 16, paddingTop: 6, gap: 10 }}>
          {current != null ? (
            <SecondaryButton testID="goal-clear" label="Remove goal" icon="trash-outline" onPress={clear} disabled={saving} />
          ) : null}
          <PrimaryButton testID="goal-save" label={saving ? "Saving…" : "Save goal"} onPress={save} disabled={saving} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}
