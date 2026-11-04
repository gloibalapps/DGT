import React, { useCallback, useState, useEffect } from "react";
import { View, Pressable, Linking, Platform, Alert } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { useAuth } from "@/src/auth";
import { useSubscription } from "@/src/subscription";
import { api, resetLocalProfileId } from "@/src/api";
import { useLocationDisclosure } from "@/src/LocationDisclosure";
import {
  isAutotrackEnabled, enableAutotrack, disableAutotrack,
} from "@/src/autotrack";
import * as IntentLauncher from "expo-intent-launcher";
import {
  WORK_TYPES, platformsForWorkType, US_STATES, US_NO_INCOME_TAX_STATES, COUNTRIES, WEEK_DAYS,
} from "@/src/config";
import {
  Screen, ScreenHeader, Card, AppText, Spinner, Input, Field, Select, SegmentedTabs, ListCard, ListRow, Toggle,
  PrimaryButton, SecondaryButton, useToast,
} from "@/src/ui";
import { connectDrive, runBackupAndWait, backupErrorText, backupStaleness, type BackupStatus } from "@/src/backup";
import { ueEnabled } from "@/src/ueParse";
import { isoToAU } from "@/src/date";

export default function Settings() {
  const { colors, mode, toggle } = useTheme();
  const { profile, updateProfile, version, vehicles, activeVehicleId, setActiveVehicle, reloadProfile, reloadVehicles, refresh } = useStore();
  const { user, signIn, signingIn, signOut } = useAuth();
  const { isActive: subActive, managed: subManaged, presentCustomerCenter, server: subServer, expired: subExpired } = useSubscription();
  const subSub = subActive || subServer?.state === "active" ? "Your subscription is active"
    : subExpired ? "Free trial ended · read-only until you subscribe"
    : subServer?.state === "trial" && subServer.days_left != null
      ? `14-day free trial · ${subServer.days_left} day${subServer.days_left === 1 ? "" : "s"} left`
      : "14-day free trial · cancel anytime";
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

  const disclosure = useLocationDisclosure();

  const toggleAuto = async () => {
    if (autoOn) {
      await disableAutotrack();
      setAutoOn(false);
      show("Automatic drive detection turned off", "info");
      return;
    }
    let res = await enableAutotrack();
    if (res.reason === "disclosure") {
      // Prominent disclosure BEFORE any location system prompt.
      if (!(await disclosure.ask())) {
        show("Auto detection stays off — you can still add trips or track a drive with the app open", "info");
        return;
      }
      res = await enableAutotrack();
    }
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

  const workOptions = WORK_TYPES.map((w) => ({ key: w.key, label: w.label.replace(/^Carry /, "").replace(/^Deliver /, "") }));
  const setWorkType = (k: string) => {
    if (k === profile.work_type) return;
    const allowed = platformsForWorkType(k as any).map((p) => p.name);
    const dropped = profile.platforms.filter((p) => !allowed.includes(p));
    const apply = () => updateProfile({ work_type: k as any, platforms: profile.platforms.filter((p) => allowed.includes(p)) });
    if (dropped.length === 0) return apply();
    if (Platform.OS === "web") { apply(); return; }
    Alert.alert("Change work type?", `${dropped.join(", ")} will be turned off because it doesn't fit this work type.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Change", onPress: apply },
    ]);
  };
  const lastBackup = backup?.last_backup_at
    ? new Date(backup.last_backup_at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
    : null;
  // Warn when the last Drive backup is over 3 days old (or never ran).
  const { stale: staleRaw, days: backupAgeDays } = backupStaleness(backup);
  const backupStale = staleRaw && !backupBusy;

  return (
    <Screen header={<ScreenHeader title="Profile" />} scroll>
      {/* Account */}
      {user ? (
        <ListCard label="Account">
          <View style={{ flexDirection: "row", alignItems: "center", minHeight: 64, paddingVertical: 12 }}>
            {user.picture ? (
              <Image source={{ uri: user.picture }} style={{ width: 40, height: 40, borderRadius: 20, marginRight: 12 }} contentFit="cover" />
            ) : (
              <View style={{ width: 40, height: 40, borderRadius: 20, marginRight: 12, backgroundColor: colors.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name="person-outline" size={20} color={colors.dim} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <AppText variant="bodySemi">{user.name || "Signed in"}</AppText>
              <AppText variant="caption" color={colors.dim}>{user.email}</AppText>
            </View>
          </View>
          {user.is_demo ? (
            <ListRow testID="set-demo-banner" icon="flask-outline" iconColor={colors.warm} label="Demo account"
              sub="Sample data only — it's removed after 24 hours. Sign out and sign in to keep your own records." />
          ) : (
            <ListRow icon="cloud-done-outline" iconColor={colors.profit} label="Your data syncs securely across your phones" />
          )}
          <ListRow testID="set-signout" icon="log-out-outline" iconColor={colors.dim} label="Sign out" onPress={signOut} />
        </ListCard>
      ) : (
        <ListCard label="Account">
          <ListRow testID="set-signin" icon="logo-google" label={signingIn ? "Signing in…" : "Sign in with Google"}
            sub="Keep your data safe and synced across your phones" onPress={signIn} />
        </ListCard>
      )}

      {/* Subscription */}
      <ListCard label="Subscription">
        <ListRow testID="set-subscription" icon="star-outline" label={subActive ? "GigTax" : "Subscribe to GigTax"}
          sub={subSub}
          value={subActive ? "Active" : undefined} valueColor={colors.profit}
          onPress={() => router.push("/paywall" as any)} />
        {subActive && subManaged ? (
          <ListRow testID="set-manage-subscription" icon="settings-outline" label="Manage subscription"
            sub="Change plan, restore or cancel" onPress={() => void presentCustomerCenter()} />
        ) : null}
      </ListCard>

      {/* Backups — Google Drive */}
      {backup?.connected ? (
        <ListCard label="Backups">
          <ListRow icon="cloud-done-outline" iconColor={colors.profit} label="Google Drive connected"
            sub={`${backup.email || "Your Drive"} · ${lastBackup ? `last backup ${lastBackup}` : "not backed up yet"}`} />
          {backupStale ? (
            <ListRow testID="backup-stale-warning" icon="warning-outline" iconColor={colors.warm}
              label={backup.last_backup_at ? `Last backup was ${backupAgeDays} days ago` : "No backup yet"}
              sub="Tap Back up now to keep your receipts & records safe." />
          ) : null}
          {backup.backup_state === "error" && backup.last_error ? (
            <ListRow testID="backup-error" icon="alert-circle-outline" iconColor={colors.loss} label={`Last backup failed: ${backup.last_error}`} />
          ) : null}
          <View style={{ flexDirection: "row", gap: 12, paddingVertical: 12 }}>
            <PrimaryButton testID="backup-now" label={backupBusy || backup.backup_state === "running" ? "Backing up…" : "Back up now"}
              onPress={onBackupNow} disabled={backupBusy} style={{ flex: 1 }} />
            <SecondaryButton testID="backup-restore" label="Restore" onPress={onRestore} disabled={backupBusy} style={{ flex: 1 }} />
          </View>
          <ListRow testID="backup-how" label="How backups work" trailingIcon={howOpen ? "chevron-up" : "chevron-down"}
            onPress={() => setHowOpen((o) => !o)}
            sub={howOpen ? "Receipts, a CSV and a full backup of your income, expenses & trips go to a “GigTax Backups” folder in your Drive — automatically once a day. On a new phone, connect the same Google account and tap Restore." : undefined} />
          <Pressable testID="backup-disconnect" onPress={onDisconnectDrive} disabled={backupBusy}
            style={{ minHeight: 48, justifyContent: "center", borderTopWidth: 1, borderTopColor: colors.divider }}>
            <AppText variant="body" color={colors.loss}>Disconnect Google Drive</AppText>
          </Pressable>
        </ListCard>
      ) : (
        <ListCard label="Backups">
          <ListRow icon="cloud-outline" label="Back up to Google Drive"
            sub={backup?.needs_reauth ? "Reconnect needed — please connect again" : "Keep your receipts & records safe in your own Drive"} />
          <View style={{ paddingVertical: 12 }}>
            <PrimaryButton testID="backup-connect" label={backupBusy ? "Connecting…" : "Connect Google Drive"}
              onPress={onConnectDrive} disabled={backupBusy} />
          </View>
        </ListCard>
      )}

      {/* Driver */}
      <ListCard label="Driver">
        <View style={{ paddingTop: 12 }}>
          <Field label="Your name" hint="Shown on your dashboard">
            <Input testID="set-driver-name" value={name} onChangeText={setName}
              placeholder="e.g. Alex" returnKeyType="done"
              onBlur={() => updateProfile({ driver_name: name.trim() || null })}
              onSubmitEditing={() => updateProfile({ driver_name: name.trim() || null })} />
          </Field>
        </View>
      </ListCard>

      {/* Work type */}
      <AppText variant="section" style={{ marginBottom: 8, marginLeft: 4 }}>Work type</AppText>
      <View style={{ marginHorizontal: -20, marginBottom: 16 }}>
        <SegmentedTabs options={workOptions} value={profile.work_type} onChange={setWorkType} testIDPrefix="set-worktype" />
      </View>

      {/* Platforms */}
      <ListCard label="Platforms">
        {platformsForWorkType(profile.work_type).map((p) => {
          const on = profile.platforms.includes(p.name);
          return (
            <ListRow key={p.name} label={p.name}
              right={<Toggle testID={`set-platform-${p.name}`} value={on} onChange={() => {
                const next = on ? profile.platforms.filter((x) => x !== p.name) : [...profile.platforms, p.name];
                updateProfile({ platforms: next });
              }} />} />
          );
        })}
      </ListCard>

      {/* Uber Eats guarantee */}
      <ListCard label="Delivery jobs & Uber Eats guarantee">
        <ListRow label="Log food delivery jobs" sub="Enter each job (Uber Eats, DoorDash, Menulog…). Uber Eats jobs also check the engaged-time guarantee."
          right={<Toggle testID="ue-toggle" value={ueEnabled(profile)}
            onChange={() => updateProfile({ ue_guarantee_enabled: !ueEnabled(profile) } as any)} />} />
        {ueEnabled(profile) ? (
          <View style={{ paddingVertical: 12 }}>
            <Field label="Guarantee vehicle" hint="Car A$32.00 · Motorbike A$31.50 · Bicycle A$31.30 per engaged hour.">
              <Select testID="ue-vehicle" title="Guarantee vehicle" value={(profile as any).ue_vehicle_type || "car"}
                options={[{ key: "car", label: "Car" }, { key: "motorbike", label: "Motorbike" }, { key: "bicycle", label: "Bicycle" }]}
                onChange={(k) => updateProfile({ ue_vehicle_type: k } as any)} />
            </Field>
          </View>
        ) : null}
      </ListCard>

      {/* Tracking */}
      <ListCard label="Tracking">
        <ListRow label="Detect drives automatically" sub="Logs each drive in the background; tag it Business or Private later."
          right={<Toggle testID="autotrack-toggle" value={autoOn} onChange={toggleAuto} />} />
        {Platform.OS === "android" ? (
          <ListRow testID="battery-optimization" label="Battery & background tracking"
            sub="Allow GigTax to run without battery limits so tracking isn't stopped." onPress={openBatterySettings} />
        ) : null}
        <ListRow label="Business use (this FY)" sub="From your tagged trips — read-only" value={bizPct == null ? "—" : `${bizPct}%`} />
      </ListCard>

      {/* Tax */}
      <ListCard label="Tax">
        <ListRow testID="set-tax-setup" icon={taxComplete ? "checkmark-circle" : "alert-circle-outline"}
          iconColor={taxComplete ? colors.profit : colors.warm} label="Tax setup"
          sub={taxComplete ? "Complete — registration, method & details on file" : "Add legal name, registration status and more"}
          onPress={() => router.push("/tax-setup" as any)} />
        <ListRow icon={profile.country === "US" ? "git-compare-outline" : "lock-closed-outline"} iconColor={colors.dim}
          label={profile.country === "US" ? "Standard mileage vs actual" : "Logbook method"}
          sub={profile.country === "US"
            ? "Compares the IRS standard mileage rate (72.5¢/mi Jan–Jun 2026, 76¢ from 1 Jul) against actual expenses and uses the larger deduction."
            : "Cents-per-km is capped at 5,000 business km/year (88c/km FY25-26, 91c from 1 Jul 2026) — full-time drivers exceed it in weeks."} />
      </ListCard>

      {/* Vehicles */}
      <ListCard label="Vehicles">
        {vehicles.map((v) => {
          const active = v.id === activeVehicleId;
          const disposed = !!v.disposal_date;
          return (
            <ListRow key={v.id} testID={`set-vehicle-${v.id}`} icon="car-outline" iconColor={disposed ? colors.dim : colors.accent}
              label={v.registration || v.make_model || "Vehicle"}
              sub={disposed ? `Disposed ${isoToAU(v.disposal_date!)} · history kept`
                : (v.registration && v.make_model ? v.make_model : "Tap to add rego, model & odometer")}
              value={disposed ? "Disposed" : active ? "Active" : undefined}
              valueColor={disposed ? colors.dim : colors.profit}
              right={!disposed && !active ? (
                <Pressable testID={`set-vehicle-activate-${v.id}`} onPress={() => v.id && setActiveVehicle(v.id)}
                  style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}>
                  <AppText variant="bodySemi" color={colors.accent}>Set active</AppText>
                </Pressable>
              ) : undefined}
              onPress={() => router.push(`/vehicle?id=${v.id}` as any)} />
          );
        })}
        <ListRow testID="set-add-vehicle" icon="add" label="Add vehicle" onPress={() => router.push("/vehicle" as any)} />
      </ListCard>

      {/* Region & preferences */}
      <ListCard label="Region & preferences">
        <View style={{ paddingVertical: 12 }}>
          <Field label="Country" hint="Switching updates your reports, mileage rates and currency.">
            <Select testID="set-country" title="Country" value={profile.country}
              options={COUNTRIES.filter((c) => c.active).map((c) => ({ key: c.code, label: c.name, desc: `${c.currency} · ${c.distanceUnit}` }))}
              onChange={(code) => {
                if (code === profile.country) return;
                updateProfile({ country: code as any, region: code === "AU" ? (profile.region || "NSW") : (code === "US" ? (profile.region || "CA") : null) } as any);
                show(`Switched to ${COUNTRIES.find((c) => c.code === code)?.name}`, "success");
              }} />
          </Field>
          {profile.country === "US" ? (
            <Field label="State" hint={US_NO_INCOME_TAX_STATES.includes(profile.region || "")
              ? `${profile.region} has no state income tax. Reports estimate federal tax only.`
              : "Reports currently estimate federal tax only."}>
              <Select testID="set-usstate" title="State" value={profile.region || "CA"}
                options={US_STATES.map((s) => ({ key: s, label: s }))} onChange={(r) => updateProfile({ region: r })} />
            </Field>
          ) : null}
          <Field label="Week starts on" hint="Used for your weekly total, goal and insights.">
            <Select testID="set-weekstart" title="Week starts on" value={String(profile.week_start ?? 0)}
              options={WEEK_DAYS.map((d) => ({ key: String(d.key), label: d.label }))}
              onChange={(k) => updateProfile({ week_start: Number(k) } as any)} />
          </Field>
        </View>
        <ListRow label="Dark theme" right={<Toggle testID="theme-toggle" value={mode === "dark"} onChange={toggle} />} />
      </ListCard>

      {/* Help */}
      <ListCard label="Help">
        <ListRow testID="set-manual" icon="book-outline" label="User guide" onPress={() => router.push("/manual" as any)} />
        <ListRow testID="set-privacy" icon="shield-checkmark-outline" label="Privacy Policy" onPress={() => router.push("/privacy" as any)} />
        <ListRow testID="set-terms" icon="document-text-outline" label="Terms of Service" onPress={() => router.push("/terms" as any)} />
      </ListCard>

      {/* Delete account — App Store / Play requirement */}
      <View style={{ marginBottom: 40 }}>
        {!confirmDelete ? (
          <Pressable testID="set-delete-account" onPress={() => setConfirmDelete(true)}
            style={{ minHeight: 48, alignItems: "center", justifyContent: "center" }}>
            <AppText variant="bodySemi" color={colors.loss}>Delete account</AppText>
          </Pressable>
        ) : (
          <Card>
            <AppText variant="bodySemi">Delete your account?</AppText>
            <AppText variant="caption" color={colors.dim} style={{ marginTop: 6, lineHeight: 18 }}>
              This permanently erases your profile, trips, income, expenses, vehicles and logged hours, and disconnects any backup. This can&apos;t be undone.
            </AppText>
            <Pressable testID="set-delete-confirm" onPress={doDeleteAccount} disabled={deleting}
              style={{ minHeight: 48, alignItems: "center", justifyContent: "center", marginTop: 8, opacity: deleting ? 0.6 : 1 }}>
              <AppText variant="bodySemi" color={colors.loss}>{deleting ? "Deleting…" : "Delete permanently"}</AppText>
            </Pressable>
            <SecondaryButton testID="set-delete-cancel" label="Cancel" onPress={() => setConfirmDelete(false)} disabled={deleting} />
          </Card>
        )}
      </View>
      {disclosure.element}
    </Screen>
  );
}
