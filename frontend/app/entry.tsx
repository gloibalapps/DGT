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
import { isValidDate } from "@/src/date";
import { CATEGORIES, TAX_TREATMENTS, TRIP_TYPES, BUSINESS_PURPOSES, PRIVATE_PURPOSES } from "@/src/config";
import {
  AppText, Card, Input, Field, ChipRow, PrimaryButton, SecondaryButton,
  IconButton, Spinner, useToast, DateField, Select,
} from "@/src/ui";
import { receiptStash } from "@/src/scanStash";

type Kind = "income" | "expense" | "trip" | "shift";

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
function validTime(t: string): boolean { return TIME_RE.test((t || "").trim()); }
function toMin(t: string): number { const [h, m] = t.trim().split(":").map(Number); return h * 60 + m; }
/** Hours between two "HH:MM" times, wrapping past midnight. null if invalid. */
function hoursBetween(start: string, end: string): number | null {
  if (!validTime(start) || !validTime(end)) return null;
  let diff = toMin(end) - toMin(start);
  if (diff <= 0) diff += 24 * 60; // overnight shift
  return Math.round((diff / 60) * 100) / 100;
}

export default function Entry() {
  const { colors } = useTheme();
  const { profile, refresh, activeVehicleId } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const params = useLocalSearchParams<{
    type?: string; id?: string; fromScan?: string;
    amount?: string; date?: string; merchant?: string; category?: string; liters?: string;
  }>();
  const kind = (params.type || "income") as Kind;
  const editing = !!params.id;

  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);

  const [amount, setAmount] = useState(params.amount || "");
  const [dateISO, setDateISO] = useState(params.date && isValidDate(params.date) ? params.date : todayISO());
  const [note, setNote] = useState("");
  const [platform, setPlatform] = useState(profile?.platforms?.[0] || "Other");
  const [category, setCategory] = useState((params.category as string) || "fuel");
  const [merchant, setMerchant] = useState(params.merchant || "");
  const [liters, setLiters] = useState(params.liters || "");
  const [treatment, setTreatment] = useState("inclusive");
  const [distance, setDistance] = useState("");
  const [minutes, setMinutes] = useState("");
  const [hours, setHours] = useState("");
  const [activeByPlatform, setActiveByPlatform] = useState<Record<string, string>>({});
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [tripType, setTripType] = useState<"business" | "personal" | "mixed">("business");
  const [purpose, setPurpose] = useState<string>("deliver");
  const [businessPct, setBusinessPct] = useState("50");
  const [fromLabel, setFromLabel] = useState("");
  const [toLabel, setToLabel] = useState("");
  const [receiptImage, setReceiptImage] = useState<string | null>(null);

  useEffect(() => {
    if (params.fromScan === "1" && receiptStash.image) {
      setReceiptImage(receiptStash.image);
      receiptStash.image = null;
    }
  }, [params.fromScan]);

  // Auto-fill shift hours from start/end times (handles overnight shifts).
  useEffect(() => {
    if (kind !== "shift") return;
    const h = hoursBetween(startTime, endTime);
    if (h != null) setHours(String(h));
  }, [kind, startTime, endTime]);

  useEffect(() => {
    if (!editing) return;
    (async () => {
      try {
        if (kind === "income") {
          const list = await api.listIncome();
          const it = list.find((x) => x.id === params.id);
          if (it) { setAmount(String(it.amount)); setDateISO(it.date); setNote(it.note || ""); setPlatform(it.platform || "Other"); setTreatment(it.tax_treatment); }
        } else if (kind === "expense") {
          const list = await api.listExpenses();
          const it = list.find((x) => x.id === params.id);
          if (it) { setAmount(String(it.amount)); setDateISO(it.date); setNote(it.note || ""); setCategory(it.category); setMerchant(it.merchant || ""); setLiters(it.liters != null ? String(it.liters) : ""); setTreatment(it.tax_treatment); setReceiptImage(it.receipt_image || null); }
        } else if (kind === "shift") {
          const list = await api.listShifts();
          const it = list.find((x) => x.id === params.id);
          if (it) { setHours(String(it.hours)); setDateISO(it.date); setNote(it.note || ""); setPlatform(it.platform || "Other"); setStartTime(it.start_time || ""); setEndTime(it.end_time || "");
            if (it.active_by_platform) {
              const m: Record<string, string> = {};
              Object.entries(it.active_by_platform).forEach(([k, v]) => { m[k] = String(v); });
              setActiveByPlatform(m);
            } }
        } else {
          const list = await api.listTrips();
          const it = list.find((x) => x.id === params.id);
          if (it) { setDistance(String(it.distance_km)); setMinutes(it.duration_min ? String(it.duration_min) : ""); setDateISO(it.date); setNote(it.note || ""); setTripType(it.type); setPurpose(it.purpose || (it.type === "personal" ? "personal_other" : "deliver")); if (it.business_pct != null) setBusinessPct(String(it.business_pct)); setFromLabel(it.from_label || ""); setToLabel(it.to_label || ""); }
        }
      } finally { setLoading(false); }
    })();
  }, [editing, kind, params.id]);

  const title = `${editing ? "Edit" : "Add"} ${kind}`;
  const carriesPassengers = profile?.work_type === "passengers" || profile?.work_type === "both";

  const save = async () => {
    if (!dateISO) { show("Pick a date", "error"); return; }
    const iso = dateISO;
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
        if (category === "fuel") {
          const l = parseFloat(liters);
          payload.liters = isNaN(l) ? null : l;
        }
        if (receiptImage) payload.receipt_image = receiptImage;
        else if (editing) payload.receipt_image = null;  // allow removing a scanned photo
        if ((category === "fuel" || category === "vehicle") && activeVehicleId && !editing) payload.vehicle_id = activeVehicleId;
        if (editing) await api.updateExpense(params.id!, payload); else await api.addExpense(payload);
      } else if (kind === "shift") {
        const hrs = parseFloat(hours);
        if (!hrs || hrs <= 0) { show("Enter your online hours", "error"); setSaving(false); return; }
        const payload: any = { date: iso, hours: hrs, platform, note };
        // Active hours per app (multi-apping). Backend sums the total.
        const abp: Record<string, number> = {};
        Object.entries(activeByPlatform).forEach(([k, v]) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n > 0) abp[k] = n;
        });
        const activeTotal = Object.values(abp).reduce((a, b) => a + b, 0);
        if (activeTotal > hrs + 0.01) { show("Active hours can't be more than online hours", "error"); setSaving(false); return; }
        if (Object.keys(abp).length) payload.active_by_platform = abp;
        if (validTime(startTime)) payload.start_time = startTime;
        if (validTime(endTime)) payload.end_time = endTime;
        if (activeVehicleId && !editing) payload.vehicle_id = activeVehicleId;
        if (editing) await api.updateShift(params.id!, payload); else await api.addShift(payload);
      } else {
        const km = parseFloat(distance);
        if (!km || km <= 0) { show("Enter a distance", "error"); setSaving(false); return; }
        if (km > 2000) { show("That distance looks too high — please check (max 2000 km per trip)", "error"); setSaving(false); return; }
        const mins = parseFloat(minutes);
        const payload: any = { date: iso, distance_km: km, type: tripType, purpose, note };
        if (activeVehicleId && !editing) payload.vehicle_id = activeVehicleId;
        if (fromLabel) payload.from_label = fromLabel;
        if (toLabel) payload.to_label = toLabel;
        if (tripType === "mixed") {
          const pct = parseFloat(businessPct);
          payload.business_pct = isNaN(pct) ? 50 : Math.max(0, Math.min(100, pct));
        }
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
      else if (kind === "shift") await api.deleteShift(params.id!);
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
                <Field label="What was this trip for?" hint="GigTax records the journey first, then you classify it.">
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    {TRIP_TYPES.map((tt) => {
                      const active = tripType === tt.key;
                      const c = (colors as any)[tt.color] || colors.accent;
                      return (
                        <Pressable key={tt.key} testID={`entry-triptype-${tt.key}`}
                          onPress={() => {
                            setTripType(tt.key);
                            setPurpose(tt.key === "personal" ? "personal_other" : "deliver");
                          }}
                          style={{ flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: "center",
                            backgroundColor: colors.surfaceAlt,
                            borderWidth: 1, borderColor: active ? c : colors.border }}>
                          <AppText variant="bodySemi" color={active ? c : colors.text}>{tt.label}</AppText>
                        </Pressable>
                      );
                    })}
                  </View>
                </Field>
                {tripType === "mixed" ? (
                  <Field label="Business portion (%)" hint="How much of this trip was business?">
                    <Input testID="entry-business-pct" value={businessPct} onChangeText={setBusinessPct} keyboardType="number-pad" placeholder="50" maxLength={3} />
                  </Field>
                ) : null}
                <Field label="Purpose">
                  <ChipRow
                    options={(tripType === "personal" ? PRIVATE_PURPOSES : BUSINESS_PURPOSES).map((p) => ({ key: p.key, label: p.label }))}
                    value={purpose} onChange={setPurpose} testIDPrefix="entry-purpose" />
                </Field>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Field label="From (optional)">
                      <Input testID="entry-from" value={fromLabel} onChangeText={setFromLabel} placeholder="Home" />
                    </Field>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label="To (optional)">
                      <Input testID="entry-to" value={toLabel} onChangeText={setToLabel} placeholder="Restaurant" />
                    </Field>
                  </View>
                </View>
              </>
            ) : kind === "shift" ? (
              <>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Field label="Start time" hint="Optional · 24h">
                      <Input testID="entry-start" value={startTime} onChangeText={setStartTime} keyboardType="numbers-and-punctuation" placeholder="17:30" />
                    </Field>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label="End time" hint="Optional · 24h">
                      <Input testID="entry-end" value={endTime} onChangeText={setEndTime} keyboardType="numbers-and-punctuation" placeholder="22:15" />
                    </Field>
                  </View>
                </View>
                <Field label="Hours online" hint="Auto-filled from start/end, or type it in. Total time logged on — your $/online hour.">
                  <Input testID="entry-hours" value={hours} onChangeText={setHours} keyboardType="decimal-pad" placeholder="6.5" />
                </Field>
                <Field label="Active hours per app" hint="Time actually on a job (making money) for each app. Powers your $/active hour & utilisation.">
                  <View style={{ gap: 8 }}>
                    {(profile?.platforms?.length ? profile.platforms : ["Other"]).map((p) => (
                      <View key={p} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                        <AppText variant="bodyMed" style={{ flex: 1 }}>{p}</AppText>
                        <View style={{ width: 120 }}>
                          <Input testID={`entry-active-${p}`} value={activeByPlatform[p] || ""}
                            onChangeText={(v) => setActiveByPlatform((m) => ({ ...m, [p]: v }))}
                            keyboardType="decimal-pad" placeholder="hrs" />
                        </View>
                      </View>
                    ))}
                  </View>
                </Field>
              </>
            ) : kind === "income" ? (
              // Income field order: Date → Platform → Amount → GST → Note.
              <>
                <Field label="Date">
                  <DateField testID="entry-date" value={dateISO} onChange={setDateISO} maxToday />
                </Field>
                <Field label="Platform">
                  <ChipRow options={(profile?.platforms?.length ? profile.platforms : ["Other"]).map((p) => ({ key: p, label: p }))}
                    value={platform} onChange={setPlatform} testIDPrefix="entry-platform" />
                </Field>
                <Field label="Amount"
                  hint={carriesPassengers
                    ? "Rideshare: enter the FULL passenger fare before the platform's commission — GST is calculated on the whole fare."
                    : undefined}>
                  <Input testID="entry-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
                </Field>
                {carriesPassengers ? (
                  <View style={{ flexDirection: "row", alignItems: "flex-start", backgroundColor: colors.surfaceAlt,
                    borderRadius: 10, padding: 10, marginBottom: 14 }}>
                    <Ionicons name="information-circle" size={16} color={colors.accent} style={{ marginRight: 8, marginTop: 1 }} />
                    <AppText variant="caption" color={colors.dim} style={{ flex: 1, lineHeight: 16 }}>
                      {"Log the platform's commission separately as an expense (category \u201COther\u201D) — it's deductible and, if you're GST-registered, gives you a GST credit."}
                    </AppText>
                  </View>
                ) : null}
                <Field label="GST treatment">
                  <ChipRow options={TAX_TREATMENTS.map((t) => ({ key: t.key, label: t.label }))} value={treatment} onChange={setTreatment} testIDPrefix="entry-treatment" />
                </Field>
              </>
            ) : (
              // Expense field order: Date+Amount → GST → Supplier → Category → Note.
              <>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Field label="Date">
                      <DateField testID="entry-date" value={dateISO} onChange={setDateISO} maxToday />
                    </Field>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label="Amount">
                      <Input testID="entry-amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" />
                    </Field>
                  </View>
                </View>
                <Field label="GST">
                  <Select testID="entry-treatment" value={treatment} onChange={setTreatment}
                    options={TAX_TREATMENTS.map((t) => ({ key: t.key, label: t.label, desc: t.desc }))} />
                </Field>
                <Field label="Supplier (optional)">
                  <Input testID="entry-merchant" value={merchant} onChangeText={setMerchant} placeholder="Shell, Officeworks…" />
                </Field>
                <Field label="Category">
                  <Select testID="entry-category" value={category} onChange={setCategory}
                    options={CATEGORIES.map((c) => ({ key: c.key, label: c.label, icon: c.icon }))} />
                </Field>
                {category === "fuel" ? (
                  <Field label="Litres (optional)">
                    <Input testID="entry-liters" value={liters} onChangeText={setLiters}
                      keyboardType="decimal-pad" placeholder="e.g. 42.15" />
                  </Field>
                ) : null}
                {receiptImage ? (
                  <Field label="Receipt">
                    <Image source={{ uri: `data:image/jpeg;base64,${receiptImage}` }}
                      style={{ width: 90, height: 120, borderRadius: 10, borderWidth: 1, borderColor: colors.border }} contentFit="cover" />
                    <Pressable testID="entry-remove-receipt" onPress={() => setReceiptImage(null)}
                      hitSlop={8} style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
                      <Ionicons name="trash-outline" size={16} color={colors.loss} style={{ marginRight: 6 }} />
                      <AppText variant="caption" color={colors.loss}>Remove photo</AppText>
                    </Pressable>
                  </Field>
                ) : null}
              </>
            )}

            {kind === "shift" && (
              <Field label="Platform">
                <ChipRow options={(profile?.platforms?.length ? profile.platforms : ["Other"]).map((p) => ({ key: p, label: p }))}
                  value={platform} onChange={setPlatform} testIDPrefix="entry-platform" />
              </Field>
            )}

            {(kind === "trip" || kind === "shift") && (
              <Field label="Date">
                <DateField testID="entry-date" value={dateISO} onChange={setDateISO} maxToday />
              </Field>
            )}
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
