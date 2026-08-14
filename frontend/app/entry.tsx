import React, { useEffect, useState } from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api } from "@/src/api";
import { todayISO } from "@/src/api";
import { isValidDate, isoToAU, auToISO, maskAUDate } from "@/src/date";
import { CATEGORIES, TAX_TREATMENTS } from "@/src/config";
import {
  AppText, Card, Input, Field, ChipRow, PrimaryButton, SecondaryButton,
  IconButton, Spinner, useToast,
} from "@/src/ui";
import { receiptStash } from "@/src/scanStash";

type Kind = "income" | "expense" | "trip";

export default function Entry() {
  const { colors } = useTheme();
  const { profile, refresh } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const params = useLocalSearchParams<{
    type?: string; id?: string; fromScan?: string;
    amount?: string; date?: string; merchant?: string; category?: string;
  }>();
  const kind = (params.type || "income") as Kind;
  const editing = !!params.id;

  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);

  const [amount, setAmount] = useState(params.amount || "");
  const [dateAU, setDateAU] = useState(isoToAU(params.date && isValidDate(params.date) ? params.date : todayISO()));
  const [note, setNote] = useState("");
  const [platform, setPlatform] = useState(profile?.platforms?.[0] || "Other");
  const [category, setCategory] = useState((params.category as string) || "fuel");
  const [merchant, setMerchant] = useState(params.merchant || "");
  const [treatment, setTreatment] = useState("inclusive");
  const [distance, setDistance] = useState("");
  const [minutes, setMinutes] = useState("");
  const [tripType, setTripType] = useState<"business" | "personal">("business");
  const [receiptImage, setReceiptImage] = useState<string | null>(null);

  useEffect(() => {
    if (params.fromScan === "1" && receiptStash.image) {
      setReceiptImage(receiptStash.image);
      receiptStash.image = null;
    }
  }, [params.fromScan]);

  useEffect(() => {
    if (!editing) return;
    (async () => {
      try {
        if (kind === "income") {
          const list = await api.listIncome();
          const it = list.find((x) => x.id === params.id);
          if (it) { setAmount(String(it.amount)); setDateAU(isoToAU(it.date)); setNote(it.note || ""); setPlatform(it.platform || "Other"); setTreatment(it.tax_treatment); }
        } else if (kind === "expense") {
          const list = await api.listExpenses();
          const it = list.find((x) => x.id === params.id);
          if (it) { setAmount(String(it.amount)); setDateAU(isoToAU(it.date)); setNote(it.note || ""); setCategory(it.category); setMerchant(it.merchant || ""); setTreatment(it.tax_treatment); setReceiptImage(it.receipt_image || null); }
        } else {
          const list = await api.listTrips();
          const it = list.find((x) => x.id === params.id);
          if (it) { setDistance(String(it.distance_km)); setMinutes(it.duration_min ? String(it.duration_min) : ""); setDateAU(isoToAU(it.date)); setNote(it.note || ""); setTripType(it.type); }
        }
      } finally { setLoading(false); }
    })();
  }, [editing, kind, params.id]);

  const title = `${editing ? "Edit" : "Add"} ${kind}`;

  const save = async () => {
    const iso = auToISO(dateAU);
    if (!iso) { show("Enter a valid date (DD/MM/YYYY)", "error"); return; }
    setSaving(true);
    try {
      if (kind === "income") {
        const amt = parseFloat(amount);
        if (!amt) { show("Enter an amount", "error"); setSaving(false); return; }
        const payload = { date: iso, amount: amt, platform, tax_treatment: treatment, note };
        if (editing) await api.updateIncome(params.id!, payload); else await api.addIncome(payload);
      } else if (kind === "expense") {
        const amt = parseFloat(amount);
        if (!amt) { show("Enter an amount", "error"); setSaving(false); return; }
        const payload: any = { date: iso, amount: amt, category, merchant, tax_treatment: treatment, note };
        if (receiptImage) payload.receipt_image = receiptImage;
        if (editing) await api.updateExpense(params.id!, payload); else await api.addExpense(payload);
      } else {
        const km = parseFloat(distance);
        if (!km) { show("Enter a distance", "error"); setSaving(false); return; }
        const mins = parseFloat(minutes);
        const payload: any = { date: iso, distance_km: km, type: tripType, note };
        if (mins) payload.duration_min = mins;
        if (editing) await api.updateTrip(params.id!, payload); else await api.addTrip(payload);
      }
      show(editing ? "Updated" : "Saved", "success");
      refresh();
      router.back();
    } catch {
      show("Couldn't save", "error");
      setSaving(false);
    }
  };

  const del = async () => {
    if (!editing) return;
    try {
      if (kind === "income") await api.deleteIncome(params.id!);
      else if (kind === "expense") await api.deleteExpense(params.id!);
      else await api.deleteTrip(params.id!);
      show("Deleted", "success");
      refresh();
      router.back();
    } catch {
      show("Couldn't delete — try again", "error");
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID="entry-close" onPress={() => router.back()} />
          <AppText variant="h2" style={{ textTransform: "capitalize" }}>{title}</AppText>
          {editing ? <IconButton icon="trash-outline" color={colors.loss} testID="entry-delete" onPress={del} />
            : <View style={{ width: 34 }} />}
        </View>
      </SafeAreaView>

      {loading ? <Spinner /> : (
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 20 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {kind === "trip" ? (
              <>
                <Field label="Distance (km)">
                  <Input testID="entry-distance" value={distance} onChangeText={setDistance} keyboardType="decimal-pad" placeholder="12.4" />
                </Field>
                <Field label="Time (minutes, optional)" hint="Powers your $/hour on Home">
                  <Input testID="entry-minutes" value={minutes} onChangeText={setMinutes} keyboardType="decimal-pad" placeholder="45" />
                </Field>
                <Field label="Type">
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    {(["business", "personal"] as const).map((t) => {
                      const active = tripType === t;
                      return (
                        <Pressable key={t} testID={`entry-triptype-${t}`} onPress={() => setTripType(t)}
                          style={{ flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: "center",
                            backgroundColor: active ? (t === "business" ? colors.profit : colors.surfaceAlt) : colors.surfaceAlt,
                            borderWidth: 1, borderColor: active ? (t === "business" ? colors.profit : colors.accent) : colors.border }}>
                          <AppText variant="bodySemi" color={active && t === "business" ? colors.bg : colors.text} style={{ textTransform: "capitalize" }}>{t}</AppText>
                        </Pressable>
                      );
                    })}
                  </View>
                </Field>
              </>
            ) : (
              <Field label="Amount">
                <Input testID="entry-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
              </Field>
            )}

            {kind === "income" && (
              <Field label="Platform">
                <ChipRow options={(profile?.platforms?.length ? profile.platforms : ["Other"]).map((p) => ({ key: p, label: p }))}
                  value={platform} onChange={setPlatform} testIDPrefix="entry-platform" />
              </Field>
            )}

            {kind === "expense" && (
              <>
                <Field label="Category">
                  <ChipRow options={CATEGORIES.map((c) => ({ key: c.key, label: c.label }))} value={category} onChange={setCategory} testIDPrefix="entry-category" />
                </Field>
                <Field label="Merchant (optional)">
                  <Input testID="entry-merchant" value={merchant} onChangeText={setMerchant} placeholder="Shell, Linkt…" />
                </Field>
                {receiptImage ? (
                  <Field label="Receipt">
                    <Image source={{ uri: `data:image/jpeg;base64,${receiptImage}` }}
                      style={{ width: 90, height: 120, borderRadius: 10, borderWidth: 1, borderColor: colors.border }} contentFit="cover" />
                  </Field>
                ) : null}
              </>
            )}

            {kind !== "trip" && (
              <Field label="GST treatment">
                <ChipRow options={TAX_TREATMENTS.map((t) => ({ key: t.key, label: t.label }))} value={treatment} onChange={setTreatment} testIDPrefix="entry-treatment" />
              </Field>
            )}

            <Field label="Date" hint="Format DD/MM/YYYY">
              <Input testID="entry-date" value={dateAU} onChangeText={(t) => setDateAU(maskAUDate(t))} placeholder="DD/MM/YYYY" keyboardType="numbers-and-punctuation" />
            </Field>
            <Field label="Note (optional)">
              <Input testID="entry-note" value={note} onChangeText={setNote} placeholder="Anything to remember" />
            </Field>
          </ScrollView>
          <SafeAreaView edges={["bottom"]} style={{ paddingHorizontal: 16, paddingTop: 6 }}>
            <PrimaryButton testID="entry-save" label={saving ? "Saving…" : "Save"} onPress={save} disabled={saving} />
          </SafeAreaView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
