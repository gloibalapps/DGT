import React, { useState } from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform, Pressable, Switch } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, VehicleT } from "@/src/api";
import { FUEL_TYPES, OWNERSHIP, FREQUENCIES } from "@/src/config";
import {
  AppText, Card, Input, Field, ChipRow, PrimaryButton,
  IconButton, DateField, useToast,
} from "@/src/ui";

export default function VehicleSetup() {
  const { colors } = useTheme();
  const { vehicles, reloadVehicles } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const editing = !!params.id;
  const current: VehicleT = vehicles.find((x) => x.id === params.id) || {};

  const [name, setName] = useState(current.name || "");
  const [registration, setRegistration] = useState(current.registration || "");
  const [makeModel, setMakeModel] = useState(current.make_model || "");
  const [year, setYear] = useState(current.year ? String(current.year) : "");
  const [price, setPrice] = useState(current.purchase_price != null ? String(current.purchase_price) : "");
  const [fuel, setFuel] = useState<string>(current.fuel_type || "petrol");
  const [ownership, setOwnership] = useState<string>(current.ownership || "own");
  const [bizStart, setBizStart] = useState(current.business_use_start || "");
  const [openOdo, setOpenOdo] = useState(current.opening_odometer != null ? String(current.opening_odometer) : "");
  const [openOdoDate, setOpenOdoDate] = useState(current.opening_odometer_date || "");
  const [closeOdo, setCloseOdo] = useState(current.closing_odometer != null ? String(current.closing_odometer) : "");
  const [closeOdoDate, setCloseOdoDate] = useState(current.closing_odometer_date || "");

  const [recEnabled, setRecEnabled] = useState(!!current.recurring_payment);
  const [recAmount, setRecAmount] = useState(current.recurring_payment ? String(current.recurring_payment.amount) : "");
  const [recFreq, setRecFreq] = useState<string>(current.recurring_payment?.frequency || "weekly");
  const [recAnchor, setRecAnchor] = useState(current.recurring_payment?.anchor_date || "");
  const [saving, setSaving] = useState(false);

  const num = (s: string) => { const n = parseFloat(s); return isNaN(n) ? null : n; };

  const save = async () => {
    if (recEnabled && (!recAmount || !recAnchor)) {
      show("Add the payment amount and start date", "error"); return;
    }
    setSaving(true);
    const payload: Partial<VehicleT> = {
      name: name.trim() || makeModel.trim() || "My Vehicle",
      registration: registration.trim() || null,
      make_model: makeModel.trim() || null,
      year: year ? parseInt(year, 10) : null,
      purchase_price: num(price),
      fuel_type: (fuel as any) || null,
      ownership: ownership as any,
      business_use_start: bizStart || null,
      opening_odometer: num(openOdo),
      opening_odometer_date: openOdoDate || null,
      closing_odometer: num(closeOdo),
      closing_odometer_date: closeOdoDate || null,
      recurring_payment: recEnabled ? {
        amount: parseFloat(recAmount), frequency: recFreq as any,
        anchor_type: "gigstart", anchor_date: recAnchor,
      } : null,
    };
    try {
      if (editing) await api.updateVehicle(params.id!, payload);
      else await api.addVehicle(payload);
      await reloadVehicles();
      show(editing ? "Vehicle updated" : "Vehicle added", "success");
      router.back();
    } catch {
      show("Couldn't save — try again", "error");
      setSaving(false);
    }
  };

  const del = async () => {
    if (!editing) return;
    try {
      await api.deleteVehicle(params.id!);
      await reloadVehicles();
      show("Vehicle removed", "success");
      router.back();
    } catch (e: any) {
      show(/at least one/.test(e?.message || "") ? "Keep at least one vehicle" : "Couldn't remove", "error");
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID="vehicle-close" onPress={() => router.back()} />
          <AppText variant="h2">{editing ? "Edit vehicle" : "Add vehicle"}</AppText>
          {editing && vehicles.length > 1
            ? <IconButton icon="trash-outline" color={colors.loss} testID="vehicle-delete" onPress={del} />
            : <View style={{ width: 34 }} />}
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 20 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Card style={{ marginBottom: 16 }}>
            <Field label="Nickname">
              <Input testID="veh-name" value={name} onChangeText={setName} placeholder="Daily driver" />
            </Field>
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
            <Field label="Ownership">
              <ChipRow options={OWNERSHIP.map((o) => ({ key: o.key, label: o.label }))} value={ownership} onChange={setOwnership} testIDPrefix="veh-ownership" />
            </Field>
            <Field label="Business-use start date" hint="When you first used this car for gig work">
              <DateField testID="veh-bizstart" value={bizStart} onChange={setBizStart} maxToday />
            </Field>
          </Card>

          <AppText variant="label" color={colors.dim} style={{ marginBottom: 8, marginLeft: 4 }}>RECURRING PAYMENT</AppText>
          <Card style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <AppText variant="bodySemi">Weekly rental / lease / loan</AppText>
                <AppText variant="caption" color={colors.dim}>Auto-adds the fixed cost for this car over time</AppText>
              </View>
              <Switch testID="veh-rec-toggle" value={recEnabled} onValueChange={setRecEnabled}
                trackColor={{ true: colors.accent, false: colors.surfaceAlt }} />
            </View>
            {recEnabled ? (
              <View style={{ marginTop: 14 }}>
                <Field label="Amount per cycle">
                  <Input testID="veh-rec-amount" value={recAmount} onChangeText={setRecAmount} keyboardType="decimal-pad" placeholder="250" />
                </Field>
                <Field label="Frequency">
                  <ChipRow options={FREQUENCIES.map((f) => ({ key: f.key, label: f.label }))} value={recFreq} onChange={setRecFreq} testIDPrefix="veh-rec-freq" />
                </Field>
                <Field label="Payment start date" hint="When your first payment was — makes the running total accurate">
                  <DateField testID="veh-rec-anchor" value={recAnchor} onChange={setRecAnchor} maxToday />
                </Field>
              </View>
            ) : null}
          </Card>

          <AppText variant="label" color={colors.dim} style={{ marginBottom: 8, marginLeft: 4 }}>ODOMETER PROTECTION</AppText>
          <Card style={{ marginBottom: 16 }}>
            <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
              Enter your odometer at the start (1 July) and end (30 June) of the financial year. GigTax reconciles this against your GPS records for this car.
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
          <PrimaryButton testID="veh-save" label={saving ? "Saving…" : editing ? "Save changes" : "Add vehicle"} onPress={save} disabled={saving} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}
