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
  backup_state?: "idle" | "running" | "done" | "error";
  last_error?: string | null;
}

// Start a backup on the server (it runs in the background) and wait until it
// finishes. Resolves with the final status; throws with the server's reason.
export async function runBackupAndWait(maxWaitMs = 5 * 60 * 1000): Promise<BackupStatus> {
  await api.runBackup();
  const until = Date.now() + maxWaitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2500));
    let st: BackupStatus;
    try { st = await api.backupStatus(); } catch { continue; }
    if (st.backup_state === "done") return st;
    if (st.backup_state === "error") throw new Error(st.last_error || "Backup failed");
  }
  throw new Error("Backup is still running — check back in a minute");
}

export function backupErrorText(e: any): string {
  const m = String(e?.message || "");
  // api errors look like `503: {"detail":"..."}` — surface the detail
  const j = m.match(/"detail"\s*:\s*"([^"]+)"/);
  return j ? j[1] : m.replace(/^\d{3}:\s*/, "") || "Backup failed";
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
    await runBackupAndWait();
    await storage.setItem(LAST_AUTO_KEY, Date.now());
  } catch {
    /* offline / not connected — try again next open */
  }
}
