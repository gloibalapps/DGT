import React, { useState } from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { VehicleT } from "@/src/api";
import { FUEL_TYPES } from "@/src/config";
import {
  AppText, Card, Input, Field, ChipRow, PrimaryButton,
  IconButton, DateField, useToast,
} from "@/src/ui";

export default function VehicleSetup() {
  const { colors } = useTheme();
  const { profile, updateProfile } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const v: VehicleT = profile?.vehicle || {};

  const [registration, setRegistration] = useState(v.registration || "");
  const [makeModel, setMakeModel] = useState(v.make_model || "");
  const [year, setYear] = useState(v.year ? String(v.year) : "");
  const [price, setPrice] = useState(v.purchase_price ? String(v.purchase_price) : "");
  const [fuel, setFuel] = useState<string>(v.fuel_type || "petrol");
  const [bizStart, setBizStart] = useState(v.business_use_start || "");
  const [openOdo, setOpenOdo] = useState(v.opening_odometer != null ? String(v.opening_odometer) : "");
  const [openOdoDate, setOpenOdoDate] = useState(v.opening_odometer_date || "");
  const [closeOdo, setCloseOdo] = useState(v.closing_odometer != null ? String(v.closing_odometer) : "");
  const [closeOdoDate, setCloseOdoDate] = useState(v.closing_odometer_date || "");
  const [saving, setSaving] = useState(false);

  const num = (s: string) => { const n = parseFloat(s); return isNaN(n) ? null : n; };

  const save = async () => {
    setSaving(true);
    const vehicle: VehicleT = {
      registration: registration.trim() || null,
      make_model: makeModel.trim() || null,
      year: year ? parseInt(year, 10) : null,
      purchase_price: num(price),
      fuel_type: (fuel as any) || null,
      business_use_start: bizStart || null,
      opening_odometer: num(openOdo),
      opening_odometer_date: openOdoDate || null,
      closing_odometer: num(closeOdo),
      closing_odometer_date: closeOdoDate || null,
    };
    const res = await updateProfile({ vehicle } as any);
    setSaving(false);
    if (res) { show("Vehicle saved", "success"); router.back(); }
    else show("Couldn't save — try again", "error");
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID="vehicle-close" onPress={() => router.back()} />
          <AppText variant="h2">My Vehicle</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 20 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Card style={{ marginBottom: 16 }}>
            <Field label="Registration">
              <Input testID="veh-rego" value={registration} onChangeText={setRegistration} placeholder="ABC-123" autoCapitalize="characters" />
            </Field>
            <Field label="Make & model">
              <Input testID="veh-model" value={makeModel} onChangeText={setMakeModel} placeholder="Toyota Camry Hybrid" />
            </Field>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field label="Year">
                  <Input testID="veh-year" value={year} onChangeText={setYear} keyboardType="number-pad" placeholder="2021" maxLength={4} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Purchase price">
                  <Input testID="veh-price" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="32000" />
                </Field>
              </View>
            </View>
            <Field label="Fuel type">
              <ChipRow options={FUEL_TYPES.map((f) => ({ key: f.key, label: f.label }))} value={fuel} onChange={setFuel} testIDPrefix="veh-fuel" />
            </Field>
            <Field label="Business-use start date" hint="When you first used this car for gig work">
              <DateField testID="veh-bizstart" value={bizStart} onChange={setBizStart} maxToday />
            </Field>
          </Card>

          <AppText variant="label" color={colors.dim} style={{ marginBottom: 8, marginLeft: 4 }}>ODOMETER PROTECTION</AppText>
          <Card style={{ marginBottom: 16 }}>
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
              Enter your odometer at the start (1 July) and end (30 June) of the financial year. GigTax reconciles this against your GPS records.
            </AppText>
            <Field label="Opening odometer (1 July)">
              <Input testID="veh-open-odo" value={openOdo} onChangeText={setOpenOdo} keyboardType="decimal-pad" placeholder="72481" />
            </Field>
            <Field label="Opening reading date">
              <DateField testID="veh-open-odo-date" value={openOdoDate} onChange={setOpenOdoDate} />
            </Field>
            <Field label="Closing odometer (30 June)">
              <Input testID="veh-close-odo" value={closeOdo} onChangeText={setCloseOdo} keyboardType="decimal-pad" placeholder="126842" />
            </Field>
            <Field label="Closing reading date">
              <DateField testID="veh-close-odo-date" value={closeOdoDate} onChange={setCloseOdoDate} />
            </Field>
          </Card>
        </ScrollView>
        <SafeAreaView edges={["bottom"]} style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          <PrimaryButton testID="veh-save" label={saving ? "Saving…" : "Save vehicle"} onPress={save} disabled={saving} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}
