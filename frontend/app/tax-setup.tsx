import React, { useState } from "react";
import { View, ScrollView, Pressable, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { AppText, Card, Input, Field, ChipRow, PrimaryButton, IconButton, useToast, DateField } from "@/src/ui";

const REG_OPTIONS = [
  { key: "registered", label: "Registered" },
  { key: "not_registered", label: "Not registered" },
  { key: "unknown", label: "Not sure" },
];
const FREQ = [
  { key: "quarterly", label: "Quarterly" },
  { key: "monthly", label: "Monthly" },
  { key: "annually", label: "Annually" },
];

export default function TaxSetup() {
  const { colors } = useTheme();
  const { profile, updateProfile } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const isUS = profile?.country === "US";

  const [legalName, setLegalName] = useState(profile?.legal_name || "");
  const [method, setMethod] = useState(profile?.accounting_method || "cash");
  const [taxId, setTaxId] = useState(!!profile?.tax_id_on_file);
  const [regStatus, setRegStatus] = useState(profile?.registration_status || "unknown");
  const [regDate, setRegDate] = useState(profile?.registration_date || "");
  const [freq, setFreq] = useState(profile?.reporting_frequency || "quarterly");

  const save = async () => {
    const p = await updateProfile({
      legal_name: legalName || null,
      accounting_method: method as any,
      tax_id_on_file: taxId,
      registration_status: regStatus as any,
      registration_date: regDate || null,
      reporting_frequency: freq,
    });
    if (!p) { show("Couldn't save — try again", "error"); return; }
    show("Tax setup saved", "success");
    router.back();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID="tax-close" onPress={() => router.back()} />
          <AppText variant="h2">Tax setup</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 20 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Field label="Legal / business name">
            <Input testID="tax-legalname" value={legalName} onChangeText={setLegalName}
              placeholder={isUS ? "Your name or business name" : "Your name or ABN entity"} />
          </Field>

          <Field label="Accounting method" hint="Most gig drivers use cash.">
            <ChipRow options={[{ key: "cash", label: "Cash" }, { key: "accrual", label: "Accrual" }]}
              value={method} onChange={(m) => setMethod(m as any)} testIDPrefix="tax-method" />
          </Field>

          {!isUS && (
            <>
              <Field label="GST registration status">
                <ChipRow options={REG_OPTIONS} value={regStatus} onChange={(s) => setRegStatus(s as any)} testIDPrefix="tax-reg" />
              </Field>

              {regStatus === "registered" && (
                <Field label="Registration date">
                  <DateField testID="tax-regdate" value={regDate} onChange={setRegDate} maxToday />
                </Field>
              )}
            </>
          )}

          <Field label={isUS ? "Estimated tax frequency" : "Reporting frequency"}
            hint={isUS ? "Estimated taxes (Form 1040-ES) are usually paid quarterly." : undefined}>
            <ChipRow options={FREQ} value={freq} onChange={setFreq} testIDPrefix="tax-freq" />
          </Field>

          <Pressable testID="tax-taxid" onPress={() => setTaxId(!taxId)}>
            <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <AppText variant="bodyMed">{isUS ? "Tax ID (EIN/SSN) on file" : "Tax ID (ABN/TFN) on file"}</AppText>
                <AppText variant="caption" color={colors.dim}>We store only the fact you have one — never the number.</AppText>
              </View>
              <View style={{
                width: 48, height: 28, borderRadius: 999, padding: 3,
                backgroundColor: taxId ? colors.accent : colors.surfaceAlt,
                alignItems: taxId ? "flex-end" : "flex-start",
              }}>
                <View style={{ width: 22, height: 22, borderRadius: 999, backgroundColor: "#fff" }} />
              </View>
            </Card>
          </Pressable>
        </ScrollView>
        <SafeAreaView edges={["bottom"]} style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          <PrimaryButton testID="tax-save" label="Save tax setup" onPress={save} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}
