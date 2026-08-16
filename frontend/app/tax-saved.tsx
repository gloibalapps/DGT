import React, { useState } from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import {
  AppText, Card, Input, Field, IconButton, PrimaryButton, useToast,
} from "@/src/ui";

export default function TaxSaved() {
  const { colors } = useTheme();
  const { profile, updateProfile } = useStore();
  const { show } = useToast();
  const router = useRouter();

  const symbol = profile?.country === "UK" ? "£" : "$";
  const current = profile?.tax_set_aside;
  const [amount, setAmount] = useState(current != null ? String(current) : "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const amt = amount.trim() === "" ? 0 : parseFloat(amount);
    if (isNaN(amt) || amt < 0) { show("Enter a valid amount", "error"); return; }
    setSaving(true);
    const ok = await updateProfile({ tax_set_aside: Math.round(amt * 100) / 100 });
    setSaving(false);
    if (ok) { show("Tax set-aside updated", "success"); router.back(); }
    else show("Couldn't save — try again", "error");
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID="taxsaved-close" onPress={() => router.back()} />
          <AppText variant="h2">Tax set aside</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 20 }} keyboardShouldPersistTaps="handled">
          <Card style={{ marginBottom: 16 }}>
            <AppText variant="body" color={colors.dim} style={{ lineHeight: 20 }}>
              Enter how much you've actually put aside for tax so far this year. GigTax compares
              it to your estimated tax owed and tells you if you're ahead or behind.
            </AppText>
          </Card>
          <Field label={`Total set aside for tax (${symbol})`}>
            <Input testID="taxsaved-amount" value={amount} onChangeText={setAmount}
              keyboardType="decimal-pad" placeholder="0" returnKeyType="done" />
          </Field>
        </ScrollView>

        <SafeAreaView edges={["bottom"]} style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          <PrimaryButton testID="taxsaved-save" label={saving ? "Saving…" : "Save"} onPress={save} disabled={saving} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}
