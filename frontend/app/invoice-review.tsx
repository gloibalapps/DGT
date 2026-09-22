import React, { useState } from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, todayISO } from "@/src/api";
import { isValidDate } from "@/src/date";
import { CATEGORIES } from "@/src/config";
import {
  AppText, Field, Input, DateField, Select, PrimaryButton, IconButton, useToast,
} from "@/src/ui";
import { receiptStash } from "@/src/scanStash";

export default function InvoiceReview() {
  const { colors } = useTheme();
  const { refresh, activeVehicleId } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const params = useLocalSearchParams<{
    amount?: string; date?: string; merchant?: string; category?: string;
    liters?: string; gst?: string;
  }>();

  const [supplier, setSupplier] = useState(params.merchant || "");
  const [dateISO, setDateISO] = useState(params.date && isValidDate(params.date) ? params.date : todayISO());
  const [category, setCategory] = useState((params.category as string) || "other");
  const [amount, setAmount] = useState(params.amount || "");
  const [hasGst, setHasGst] = useState(!!(params.gst && params.gst !== ""));
  const [gst, setGst] = useState(params.gst || "");
  const [liters, setLiters] = useState(params.liters || "");
  const [note, setNote] = useState("");
  const [receiptImage] = useState<string | null>(receiptStash.image);
  const [saving, setSaving] = useState(false);

  const capture = async () => {
    const amt = parseFloat(amount);
    if (!amt) { show("Enter the sale total", "error"); return; }
    const gstNum = hasGst ? parseFloat(gst) : NaN;
    setSaving(true);
    try {
      // GST on the invoice -> GST-inclusive; "no gst" -> out-of-scope (No GST).
      const payload: any = {
        date: dateISO, amount: amt, category, merchant: supplier,
        tax_treatment: hasGst && gstNum > 0 ? "inclusive" : "out_of_scope",
        gst: hasGst && !isNaN(gstNum) ? gstNum : null,
        note,
      };
      const l = parseFloat(liters);
      if (!isNaN(l)) payload.liters = l;
      if (receiptImage) payload.receipt_image = receiptImage;
      if ((category === "fuel" || category === "vehicle") && activeVehicleId) payload.vehicle_id = activeVehicleId;
      await api.addExpense(payload);
      receiptStash.image = null;
      show("Invoice captured", "success");
      refresh();
      router.back();
    } catch {
      show("Couldn't save — try again", "error");
      setSaving(false);
    }
  };

  const boxStyle = {
    backgroundColor: colors.surfaceAlt, borderRadius: 16, paddingHorizontal: 14,
    paddingVertical: 15, borderWidth: 1, borderColor: colors.border,
    flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const,
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID="invoice-close" onPress={() => router.back()} />
          <AppText variant="h2">Review invoice</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 20 }}
          showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {/* Line 1 — Supplier */}
          <Field label="Supplier">
            <Input testID="invoice-supplier" value={supplier} onChangeText={setSupplier} placeholder="Shell, Officeworks…" />
          </Field>

          {/* Line 2 — Date */}
          <Field label="Date">
            <DateField testID="invoice-date" value={dateISO} onChange={setDateISO} maxToday />
          </Field>

          {/* Line 3 — Category */}
          <Field label="Category">
            <Select testID="invoice-category" value={category} onChange={setCategory}
              options={CATEGORIES.map((c) => ({ key: c.key, label: c.label, icon: c.icon }))} />
          </Field>

          {/* Line 4 — Sale Total & GST, side by side */}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Field label="Sale Total">
                <Input testID="invoice-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="GST">
                {hasGst ? (
                  <Input testID="invoice-gst" value={gst} onChangeText={setGst} keyboardType="decimal-pad" placeholder="0.00" />
                ) : (
                  <Pressable testID="invoice-gst-none" onPress={() => setHasGst(true)} style={boxStyle}>
                    <AppText variant="body" color={colors.dim} style={{ fontSize: 16 }}>no gst</AppText>
                    <Ionicons name="add-circle-outline" size={18} color={colors.accent} />
                  </Pressable>
                )}
              </Field>
            </View>
          </View>

          {/* Line 5 — Litres (directly under Sale Total) */}
          <Field label="Litres (optional)">
            <Input testID="invoice-liters" value={liters} onChangeText={setLiters}
              keyboardType="decimal-pad" placeholder="e.g. 42.15" />
          </Field>

          {/* Line 6 — Note (above the preview) */}
          <Field label="Note (optional)">
            <Input testID="invoice-note" value={note} onChangeText={setNote}
              placeholder="Anything to remember" multiline numberOfLines={3}
              style={{ height: 84, textAlignVertical: "top" }} />
          </Field>

          {/* Line 7 — Scanned invoice preview */}
          <Field label="Scanned invoice">
            {receiptImage ? (
              <Image source={{ uri: `data:image/jpeg;base64,${receiptImage}` }}
                style={{ width: "100%", height: 220, borderRadius: 16, borderWidth: 1, borderColor: colors.border }}
                contentFit="cover" />
            ) : (
              <View style={{ height: 140, borderRadius: 16, borderWidth: 1, borderColor: colors.border,
                backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="image-outline" size={28} color={colors.dim} />
                <AppText variant="caption" color={colors.dim} style={{ marginTop: 6 }}>No preview available</AppText>
              </View>
            )}
          </Field>
        </ScrollView>

        {/* Line 8 — Capture Invoice (bottom) */}
        <SafeAreaView edges={["bottom"]} style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          <PrimaryButton testID="invoice-capture" label={saving ? "Capturing…" : "Capture Invoice"}
            icon="checkmark-circle-outline" onPress={capture} disabled={saving} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}
