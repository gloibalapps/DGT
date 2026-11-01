import React, { useCallback, useState, useEffect } from "react";
import { View, Pressable, ScrollView, Linking, Platform, Alert } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { useTheme, FONT } from "@/src/theme";
import { useStore } from "@/src/store";
import { useAuth } from "@/src/auth";
import { useSubscription } from "@/src/subscription";
import { api, resetLocalProfileId } from "@/src/api";
import {
  isAutotrackEnabled, enableAutotrack, disableAutotrack,
} from "@/src/autotrack";
import * as IntentLauncher from "expo-intent-launcher";
import {
  WORK_TYPES, platformsForWorkType, US_STATES, US_NO_INCOME_TAX_STATES, COUNTRIES, WEEK_DAYS, flagUrl,
} from "@/src/config";
import {
  Screen, ScreenHeader, Card, AppText, Spinner, ChipRow, Input, Field,
  PrimaryButton, SecondaryButton, useToast,
} from "@/src/ui";
import { connectDrive, runBackupAndWait, backupErrorText, type BackupStatus } from "@/src/backup";
import { isoToAU } from "@/src/date";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ marginBottom: 18 }}>
      <AppText variant="label" color={colors.dim} style={{ marginBottom: 8, marginLeft: 4 }}>{title.toUpperCase()}</AppText>
      <Card>{children}</Card>
    </View>
  );
}

export default function Settings() {
  const { colors, mode, toggle } = useTheme();
  const { profile, updateProfile, version, vehicles, activeVehicleId, setActiveVehicle, reloadProfile, reloadVehicles, refresh } = useStore();
  const { user, signIn, signingIn, signOut } = useAuth();
  const { isActive: subActive, managed: subManaged, presentCustomerCenter } = useSubscription();
  const { show } = useToast();
  const router = useRouter();

  const [bizPct, setBizPct] = useState<number | null>(null);
  const [autoOn, setAutoOn] = useState(false);
  const [name, setName] = useState("");

  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const doDeleteAccount = async () => {
    setDeleting(true);
    try {
      await api.deleteAccount();
      try { await signOut(); } catch { /* auth may be disabled */ }
      await resetLocalProfileId();
      await reloadProfile();
      await reloadVehicles();
      show("Your account and data have been deleted", "success");
      setConfirmDelete(false);
      router.replace("/" as any);
    } catch {
      show("Couldn't delete account — please try again", "error");
    } finally {
      setDeleting(false);
    }
  };

  const loadBackup = useCallback(async () => {
    try { setBackup(await api.backupStatus()); } catch { /* ignore */ }
  }, []);

  const onConnectDrive = async () => {
    setBackupBusy(true);
    try {
      const st = await connectDrive();
      setBackup(st);
      show(st.connected ? "Google Drive connected" : "Drive not connected", st.connected ? "success" : "info");
    } catch { show("Couldn't connect Google Drive", "error"); }
    finally { setBackupBusy(false); }
  };

  const onBackupNow = async () => {
    setBackupBusy(true);
    try {
      const r = await runBackupAndWait();
      const n = r.last_backup_count ?? 0;
      show(`Backed up ${n} receipt${n === 1 ? "" : "s"} + all data to Drive`, "success");
      setBackup(r);
    } catch (e) {
      show(backupErrorText(e), "error");
      await loadBackup();
    }
    finally { setBackupBusy(false); }
  };

  const onDisconnectDrive = async () => {
    setBackupBusy(true);
    try { await api.disconnectBackup(); setBackup({ connected: false }); show("Drive disconnected", "info"); }
    catch { /* ignore */ }
    finally { setBackupBusy(false); }
  };

  const doRestore = async () => {
    setBackupBusy(true);
    try {
      const r = await api.restoreBackup();
      const t = r?.total ?? 0;
      show(t ? `Restored ${t} record${t === 1 ? "" : "s"} from Drive` : "Nothing to restore yet", "success");
      await reloadVehicles?.();
      refresh?.();
      await loadBackup();
    } catch {
      show("Restore failed — reconnect Drive and try again", "error");
    } finally { setBackupBusy(false); }
  };

  const onRestore = () => {
    Alert.alert(
      "Restore from Drive",
      "Pull your latest Google Drive backup (income, expenses, trips, vehicles & receipts) onto this device. Matching records are updated — nothing is duplicated.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Restore", onPress: doRestore },
      ],
    );
  };

  useEffect(() => {
    if (!profile) return;
    setName(profile.driver_name || "");
  }, [profile]);

  const loadPct = useCallback(async () => {
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const rep = await api.report("year", today);
      setBizPct(rep.business_use_pct);
    } catch { /* ignore */ }
  }, []);
  useFocusEffect(useCallback(() => { loadPct(); isAutotrackEnabled().then(setAutoOn); loadBackup(); }, [loadPct, version, loadBackup]));

  const toggleAuto = async () => {
    if (autoOn) {
      await disableAutotrack();
      setAutoOn(false);
      show("Automatic drive detection turned off", "info");
      return;
    }
    const res = await enableAutotrack();
    if (res.ok) {
      setAutoOn(true);
      show("Auto detection on — drives log themselves", "success");
    } else if (res.reason === "unsupported") {
      show("Auto tracking needs a native build — not Expo Go or web preview", "error");
    } else if (res.canAskAgain === false) {
      show("Open Settings → Location and choose “Allow all the time” to detect drives in the background", "error");
      Linking.openSettings();
    } else {
      show("Background location is required — please allow it to detect drives", "error");
    }
  };

  const openBatterySettings = async () => {
    try { await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS); }
    catch {
      try { await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.BATTERY_SAVER_SETTINGS); }
      catch { Linking.openSettings(); }
    }
  };

  if (!profile) return <Screen><Spinner /></Screen>;

  const taxComplete = !!profile.legal_name && (profile.registration_status === "registered" || profile.registration_status === "not_registered");

  return (
    <Screen header={<ScreenHeader subtitle="Account & settings" title="Profile" />} scroll>
      {/* Account */}
      {user ? (
        <Section title="Account">
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {user.picture ? (
              <Image source={{ uri: user.picture }} style={{ width: 44, height: 44, borderRadius: 22, marginRight: 12 }} contentFit="cover" />
            ) : (
              <View style={{ width: 44, height: 44, borderRadius: 22, marginRight: 12, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="person" size={22} color={colors.dim} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <AppText variant="bodySemi">{user.name || "Signed in"}</AppText>
              <AppText variant="caption" color={colors.dim}>{user.email}</AppText>
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10 }}>
            <Ionicons name="cloud-done-outline" size={15} color={colors.profit} style={{ marginRight: 6 }} />
            <AppText variant="caption" color={colors.dim}>Your data syncs securely across your phones.</AppText>
          </View>
          <Pressable testID="set-signout" onPress={signOut}
            style={{ marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "center",
              paddingVertical: 12, borderRadius: 16, borderWidth: 1, borderColor: colors.border }}>
            <Ionicons name="log-out-outline" size={18} color={colors.loss} style={{ marginRight: 8 }} />
            <AppText variant="bodySemi" color={colors.loss}>Sign out</AppText>
          </Pressable>
        </Section>
      ) : (
        <Section title="Account">
          <AppText variant="bodySemi">Sign in to sync &amp; back up</AppText>
          <AppText variant="caption" color={colors.dim} style={{ marginTop: 2 }}>
            Sign in with Google to keep your data safe and sync it across your phones. You can keep using the app without signing in.
          </AppText>
          <Pressable testID="set-signin" onPress={signIn} disabled={signingIn}
            style={{ marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "center",
              paddingVertical: 12, borderRadius: 16, backgroundColor: colors.accent, opacity: signingIn ? 0.6 : 1 }}>
            <Ionicons name="logo-google" size={18} color="#F1F5F9" style={{ marginRight: 8 }} />
            <AppText variant="bodySemi" color="#F1F5F9">{signingIn ? "Signing in…" : "Sign in with Google"}</AppText>
          </Pressable>
        </Section>
      )}

      {/* Subscription */}
      <Section title="Subscription">
        <Pressable testID="set-subscription" onPress={() => router.push("/paywall" as any)}
          style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
            alignItems: "center", justifyContent: "center", marginRight: 12, overflow: "hidden" }}>
            <Image source={require("@/assets/images/logo-light.png")}
              style={{ width: 40, height: 40 }} contentFit="cover" />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="bodySemi">{subActive ? "GigTax" : "Subscribe to GigTax"}</AppText>
            <AppText variant="caption" color={colors.dim}>
              {subActive ? "Your subscription is active" : "14-day free trial · cancel anytime"}
            </AppText>
          </View>
          {subActive ? (
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.profit }}>
              <AppText variant="caption" color={colors.bg} style={{ fontFamily: FONT.bold }}>ACTIVE</AppText>
            </View>
          ) : (
            <Ionicons name="chevron-forward" size={20} color={colors.dim} />
          )}
        </Pressable>

        {/* Customer Center — manage / cancel / restore (native build only) */}
        {subActive && subManaged ? (
          <Pressable testID="set-manage-subscription" onPress={() => void presentCustomerCenter()}
            style={{ flexDirection: "row", alignItems: "center", marginTop: 14,
              borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
              alignItems: "center", justifyContent: "center", marginRight: 12 }}>
              <Ionicons name="settings-outline" size={20} color={colors.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText variant="bodySemi">Manage subscription</AppText>
              <AppText variant="caption" color={colors.dim}>Change plan, restore or cancel</AppText>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.dim} />
          </Pressable>
        ) : null}
      </Section>

      {/* Backups — Google Drive */}
      <Section title="Backups">
        {backup?.connected ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
                alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                <Ionicons name="cloud-done" size={20} color={colors.profit} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText variant="bodySemi">Google Drive connected</AppText>
                <AppText variant="caption" color={colors.dim} numberOfLines={1}>
                  {backup.email || "Your Drive"}
                  {backup.last_backup_at ? ` · last backup ${new Date(backup.last_backup_at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : " · not backed up yet"}
                </AppText>
              </View>
            </View>
            {backup.backup_state === "error" && backup.last_error ? (
              <AppText testID="backup-error" variant="caption" color={colors.loss} style={{ marginTop: 10 }}>
                Last backup failed: {backup.last_error}
              </AppText>
            ) : null}
            <PrimaryButton testID="backup-now" label={backupBusy || backup.backup_state === "running" ? "Backing up…" : "Back up now"}
              icon="cloud-upload" onPress={onBackupNow} disabled={backupBusy} style={{ marginTop: 14 }} />
            <SecondaryButton testID="backup-restore" label="Restore from Drive"
              icon="cloud-download-outline" onPress={onRestore} disabled={backupBusy} style={{ marginTop: 10 }} />
            <Pressable testID="backup-how" onPress={() => setHowOpen((o) => !o)} hitSlop={6}
              style={{ flexDirection: "row", alignItems: "center", marginTop: 14 }}>
              <Ionicons name="help-circle-outline" size={16} color={colors.dim} style={{ marginRight: 6 }} />
              <AppText variant="caption" color={colors.dim} style={{ flex: 1 }}>How backups work</AppText>
              <Ionicons name={howOpen ? "chevron-up" : "chevron-down"} size={16} color={colors.dim} />
            </Pressable>
            {howOpen ? (
              <AppText variant="caption" color={colors.dim} style={{ marginTop: 8, lineHeight: 18 }}>
                Your scanned receipts, plus a CSV and a full backup of your income, expenses & trips, are saved to a “GigTax Backups” folder in your Drive. Backs up automatically once a day when you open the app. On a new phone, connect the same Google account and tap “Restore from Drive”.
              </AppText>
            ) : null}
            <Pressable testID="backup-disconnect" onPress={onDisconnectDrive} disabled={backupBusy}
              hitSlop={8} style={{ marginTop: 14, alignItems: "center" }}>
              <AppText variant="caption" color={colors.loss}>Disconnect Google Drive</AppText>
            </Pressable>
          </>
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
                alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                <Ionicons name="cloud-outline" size={20} color={colors.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText variant="bodySemi">Back up to Google Drive</AppText>
                <AppText variant="caption" color={colors.dim}>
                  {backup?.needs_reauth ? "Reconnect needed — please connect again" : "Keep your receipts & records safe in your own Drive"}
                </AppText>
              </View>
            </View>
            <PrimaryButton testID="backup-connect" label={backupBusy ? "Connecting…" : "Connect Google Drive"}
              icon="logo-google" onPress={onConnectDrive} disabled={backupBusy} style={{ marginTop: 12 }} />
          </>
        )}
      </Section>

      {/* Help & user guide */}
      <Section title="Help">
        <Pressable testID="set-manual" onPress={() => router.push("/manual" as any)}
          style={{ flexDirection: "row", alignItems: "center" }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
            alignItems: "center", justifyContent: "center", marginRight: 12 }}>
            <Ionicons name="book" size={20} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="bodySemi">User guide</AppText>
            <AppText variant="caption" color={colors.dim}>How to log trips, expenses & read your tax reports</AppText>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.dim} />
        </Pressable>
        <Pressable testID="set-privacy" onPress={() => router.push("/privacy" as any)}
          style={{ flexDirection: "row", alignItems: "center", marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
            alignItems: "center", justifyContent: "center", marginRight: 12 }}>
            <Ionicons name="shield-checkmark" size={20} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="bodySemi">Privacy Policy</AppText>
            <AppText variant="caption" color={colors.dim}>How we handle your data</AppText>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.dim} />
        </Pressable>
        <Pressable testID="set-terms" onPress={() => router.push("/terms" as any)}
          style={{ flexDirection: "row", alignItems: "center", marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
            alignItems: "center", justifyContent: "center", marginRight: 12 }}>
            <Ionicons name="document-text" size={20} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="bodySemi">Terms of Service</AppText>
            <AppText variant="caption" color={colors.dim}>The rules for using GigTax</AppText>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.dim} />
        </Pressable>
      </Section>
      <Section title="Driver">
        <Field label="Your name" hint="Shown on your dashboard">
          <Input testID="set-driver-name" value={name} onChangeText={setName}
            placeholder="e.g. Alex" returnKeyType="done"
            onBlur={() => updateProfile({ driver_name: name.trim() || null })}
            onSubmitEditing={() => updateProfile({ driver_name: name.trim() || null })} />
        </Field>
      </Section>

      {/* Appearance */}
      <Section title="Appearance">
        <Pressable testID="theme-toggle" onPress={toggle}
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Ionicons name={mode === "dark" ? "moon" : "sunny"} size={20} color={colors.accent} style={{ marginRight: 10 }} />
            <AppText variant="bodyMed">{mode === "dark" ? "Dark" : "Light"} theme</AppText>
          </View>
          <View style={{
            width: 48, height: 28, borderRadius: 999, padding: 3,
            backgroundColor: mode === "dark" ? colors.surfaceAlt : colors.accent,
            alignItems: mode === "dark" ? "flex-start" : "flex-end",
          }}>
            <View style={{ width: 22, height: 22, borderRadius: 999, backgroundColor: "#fff" }} />
          </View>
        </Pressable>
      </Section>

      {/* Automatic drive detection */}
      <Section title="Automatic tracking">
        <Pressable testID="autotrack-toggle" onPress={toggleAuto}
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <AppText variant="bodyMed">Detect drives automatically</AppText>
            <AppText variant="caption" color={colors.dim}>
              Off by default. When on, GigTax logs each drive in the background and asks you to tag it Business or Personal later — no start/stop needed.
            </AppText>
          </View>
          <View style={{
            width: 48, height: 28, borderRadius: 999, padding: 3,
            backgroundColor: autoOn ? colors.accent : colors.surfaceAlt,
            alignItems: autoOn ? "flex-end" : "flex-start",
          }}>
            <View style={{ width: 22, height: 22, borderRadius: 999, backgroundColor: "#fff" }} />
          </View>
        </Pressable>
        {Platform.OS === "android" ? (
          <Pressable testID="battery-optimization" onPress={openBatterySettings}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between",
              marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.border }}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <AppText variant="bodyMed">Battery &amp; background tracking</AppText>
              <AppText variant="caption" color={colors.dim}>
                Some phones (Blackview, Xiaomi, Oppo, Samsung…) close apps in the background and can stop drive tracking. Tap to allow GigTax to run without battery limits.
              </AppText>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.dim} />
          </Pressable>
        ) : null}
      </Section>

      {/* Country & region */}
      <Section title="Country">
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 10 }}>
          Tax rules differ by country. Switching updates your reports, mileage rates and currency.
        </AppText>
        {COUNTRIES.map((c) => {
          const active = c.code === profile.country;
          return (
            <Pressable key={c.code} testID={`set-country-${c.code}`}
              disabled={!c.active}
              onPress={() => {
                if (c.code === profile.country) return;
                updateProfile({ country: c.code as any, region: c.code === "AU" ? (profile.region || "NSW") : (c.code === "US" ? (profile.region || "CA") : null) } as any);
                show(`Switched to ${c.name}`, "success");
              }}
              style={{ marginBottom: 8, opacity: c.active ? 1 : 0.4 }}>
              <View style={{
                flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 10,
                borderWidth: 1, borderColor: active ? colors.accent : colors.border,
              }}>
                <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
                  <Image source={{ uri: flagUrl(c.code, 160) }}
                    style={{ width: 40, height: 27, borderRadius: 5, marginRight: 12, borderWidth: 1, borderColor: colors.border }}
                    contentFit="cover" />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySemi">{c.name}</AppText>
                    <AppText variant="caption" color={colors.dim}>{c.currency} · {c.distanceUnit}{c.active ? "" : " · coming soon"}</AppText>
                  </View>
                </View>
                {active ? <Ionicons name="checkmark-circle" size={22} color={colors.accent} /> : null}
              </View>
            </Pressable>
          );
        })}
        {profile.country === "US" ? (
          <View style={{ marginTop: 8 }}>
            <AppText variant="label" color={colors.dim} style={{ marginBottom: 8 }}>STATE</AppText>
            <ChipRow options={US_STATES.map((s) => ({ key: s, label: s }))} value={profile.region || "CA"}
              onChange={(r) => updateProfile({ region: r })} testIDPrefix="set-usstate" />
            <AppText variant="caption" color={colors.dim} style={{ marginTop: 8 }}>
              {US_NO_INCOME_TAX_STATES.includes(profile.region || "")
                ? `${profile.region} has no state income tax. Reports estimate federal tax only.`
                : "Used for future state income-tax guidance. Reports currently estimate federal tax only."}
            </AppText>
          </View>
        ) : null}
      </Section>

      {/* Week start */}
      <Section title="Your week">
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 8 }}>
          Which day your driving week starts — used for your Weekly total, weekly goal and insights.
        </AppText>
        <ChipRow options={WEEK_DAYS.map((d) => ({ key: String(d.key), label: d.label }))}
          value={String(profile.week_start ?? 0)}
          onChange={(k) => updateProfile({ week_start: Number(k) } as any)} testIDPrefix="set-weekstart" />
      </Section>

      {/* Business use % read only */}
      <Section title="Business-use %">
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1 }}>
            <AppText variant="body" color={colors.dim}>Calculated this financial year (read-only)</AppText>
            <AppText variant="caption" color={colors.dim}>Derived from your tagged trips — a real logbook, not a guess.</AppText>
          </View>
          <AppText style={{ fontFamily: FONT.display, fontSize: 34, color: colors.accent, fontVariant: ["tabular-nums"] }}>
            {bizPct == null ? "—" : `${bizPct}%`}
          </AppText>
        </View>
      </Section>

      {/* Vehicles — manage all cars here */}
      <Section title="Vehicles">
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 6 }}>
          Add each car you drive for. Trips, expenses, odometer and recurring payments are tracked per vehicle.
        </AppText>
        {vehicles.map((v) => {
          const active = v.id === activeVehicleId;
          const disposed = !!v.disposal_date;
          const label = v.registration || v.make_model || "Vehicle";
          const sub = disposed
            ? `Disposed ${isoToAU(v.disposal_date!)} · history kept`
            : (v.registration && v.make_model ? v.make_model : "Tap to add rego, model & odometer");
          return (
            <View key={v.id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10,
              borderTopWidth: 1, borderTopColor: colors.border, opacity: disposed ? 0.6 : 1 }}>
              <Pressable testID={`set-vehicle-${v.id}`} onPress={() => router.push(`/vehicle?id=${v.id}` as any)}
                style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.surfaceAlt,
                  alignItems: "center", justifyContent: "center", marginRight: 12 }}>
                  <Ionicons name="car-sport" size={20} color={disposed ? colors.dim : colors.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText variant="bodySemi">{label}</AppText>
                  <AppText variant="caption" color={colors.dim}>{sub}</AppText>
                </View>
              </Pressable>
              {disposed ? (
                <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
                  backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.loss }}>
                  <AppText variant="caption" color={colors.loss} style={{ fontFamily: FONT.bold }}>DISPOSED</AppText>
                </View>
              ) : active ? (
                <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.profit }}>
                  <AppText variant="caption" color={colors.bg} style={{ fontFamily: FONT.bold }}>ACTIVE</AppText>
                </View>
              ) : (
                <Pressable testID={`set-vehicle-activate-${v.id}`} onPress={() => v.id && setActiveVehicle(v.id)} hitSlop={8}>
                  <AppText variant="caption" color={colors.accent}>Set active</AppText>
                </Pressable>
              )}
            </View>
          );
        })}
        <PrimaryButton testID="set-add-vehicle" label="Add vehicle" icon="add" onPress={() => router.push("/vehicle" as any)} style={{ marginTop: 12 }} />
      </Section>

      {/* Deduction method */}
      <Section title="Deduction method">
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <Ionicons name={profile.country === "US" ? "git-compare" : "lock-closed"} size={16} color={colors.dim} style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodyMed">{profile.country === "US" ? "Standard mileage vs actual" : "Logbook method"}</AppText>
            <AppText variant="caption" color={colors.dim}>
              {profile.country === "US"
                ? "United States — GigTax compares the IRS standard mileage rate (72.5¢/mi Jan–Jun 2026, 76¢ from 1 Jul) against your actual expenses and recommends the larger deduction on Schedule C."
                : "Australia uses the logbook method. Cents-per-km is capped at 5,000 business km/year (88c/km FY25-26, 91c from 1 Jul 2026) — not offered, since full-time drivers exceed the cap in weeks."}
            </AppText>
          </View>
        </View>
      </Section>

      {/* Work type */}
      <Section title="Work type">
        {WORK_TYPES.map((w) => {
          const active = w.key === profile.work_type;
          return (
            <Pressable key={w.key} testID={`set-worktype-${w.key}`} onPress={() => {
                const allowed = platformsForWorkType(w.key).map((p) => p.name);
                updateProfile({
                  work_type: w.key as any,
                  platforms: profile.platforms.filter((p) => allowed.includes(p)),
                });
              }}
              style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8 }}>
              <Ionicons name={active ? "radio-button-on" : "radio-button-off"} size={20}
                color={active ? colors.accent : colors.dim} style={{ marginRight: 10 }} />
              <AppText variant="bodyMed" style={{ flex: 1 }}>{w.label}</AppText>
            </Pressable>
          );
        })}
      </Section>

      {/* Platforms */}
      <Section title="Platforms">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {platformsForWorkType(profile.work_type).map((p) => {
            const active = profile.platforms.includes(p.name);
            return (
              <Pressable key={p.name} testID={`set-platform-${p.name}`}
                onPress={() => {
                  const next = active ? profile.platforms.filter((x) => x !== p.name) : [...profile.platforms, p.name];
                  updateProfile({ platforms: next });
                }}
                style={{
                  paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
                  backgroundColor: active ? colors.accent : colors.surfaceAlt,
                  borderWidth: 1, borderColor: active ? colors.accent : colors.border,
                }}>
                <AppText variant="label" color={active ? colors.bg : colors.dim}>{p.name}</AppText>
              </Pressable>
            );
          })}
        </View>
      </Section>

      {/* Tax setup */}
      <Pressable testID="set-tax-setup" onPress={() => router.push("/tax-setup" as any)} style={{ marginBottom: 30 }}>
        <Card style={{ flexDirection: "row", alignItems: "center", borderColor: taxComplete ? colors.profit : colors.warm }}>
          <Ionicons name={taxComplete ? "shield-checkmark" : "shield-outline"} size={22}
            color={taxComplete ? colors.profit : colors.warm} style={{ marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <AppText variant="bodySemi">Tax setup</AppText>
            <AppText variant="caption" color={colors.dim}>
              {taxComplete ? "Complete — registration, method & details on file." : "Add legal name, registration status and more."}
            </AppText>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.dim} />
        </Card>
      </Pressable>

      {/* Delete account — App Store / Play requirement */}
      <View style={{ marginBottom: 40 }}>
        {!confirmDelete ? (
          <Pressable testID="set-delete-account" onPress={() => setConfirmDelete(true)}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "center",
              paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.border }}>
            <Ionicons name="trash-outline" size={18} color={colors.loss} style={{ marginRight: 8 }} />
            <AppText variant="bodySemi" color={colors.loss}>Delete account</AppText>
          </Pressable>
        ) : (
          <Card style={{ borderColor: colors.loss, borderWidth: 1 }}>
            <AppText variant="bodySemi">Delete your account?</AppText>
            <AppText variant="caption" color={colors.dim} style={{ marginTop: 6, lineHeight: 18 }}>
              This permanently erases your profile, trips, income, expenses, vehicles and logged hours, and disconnects any backup. This can't be undone.
            </AppText>
            <Pressable testID="set-delete-confirm" onPress={doDeleteAccount} disabled={deleting}
              style={{ marginTop: 14, flexDirection: "row", alignItems: "center", justifyContent: "center",
                paddingVertical: 13, borderRadius: 16, backgroundColor: colors.loss, opacity: deleting ? 0.6 : 1 }}>
              <Ionicons name="trash" size={18} color="#fff" style={{ marginRight: 8 }} />
              <AppText variant="bodySemi" color="#fff">{deleting ? "Deleting…" : "Delete permanently"}</AppText>
            </Pressable>
            <Pressable testID="set-delete-cancel" onPress={() => setConfirmDelete(false)} disabled={deleting}
              hitSlop={8} style={{ marginTop: 12, alignItems: "center" }}>
              <AppText variant="caption" color={colors.dim}>Cancel</AppText>
            </Pressable>
          </Card>
        )}
      </View>
    </Screen>
  );
}
