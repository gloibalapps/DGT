import React, { useState } from "react";
import { View, Pressable, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";

import { useTheme } from "@/src/theme";
import { api } from "@/src/api";
import { AppText, Card, IconButton, PrimaryButton, SecondaryButton, Spinner, useToast } from "@/src/ui";
import { receiptStash } from "@/src/scanStash";

export default function ScanReceipt() {
  const { colors } = useTheme();
  const { show } = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const process = async (base64: string) => {
    setBusy(true);
    try {
      const data = await api.scanReceipt(base64);
      receiptStash.image = base64;
      router.replace({
        pathname: "/invoice-review" as any,
        params: {
          amount: data.amount != null ? String(data.amount) : "",
          date: data.date || "", merchant: data.merchant || "", category: data.category || "other",
          liters: data.liters != null ? String(data.liters) : "",
          gst: data.gst != null ? String(data.gst) : "",
        },
      });
    } catch (e) {
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
    if (!res.canceled && res.assets[0]?.base64) process(res.assets[0].base64);
  };

  const pickLibrary = async () => {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      show("Photo access needed to pick a receipt", "error");
      if (!perm.canAskAgain) Linking.openSettings();
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ quality: 0.5, base64: true, allowsEditing: true, mediaTypes: ["images"] });
    if (!res.canceled && res.assets[0]?.base64) process(res.assets[0].base64);
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
            <AppText variant="bodyMed" color={colors.dim} style={{ marginTop: 12 }}>Reading your receipt…</AppText>
          </View>
        ) : (
          <>
            <Card style={{ alignItems: "center", marginBottom: 24, paddingVertical: 32 }}>
              <View style={{ width: 84, height: 84, borderRadius: 999, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
                <Ionicons name="receipt-outline" size={40} color={colors.accent} />
              </View>
              <AppText variant="h2" style={{ marginBottom: 6 }}>Snap it, we'll read it</AppText>
              <AppText variant="body" color={colors.dim} style={{ textAlign: "center" }}>
                We extract amount, date, supplier and category. You review everything before it saves.
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
