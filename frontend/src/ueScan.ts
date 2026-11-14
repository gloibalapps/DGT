import { Linking } from "react-native";
import * as ImagePicker from "expo-image-picker";

import { api } from "@/src/api";
import { scanPayloadTooLarge, type UEJob } from "@/src/ueParse";

export type ScanResult = { jobs: UEJob[]; rejected: number } | { error: string } | null;

/** Camera or library shot of Uber's earnings list. Nothing is saved here. */
export async function captureGuaranteePhoto(source: "camera" | "library"): Promise<ScanResult> {
  if (source === "camera") {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain) Linking.openSettings();
      return { error: "Camera access needed to photograph the screen" };
    }
  } else {
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain) Linking.openSettings();
      return { error: "Photo access needed to choose a screenshot" };
    }
  }
  const opts: ImagePicker.ImagePickerOptions = { quality: 0.5, base64: true, allowsEditing: false, mediaTypes: ["images"] };
  const res = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled || !res.assets[0]?.base64) return null;
  const image = res.assets[0].base64;
  if (scanPayloadTooLarge(image)) return { error: "That photo is too large" };
  try {
    const data = await api.scanUeJobs(image);
    return { jobs: (data.jobs || []).map((j) => ({ ...j, platform: j.platform || "Uber Eats" })), rejected: data.rejected || 0 };
  } catch {
    return { error: "Couldn't read that screen — try again or add the jobs yourself" };
  }
}
