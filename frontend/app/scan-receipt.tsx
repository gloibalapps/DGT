import React, { useState } from "react";
import { View, Pressable, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";

import { useTheme } from "@/src/theme";
import { api, todayISO, type DupeLevel } from "@/src/api";
import { AppText, Card, IconButton, PrimaryButton, SecondaryButton, Spinner, useToast } from "@/src/ui";
import { hashReceipt } from "@/src/receiptHash";
import { looksAlreadySaved } from "@/src/receiptDupe";
import { receiptStash, type PendingReceipt } from "@/src/scanStash";

function str(value: unknown): string {
  return value == null || value === "" ? "" : String(value);
}

export default function ScanReceipt() {
  const { colors } = useTheme();
  const { show } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Checking this photo…");

  const inspect = async (base64: string): Promise<PendingReceipt> => {
    const hashed = await hashReceipt(base64);
    const blank: PendingReceipt = {
      image: base64, sha256: hashed.sha256, dhash: hashed.dhash, ahash: hashed.ahash,
      dhashRots: hashed.dhashRots, ahashRots: hashed.ahashRots,
      amount: "", date: "", merchant: "", category: "other", liters: "", gst: "",
      txnTime: "", receiptNumber: "", abn: "", cardLast4: "", pump: "",
      level: null, scanSkipped: false,
    };
    const hashes = {
      image_sha256: hashed.sha256,
      client_dhash: hashed.dhash || undefined,
      client_ahash: hashed.ahash || undefined,
      client_dhash_rots: hashed.dhashRots,
      client_ahash_rots: hashed.ahashRots,
    };
    try {
      const pre = await api.checkExpense(hashes);
      if (looksAlreadySaved(pre.level) && (pre.reason === "exact_image" || pre.reason === "perceptual")) {
        const m = pre.match || {};
        return {
          ...blank,
          amount: str(m.amount), date: m.date || "", merchant: m.merchant || "",
          category: m.category || "other", liters: str(m.liters), gst: str(m.gst),
          txnTime: m.txn_time || "", receiptNumber: m.receipt_number || "",
          abn: m.abn || "", cardLast4: m.card_last4 || "", pump: m.pump || "",
          level: pre.level, scanSkipped: true,
        };
      }
    } catch {
      // The scan route repeats the exact-file check before it calls the model.
    }
    setStatus("Reading your receipt…");
    const data = await api.scanReceipt(base64);
    const level = (data.duplicate?.level || data.level || null) as DupeLevel;
    return {
      ...blank,
      amount: str(data.amount), date: data.date || "", merchant: data.merchant || "",
      category: data.category || "other", liters: str(data.liters), gst: str(data.gst),
      txnTime: data.txn_time || "", receiptNumber: data.receipt_number || "",
      abn: data.abn || "", cardLast4: data.card_last4 || "", pump: data.pump || "",
      level: looksAlreadySaved(level) || level === "possible" ? level : null,
      scanSkipped: Boolean(data.scan_skipped),
    };
  };

  const process = async (photos: string[]) => {
    if (!photos.length) return;
    setBusy(true);
    setStatus("Checking this photo…");
    try {
      const batch: PendingReceipt[] = [];
      for (let i = 0; i < photos.length; i++) {
        setStatus(photos.length > 1 ? `Checking ${i + 1} of ${photos.length}…` : "Checking this photo…");
        batch.push(await inspect(photos[i]));
      }
      receiptStash.batch = batch;
      receiptStash.index = 0;
      receiptStash.image = batch[0].image;
      const first = batch[0];
      router.replace({
        pathname: "/invoice-review" as any,
        params: {
          amount: first.amount, date: first.date || todayISO(), merchant: first.merchant,
          category: first.category, liters: first.liters, gst: first.gst,
          txn_time: first.txnTime, receipt_number: first.receiptNumber, abn: first.abn,
          card_last4: first.cardLast4, pump: first.pump,
        },
      });
    } catch {
      show("Couldn't read that receipt — try again or add manually", "error");
      setBusy(false);
    }
  };

  const takePhoto = async () => {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      show("Camera access needed to scan receipts", "error");
      if (!perm.canAskAgain) Linking.openSettings();
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.5, base64: true, allowsEditing: true });
    if (!res.canceled && res.assets[0]?.base64) process([res.assets[0].base64]);
  };

  const pickLibrary = async () => {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      show("Photo access needed to pick a receipt", "error");
      if (!perm.canAskAgain) Linking.openSettings();
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      quality: 0.5, base64: true, allowsEditing: false, allowsMultipleSelection: true,
      mediaTypes: ["images"], selectionLimit: 10,
    });
    const photos = (res.assets || []).map((a) => a.base64).filter((b): b is string => !!b);
    if (!res.canceled && photos.length) process(photos);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID="scan-close" onPress={() => router.back()} />
          <AppText variant="h2">Scan receipt</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>

      <View style={{ flex: 1, padding: 16, justifyContent: "center" }}>
        {busy ? (
          <View style={{ alignItems: "center" }}>
            <Spinner />
            <AppText variant="bodyMed" color={colors.dim} style={{ marginTop: 12 }}>{status}</AppText>
          </View>
        ) : (
          <>
            <Card style={{ alignItems: "center", marginBottom: 24, paddingVertical: 32 }}>
              <View style={{ width: 84, height: 84, borderRadius: 999, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                <Ionicons name="receipt-outline" size={40} color={colors.accent} />
              </View>
              <AppText variant="h2" style={{ marginBottom: 6 }}>Snap it, we'll read it</AppText>
              <AppText variant="body" color={colors.dim} style={{ textAlign: "center" }}>
                We extract the amount, date, supplier, GST and receipt details. You review everything before it saves.
              </AppText>
            </Card>
            <PrimaryButton testID="scan-camera" label="Take photo" icon="camera-outline" onPress={takePhoto} style={{ marginBottom: 12 }} />
            <SecondaryButton testID="scan-library" label="Choose from library" icon="images-outline" onPress={pickLibrary} />
          </>
        )}
      </View>
    </View>
  );
}
