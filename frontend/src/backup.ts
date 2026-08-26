import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { api } from "@/src/api";
import { storage } from "@/src/utils/storage";

const LAST_AUTO_KEY = "gigtax.last_auto_backup";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackupStatus {
  connected: boolean;
  needs_reauth?: boolean;
  email?: string | null;
  last_backup_at?: string | null;
  last_backup_count?: number | null;
}

// Open the Google consent flow to grant Drive access for backups.
// Returns the refreshed status after the browser closes.
export async function connectDrive(): Promise<BackupStatus> {
  const redirect = Platform.OS === "web" ? window.location.origin + "/" : Linking.createURL("/");
  const url = await api.driveConnectUrl(redirect);
  if (Platform.OS === "web") {
    window.location.href = url;
    return { connected: false }; // page navigates away
  }
  await WebBrowser.openAuthSessionAsync(url, redirect);
  // Give the backend a moment, then re-check.
  return api.backupStatus();
}

// Auto-backup at most once every 24h, only if Drive is connected.
// Safe to call on app open — never throws.
export async function maybeAutoBackup(): Promise<void> {
  try {
    const last = await storage.getItem<number>(LAST_AUTO_KEY, 0);
    if (last && Date.now() - last < DAY_MS) return;
    const status: BackupStatus = await api.backupStatus();
    if (!status.connected) return;
    await api.runBackup();
    await storage.setItem(LAST_AUTO_KEY, Date.now());
  } catch {
    /* offline / not connected — try again next open */
  }
}
