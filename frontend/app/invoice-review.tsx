import React, { useEffect, useRef, useState } from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { api, todayISO, type DupeLevel, type DupeReport } from "@/src/api";
import { isValidDate } from "@/src/date";
import { CATEGORIES } from "@/src/config";
import {
  AppText, Field, Input, DateField, Select, PrimaryButton, IconButton, useToast,
} from "@/src/ui";
import { receiptStash, type PendingReceipt } from "@/src/scanStash";
import { batchAlreadySavedLine, looksAlreadySaved } from "@/src/receiptDupe";
import { BatchSavedLine, DuplicateCard, PossibleHintLine, type DupeSide } from "@/src/DuplicateCard";

export default function InvoiceReview() {
  const { colors } = useTheme();
  const { refresh, activeVehicleId } = useStore();
  const { show } = useToast();
  const router = useRouter();
  const params = useLocalSearchParams<{
    amount?: string; date?: string; merchant?: string; category?: string;
    liters?: string; gst?: string; txn_time?: string; receipt_number?: string;
    abn?: string; card_last4?: string; pump?: string;
  }>();

  const batch = receiptStash.batch;
  const [index, setIndex] = useState(receiptStash.index || 0);
  const current: PendingReceipt | undefined = batch[index];

  const [supplier, setSupplier] = useState(current?.merchant || params.merchant || "");
  const [dateISO, setDateISO] = useState(
    (current?.date && isValidDate(current.date) ? current.date : "")
    || (params.date && isValidDate(params.date) ? params.date : todayISO()));
  const [category, setCategory] = useState(current?.category || (params.category as string) || "other");
  const [amount, setAmount] = useState(current?.amount || params.amount || "");
  const [hasGst, setHasGst] = useState(!!((current?.gst || params.gst) && (current?.gst || params.gst) !== ""));
  const [gst, setGst] = useState(current?.gst || params.gst || "");
  const [liters, setLiters] = useState(current?.liters || params.liters || "");
  const [txnTime, setTxnTime] = useState(current?.txnTime || params.txn_time || "");
  const [receiptNumber, setReceiptNumber] = useState(current?.receiptNumber || params.receipt_number || "");
  const [abn, setAbn] = useState(current?.abn || params.abn || "");
  const [cardLast4, setCardLast4] = useState(current?.cardLast4 || params.card_last4 || "");
  const [pump, setPump] = useState(current?.pump || params.pump || "");
  const [note, setNote] = useState("");
  const [receiptImage, setReceiptImage] = useState<string | null>(current?.image || receiptStash.image);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<DupeReport | null>(null);
  const [levels, setLevels] = useState<DupeLevel[]>(batch.map((item) => item.level));
  const keepWith = useRef<string[]>([]);
  const sentImage = useRef(false);
  const serverHashes = useRef<DupeReport["candidate"]>(null);

  const applyDraft = (item: PendingReceipt) => {
    setSupplier(item.merchant);
    setDateISO(item.date && isValidDate(item.date) ? item.date : todayISO());
    setCategory(item.category || "other");
    setAmount(item.amount);
    setHasGst(!!item.gst);
    setGst(item.gst);
    setLiters(item.liters);
    setTxnTime(item.txnTime);
    setReceiptNumber(item.receiptNumber);
    setAbn(item.abn);
    setCardLast4(item.cardLast4);
    setPump(item.pump);
    setNote("");
    setReceiptImage(item.image);
    setReport(null);
    keepWith.current = [];
    sentImage.current = false;
    serverHashes.current = null;
  };

  const advance = (nextLevel: DupeLevel) => {
    const nextLevels = levels.slice();
    nextLevels[index] = nextLevel;
    setLevels(nextLevels);
    if (batch.length && index < batch.length - 1) {
      const next = index + 1;
      receiptStash.index = next;
      setIndex(next);
      applyDraft(batch[next]);
      return;
    }
    receiptStash.image = null;
    receiptStash.batch = [];
    receiptStash.index = 0;
    router.back();
  };

  useEffect(() => {
    let cancel = false;
    const timer = setTimeout(async () => {
      const draft = batch[index];
      const amt = parseFloat(amount);
      const body: any = {
        date: dateISO,
        amount: Number.isNaN(amt) ? undefined : amt,
        merchant: supplier,
        category,
        txn_time: txnTime || undefined,
        receipt_number: receiptNumber || undefined,
        abn: abn || undefined,
        card_last4: cardLast4 || undefined,
        pump: pump || undefined,
        liters: liters ? parseFloat(liters) : undefined,
        note: note || undefined,
      };
      if (draft) {
        body.image_sha256 = draft.sha256;
        body.client_dhash = draft.dhash || undefined;
        body.client_ahash = draft.ahash || undefined;
        body.client_dhash_rots = draft.dhashRots;
        body.client_ahash_rots = draft.ahashRots;
      }
      const echoed = serverHashes.current;
      if (echoed?.image_dhash) {
        body.image_dhash = echoed.image_dhash;
        body.image_ahash = echoed.image_ahash;
        body.image_dhash_rots = echoed.image_dhash_rots;
        body.image_ahash_rots = echoed.image_ahash_rots;
      } else if (receiptImage && !sentImage.current) {
        body.image_base64 = receiptImage;
        sentImage.current = true;
      }
      try {
        const res = await api.checkExpense(body);
        if (cancel) return;
        if (res.candidate?.image_dhash) serverHashes.current = res.candidate;
        setReport(res);
        setLevels((prev) => {
          const copy = prev.slice();
          copy[index] = res.level;
          return copy;
        });
      } catch {
        if (!cancel) setReport(null);
      }
    }, 300);
    return () => { cancel = true; clearTimeout(timer); };
  }, [amount, dateISO, supplier, category, txnTime, receiptNumber, abn, cardLast4, pump, liters, note, index, receiptImage, batch]);

  const capture = async (remember?: string[]) => {
    const amt = parseFloat(amount);
    if (!amt) { show("Enter the sale total", "error"); return; }
    const gstNum = hasGst ? parseFloat(gst) : NaN;
    setSaving(true);
    try {
      const payload: any = {
        date: dateISO, amount: amt, category, merchant: supplier,
        tax_treatment: hasGst && gstNum > 0 ? "inclusive" : "out_of_scope",
        gst: hasGst && !isNaN(gstNum) ? gstNum : null,
        note,
        txn_time: txnTime || null,
        receipt_number: receiptNumber || null,
        abn: abn || null,
        card_last4: cardLast4 || null,
        pump: pump || null,
      };
      const l = parseFloat(liters);
      if (!isNaN(l)) payload.liters = l;
      if (receiptImage) payload.receipt_image = receiptImage;
      const draft = batch[index];
      if (draft) {
        payload.image_sha256 = draft.sha256;
        payload.client_dhash = draft.dhash || null;
        payload.client_ahash = draft.ahash || null;
        payload.client_dhash_rots = draft.dhashRots;
        payload.client_ahash_rots = draft.ahashRots;
      }
      const echoed = serverHashes.current;
      if (echoed?.image_dhash) {
        payload.image_dhash = echoed.image_dhash;
        payload.image_ahash = echoed.image_ahash;
        payload.image_dhash_rots = echoed.image_dhash_rots;
        payload.image_ahash_rots = echoed.image_ahash_rots;
      }
      const keep = remember || keepWith.current;
      if (keep.length) payload.keep_with = keep;
      if ((category === "fuel" || category === "vehicle") && activeVehicleId) payload.vehicle_id = activeVehicleId;
      await api.addExpense(payload);
      show("Invoice captured", "success");
      refresh();
      setSaving(false);
      advance(null);
    } catch {
      show("Couldn't save — try again", "error");
      setSaving(false);
    }
  };

  const level = report?.level || null;
  const match = report?.match || report?.duplicate?.match || null;
  const mine: DupeSide = {
    merchant: supplier, date: dateISO, time: txnTime,
    amount: parseFloat(amount),
    image: receiptImage,
  };
  const saved: DupeSide = {
    merchant: match?.merchant || "",
    date: match?.date || "",
    time: match?.txn_time || "",
    amount: match?.amount ?? null,
    image: match?.thumb || null,
  };
  const summary = batchAlreadySavedLine(levels.length ? levels : batch.map((item) => item.level));

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
          <AppText variant="h2">{batch.length > 1 ? `Review ${index + 1} of ${batch.length}` : "Review invoice"}</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 20 }}
          showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          {summary ? <BatchSavedLine text={summary} /> : null}
          {looksAlreadySaved(level) && match ? (
            <DuplicateCard
              mine={mine}
              saved={saved}
              onDiscard={() => advance(null)}
              onKeep={() => { if (match.id) capture([match.id]); }}
              onView={() => {
                if (match.id) router.push({ pathname: "/entry", params: { type: "expense", id: match.id } } as any);
              }}
            />
          ) : null}
          {level === "possible" ? <PossibleHintLine /> : null}

          <Field label="Supplier">
            <Input testID="invoice-supplier" value={supplier} onChangeText={setSupplier} placeholder="Shell, Officeworks…" />
          </Field>

          <Field label="Date">
            <DateField testID="invoice-date" value={dateISO} onChange={setDateISO} maxToday />
          </Field>

          <Field label="Time (optional)">
            <Input testID="invoice-time" value={txnTime} onChangeText={setTxnTime} placeholder="08:14" />
          </Field>

          <Field label="Category">
            <Select testID="invoice-category" value={category} onChange={setCategory}
              options={CATEGORIES.map((c) => ({ key: c.key, label: c.label, icon: c.icon }))} />
          </Field>

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

          <Field label="Litres (optional)">
            <Input testID="invoice-liters" value={liters} onChangeText={setLiters}
              keyboardType="decimal-pad" placeholder="e.g. 42.15" />
          </Field>

          <Field label="Receipt number (optional)">
            <Input testID="invoice-receipt-number" value={receiptNumber} onChangeText={setReceiptNumber} placeholder="Invoice or docket number" />
          </Field>
          <Field label="ABN (optional)">
            <Input testID="invoice-abn" value={abn} onChangeText={setAbn} placeholder="00 000 000 000" />
          </Field>
          <Field label="Card last 4 (optional)">
            <Input testID="invoice-card" value={cardLast4} onChangeText={setCardLast4} keyboardType="number-pad" placeholder="1234" />
          </Field>
          {category === "fuel" ? (
            <Field label="Pump (optional)">
              <Input testID="invoice-pump" value={pump} onChangeText={setPump} placeholder="4" />
            </Field>
          ) : null}

          <Field label="Note (optional)">
            <Input testID="invoice-note" value={note} onChangeText={setNote}
              placeholder="Anything to remember" multiline numberOfLines={3}
              style={{ height: 84, textAlignVertical: "top" }} />
          </Field>

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

        <SafeAreaView edges={["bottom"]} style={{ paddingHorizontal: 16, paddingTop: 6 }}>
          <PrimaryButton testID="invoice-capture" label={saving ? "Capturing…" : "Capture Invoice"}
            icon="checkmark-circle-outline" onPress={() => capture()} disabled={saving} />
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}
