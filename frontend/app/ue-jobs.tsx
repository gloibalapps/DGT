import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Alert, Platform, Pressable } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { api, todayISO } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { AppText, Card, DateField, Field, IconButton, Input, ListCard, ListRow, PrimaryButton, Screen, SecondaryButton, Select, useToast } from "@/src/ui";
import { UEJobRow, Draft, newKey, toJob, fromJob } from "@/src/UEJobRow";
import {
  UEJob, isDup, missingFields, parseVoiceJob, auDate, FOOD_PLATFORMS, emptyFilter, matchJob, listTotals,
  cycleStartFor, weekStart, selectedBuckets, fmtDur, type UeListFilter,
} from "@/src/ueParse";
import { useSpeech } from "@/src/useSpeech";
import { captureGuaranteePhoto } from "@/src/ueScan";
import { ueScanStash } from "@/src/ueScanStash";

const NEW_DATE_KEY = "gigtax.ue.newdate";
const NEW_PLAT_KEY = "gigtax.ue.newplatform";
const blank = (date: string, platform: string, type: Draft["type"] = "DELIVERY"): Draft =>
  ({ key: newKey(), platform, date, time: "", type, dur: "", amount: "", km: "", tip: "" });

const notify = (title: string, msg: string) => (Platform.OS === "web" ? window.alert(`${title}\n\n${msg}`) : Alert.alert(title, msg));
const confirmDelete = (n: number) => new Promise<boolean>((resolve) => {
  const msg = `Delete ${n} job${n === 1 ? "" : "s"}? Saved jobs are removed. Unsaved rows are discarded.`;
  if (Platform.OS === "web") { resolve(window.confirm(msg)); return; }
  Alert.alert("Delete jobs", msg, [
    { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
    { text: "Delete", style: "destructive", onPress: () => resolve(true) },
  ]);
});

export default function UEJobs() {
  const { colors } = useTheme();
  const router = useRouter();
  const { show } = useToast();
  const params = useLocalSearchParams<{ date?: string; week?: string }>();
  const initialWeek = typeof params.week === "string" ? params.week : "";
  const [newDate, setNewDate] = useState(params.date || todayISO());
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [all, setAll] = useState<UEJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scannedNote, setScannedNote] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [dupIds, setDupIds] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<UeListFilter>(() => ({
    ...emptyFilter(),
    periodStart: initialWeek ? cycleStartFor(initialWeek) : "",
    weekIndex: initialWeek ? String(Math.min(2, Math.max(0, Math.round((Date.parse(initialWeek) - Date.parse(cycleStartFor(initialWeek))) / 86400000 / 7)))) as UeListFilter["weekIndex"] : "",
  }));
  const speech = useSpeech();
  const patchFilter = (p: Partial<UeListFilter>) => setFilter((f) => ({ ...f, ...p }));

  useEffect(() => {
    if (params.date || params.week) return;
    storage.getItem<string>(NEW_DATE_KEY, "").then((v) => { if (v) setNewDate(v); });
  }, [params.date, params.week]);
  const changeNewDate = (v: string) => { if (!v) return; setNewDate(v); storage.setItem(NEW_DATE_KEY, v); };
  const [newPlat, setNewPlat] = useState("Uber Eats");
  useEffect(() => { storage.getItem<string>(NEW_PLAT_KEY, "").then((v) => { if (v) setNewPlat(v); }); }, []);
  const changeNewPlat = (v: string) => { setNewPlat(v); storage.setItem(NEW_PLAT_KEY, v); };

  const load = useCallback(async () => {
    try { const j = await api.ueJobs(); setAll(j); } catch { show("Couldn't load jobs", "error"); }
  }, [show]);
  useFocusEffect(useCallback(() => {
    if (ueScanStash.jobs) {
      const incoming = ueScanStash.jobs;
      const rejected = ueScanStash.rejected;
      const week = ueScanStash.weekStart;
      ueScanStash.jobs = null;
      ueScanStash.rejected = 0;
      ueScanStash.weekStart = null;
      setDrafts((ds) => [...ds, ...incoming.map((j) => ({ ...fromJob(j), key: newKey(), id: undefined }))]);
      setScannedNote(true);
      if (week) {
        setFilter((f) => ({
          ...f, periodStart: cycleStartFor(week),
          weekIndex: String(Math.min(2, Math.max(0, Math.round((Date.parse(week) - Date.parse(cycleStartFor(week))) / 86400000 / 7)))) as UeListFilter["weekIndex"],
        }));
      }
      if (rejected) show(`${rejected} cut-off row${rejected === 1 ? "" : "s"} skipped`, "info");
      show(`${incoming.length} job${incoming.length === 1 ? "" : "s"} to check — not saved yet`, "success");
    }
    load();
  }, [load, show]));

  const savedDrafts = useMemo(() => all.map(fromJob), [all]);
  const visibleSaved = useMemo(() => savedDrafts.filter((d) => matchJob(toJob(d), filter)).map((d) => ({ ...d, dup: !!dupIds[d.id || ""] })), [savedDrafts, filter, dupIds]);
  const visibleDrafts = useMemo(() => drafts.filter((d) => matchJob(toJob(d), filter)), [drafts, filter]);
  const hiddenDrafts = drafts.length - visibleDrafts.length;
  const totals = useMemo(() => listTotals(visibleSaved.map(toJob)), [visibleSaved]);

  const draftView = useMemo(() => visibleDrafts.map((d) => {
    const j = toJob(d);
    const prior = drafts.slice(0, drafts.findIndex((x) => x.key === d.key));
    const dup = d.dup || all.some((s) => isDup(j, s)) || prior.some((p) => isDup(j, toJob(p)));
    return { ...d, dup };
  }), [visibleDrafts, drafts, all]);

  const visibleRows = [...draftView, ...visibleSaved];
  const selectedRows = visibleRows.filter((d) => selected[d.key]).map((d) => ({ key: d.key, id: d.id, selected: true }));
  const buckets = selectedBuckets(selectedRows);
  const allSelected = visibleRows.length > 0 && visibleRows.every((d) => selected[d.key]);

  const toggle = (key: string) => setSelected((s) => ({ ...s, [key]: !s[key] }));
  const toggleAll = () => {
    setSelected((s) => {
      const next = { ...s };
      for (const row of visibleRows) next[row.key] = !allSelected;
      return next;
    });
  };

  const addDraft = (type: Draft["type"]) => setDrafts((ds) => [...ds, blank(newDate, newPlat, type)]);

  const scan = async (source: "camera" | "library") => {
    setScanning(true);
    const res = await captureGuaranteePhoto(source);
    setScanning(false);
    if (!res) return;
    if ("error" in res) { show(res.error, "error"); return; }
    if (!res.jobs.length) { show(res.rejected ? "That screen was cut off — no complete job to add" : "No jobs found on that screen", "info"); return; }
    setDrafts((ds) => [...ds, ...res.jobs.map((j) => ({ ...fromJob({ ...j, platform: "Uber Eats" }), key: newKey(), id: undefined }))]);
    setScannedNote(true);
    if (res.rejected) show(`${res.rejected} cut-off row${res.rejected === 1 ? "" : "s"} skipped`, "info");
    show(`${res.jobs.length} job${res.jobs.length === 1 ? "" : "s"} to check — not saved yet`, "success");
  };

  const finishVoice = () => {
    speech.stop();
    const text = speech.transcript;
    const lines = text.split(/\n|\bnext job\b|\bnew job\b|\bnext\b/i).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { show("Didn't catch that — try again", "info"); return; }
    let fallback = drafts.length ? drafts[drafts.length - 1].date : newDate;
    const added: Draft[] = [];
    for (const line of lines) {
      const { job, spokenDate } = parseVoiceJob(line, fallback);
      if (spokenDate) changeNewDate(job.date);
      fallback = job.date;
      added.push({ ...fromJob({ ...job, platform: job.platform || newPlat }), key: newKey(), id: undefined });
    }
    setDrafts((ds) => [...ds, ...added]);
    show(`${added.length} job${added.length > 1 ? "s" : ""} added — check and save`, "success");
  };

  const saveDrafts = async () => {
    const batch = draftView;
    if (batch.some((d) => missingFields(toJob(d)).length)) { notify("Some rows are incomplete", "Fill in the amber rows before saving."); return; }
    setBusy(true);
    try {
      const keep = batch.filter((d) => !d.dup);
      const dupRows = batch.filter((d) => d.dup);
      const r = keep.length ? await api.ueAddJobs(keep.map(toJob)) : { saved: [], duplicates: [] };
      const serverDups = r.duplicates.map((i) => ({ ...keep[i], dup: true }));
      const leftover = [...dupRows.map((d) => ({ ...d, dup: true })), ...serverDups];
      const savedKeys = new Set(keep.filter((_, i) => !r.duplicates.includes(i)).map((d) => d.key));
      setDrafts((ds) => [...ds.filter((d) => !savedKeys.has(d.key) && !batch.some((b) => b.key === d.key)), ...leftover]);
      if (r.saved.length) show(`${r.saved.length} saved`, "success");
      if (leftover.length) notify("Duplicate jobs not saved", `${leftover.length} job${leftover.length > 1 ? "s match" : " matches"} one already logged (same date & start time, same amount). Edit or delete the red rows.`);
      load();
    } catch (e: any) { show(String(e?.message || "").replace(/^\d{3}:\s*/, "") || "Couldn't save", "error"); }
    finally { setBusy(false); }
  };

  const saveExisting = async (d: Draft) => {
    try {
      await api.ueUpdateJob(d.id!, toJob(d));
      show("Job updated", "success"); load();
    } catch (e: any) {
      if (/^409/.test(e?.message || "")) {
        setDupIds((ids) => ({ ...ids, [d.id!]: true }));
        notify("Duplicate job", "Another job has the same date, start time and amount.");
      } else show("Couldn't update", "error");
    }
  };
  const deleteExisting = async (d: Draft) => {
    try { await api.ueDeleteJob(d.id!); show("Job deleted", "success"); load(); } catch { show("Couldn't delete", "error"); }
  };

  const verifySelected = async () => {
    const at = new Date().toISOString();
    setDrafts((ds) => ds.map((d) => buckets.draftKeys.includes(d.key) ? { ...d, verified: true, verified_at: at, dirty: true } : d));
    if (!buckets.savedIds.length) { show("Marked to verify when you save", "success"); return; }
    try {
      await api.ueVerifyJobs(buckets.savedIds, true);
      show("Verified", "success");
      load();
    } catch { show("Couldn't verify", "error"); }
  };

  const deleteSelected = async () => {
    if (!buckets.count) return;
    if (!(await confirmDelete(buckets.count))) return;
    setDrafts((ds) => ds.filter((d) => !buckets.draftKeys.includes(d.key)));
    setSelected((s) => {
      const next = { ...s };
      for (const key of buckets.draftKeys) delete next[key];
      return next;
    });
    if (!buckets.savedIds.length) return;
    try { await api.ueDeleteJobs(buckets.savedIds); show("Deleted", "success"); load(); }
    catch { show("Couldn't delete", "error"); }
  };

  const periods = useMemo(() => {
    const days = all.map((j) => j.date).concat(todayISO());
    const earliest = days.reduce((a, b) => (a < b ? a : b));
    const out: { start: string; end: string }[] = [];
    let c = cycleStartFor(todayISO());
    const floor = cycleStartFor(earliest);
    while (c >= floor) { out.push({ start: c, end: shiftEnd(c) }); c = shiftBack(c); }
    return out;
  }, [all]);

  return (
    <Screen scroll header={
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 }}>
        <IconButton testID="ue-back" icon="chevron-back" onPress={() => router.back()} />
        <AppText variant="title" style={{ flex: 1 }}>Delivery jobs</AppText>
        <IconButton testID="ue-open-guarantee" icon="stats-chart-outline" onPress={() => router.push("/guarantee" as any)} />
      </View>
    }>
      <Card style={{ marginBottom: 12 }}>
        <Field label="Earnings period">
          <Select testID="ue-filter-period" title="Earnings period" value={filter.periodStart}
            onChange={(k) => patchFilter({ periodStart: k, weekIndex: "" })}
            options={[{ key: "", label: "Any period" }, ...periods.map((p) => ({ key: p.start, label: `${auDate(p.start)} – ${auDate(p.end)}` }))]} />
        </Field>
        {filter.periodStart ? (
          <Field label="Week">
            <Select testID="ue-filter-week" title="Week" value={filter.weekIndex}
              onChange={(k) => patchFilter({ weekIndex: k as UeListFilter["weekIndex"] })}
              options={[
                { key: "", label: "All weeks" },
                { key: "0", label: `Week 1 · ${auDate(weekStart(filter.periodStart, 0))}` },
                { key: "1", label: `Week 2 · ${auDate(weekStart(filter.periodStart, 1))}` },
                { key: "2", label: `Week 3 · ${auDate(weekStart(filter.periodStart, 2))}` },
              ]} />
          </Field>
        ) : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label="From"><DateField testID="ue-filter-from" value={filter.from} onChange={(v) => patchFilter({ from: v })} /></Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="To"><DateField testID="ue-filter-to" value={filter.to} onChange={(v) => patchFilter({ to: v })} /></Field>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label="App">
              <Select testID="ue-filter-platform" title="App" value={filter.platform} onChange={(k) => patchFilter({ platform: k })}
                options={[{ key: "", label: "All" }, ...FOOD_PLATFORMS.map((p) => ({ key: p, label: p }))]} />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Type">
              <Select testID="ue-filter-type" title="Type" value={filter.type} onChange={(k) => patchFilter({ type: k })}
                options={[{ key: "", label: "All" }, { key: "DELIVERY", label: "Delivery" }, { key: "Package", label: "Package" }, { key: "Promotion", label: "Quest" }]} />
            </Field>
          </View>
        </View>
        <Field label="Verified">
          <Select testID="ue-filter-verified" title="Verified" value={filter.verified} onChange={(k) => patchFilter({ verified: k as UeListFilter["verified"] })}
            options={[{ key: "", label: "All" }, { key: "verified", label: "Verified" }, { key: "unverified", label: "Unverified" }]} />
        </Field>
        <Field label="Search">
          <Input testID="ue-filter-query" value={filter.query} onChangeText={(v) => patchFilter({ query: v })} placeholder="Amount, time, quest…" />
        </Field>
      </Card>

      <AppText testID="ue-totals" variant="bodySemi" style={{ marginBottom: 4 }}>
        {totals.jobs} job{totals.jobs === 1 ? "" : "s"} · A${totals.earnings.toFixed(2)} · {fmtDur(totals.engagedSec)}
      </AppText>
      <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
        Engaged time counts overlapping jobs once. Estimate only — Uber’s calculation is final.
      </AppText>

      <View style={{ flexDirection: "row", gap: 12, marginBottom: 12 }}>
        <SecondaryButton testID="ue-scan-camera" label={scanning ? "Reading…" : "Take photo"} icon="camera-outline" style={{ flex: 1 }}
          disabled={scanning} onPress={() => scan("camera")} />
        <SecondaryButton testID="ue-scan-library" label="Choose screenshot" icon="images-outline" style={{ flex: 1 }}
          disabled={scanning} onPress={() => scan("library")} />
      </View>
      {scannedNote ? (
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 12 }}>
          Amounts on Uber’s list can include a tip. Enter a tip on the row to leave it out of the guarantee, or open the trip in Uber. Nothing is saved until you tap Save.
        </AppText>
      ) : null}

      <Field label="Date for new jobs" hint="Stays set until you change it.">
        <DateField testID="ue-new-date" value={newDate} onChange={changeNewDate} maxToday />
      </Field>
      <Field label="Food app for new jobs" hint="Only Uber Eats jobs count toward the Uber Eats guarantee.">
        <Select testID="ue-new-platform" title="Food app" value={newPlat} onChange={changeNewPlat}
          options={FOOD_PLATFORMS.map((p) => ({ key: p, label: p }))} />
      </Field>

      <View style={{ flexDirection: "row", gap: 12, marginBottom: 12 }}>
        <PrimaryButton testID="ue-add-job" label="Add Job" icon="add" style={{ flex: 1 }} onPress={() => addDraft("DELIVERY")} />
        <SecondaryButton testID="ue-add-promo" label="Add Promo" icon="gift-outline" style={{ flex: 1 }} onPress={() => addDraft("Promotion")} />
      </View>

      {speech.listening ? (
        <Card testID="ue-voice-panel" style={{ marginBottom: 16 }}>
          <AppText variant="label" color={colors.profit}>● Listening… say each job, then tap Done</AppText>
          <AppText testID="ue-voice-transcript" variant="body" style={{ marginTop: 8, minHeight: 44 }}>
            {speech.transcript || "e.g. “Monday 28 September, 12:03 pm, 1 hour 1 minute, 24 dollars 59”"}
          </AppText>
          <PrimaryButton testID="ue-voice-done" label="Done" style={{ marginTop: 12 }} onPress={finishVoice} />
        </Card>
      ) : (
        <ListCard>
          <ListRow testID="ue-speak" icon="mic-outline" label="Speak a Job" sub="Say date, start time, duration and amount"
            onPress={() => { speech.start(); }} />
        </ListCard>
      )}
      {speech.error ? <AppText variant="caption" color={colors.loss} style={{ marginBottom: 12 }}>{speech.error}</AppText> : null}

      <Pressable testID="ue-select-all" onPress={toggleAll} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, marginBottom: 8 }}>
        <Ionicons name={allSelected ? "checkbox" : "square-outline"} size={22} color={allSelected ? colors.accent : colors.dim} />
        <AppText variant="body">Select all ({visibleRows.length})</AppText>
      </Pressable>
      {buckets.count ? (
        <View style={{ flexDirection: "row", gap: 12, marginBottom: 12 }}>
          <PrimaryButton testID="ue-verify" label={`Verify ${buckets.count}`} icon="checkmark-circle-outline" style={{ flex: 1 }} onPress={verifySelected} />
          <SecondaryButton testID="ue-delete-selected" label={`Delete ${buckets.count}`} icon="trash-outline" style={{ flex: 1 }} onPress={deleteSelected} />
        </View>
      ) : null}

      {draftView.length ? (
        <>
          <AppText variant="section" style={{ marginBottom: 8, marginLeft: 4 }}>New jobs — not saved yet</AppText>
          {draftView.map((d, i) => (
            <UEJobRow key={d.key} testID={`ue-draft-${i}`} d={d} selected={!!selected[d.key]} onToggle={() => toggle(d.key)}
              onChange={(nd) => setDrafts((ds) => ds.map((x) => (x.key === d.key ? nd : x)))}
              onDelete={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))} />
          ))}
          <PrimaryButton testID="ue-save-all" label={busy ? "Saving…" : `Save ${draftView.length} job${draftView.length > 1 ? "s" : ""}`}
            disabled={busy} onPress={saveDrafts} style={{ marginBottom: 20 }} />
        </>
      ) : null}
      {hiddenDrafts > 0 ? (
        <AppText variant="caption" color={colors.warm} style={{ marginBottom: 12 }}>
          {hiddenDrafts} unsaved job{hiddenDrafts === 1 ? "" : "s"} hidden by the filter.
        </AppText>
      ) : null}

      <AppText variant="section" style={{ marginBottom: 8, marginLeft: 4 }}>Jobs · {visibleSaved.length}</AppText>
      {visibleSaved.length === 0 ? (
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 24, marginLeft: 4 }}>No jobs match this filter.</AppText>
      ) : visibleSaved.map((d, i) => (
        <UEJobRow key={d.key} testID={`ue-saved-${i}`} d={d} selected={!!selected[d.key]} onToggle={() => toggle(d.key)}
          onChange={(nd) => setAll((rows) => rows.map((x) => (x.id === d.id ? { ...x, ...toJob(nd) } : x)))}
          onDelete={() => deleteExisting(d)} onSave={() => saveExisting(d)} />
      ))}
    </Screen>
  );
}

function shiftEnd(start: string): string {
  const [y, m, d] = start.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 20)).toISOString().slice(0, 10);
}
function shiftBack(start: string): string {
  const [y, m, d] = start.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 21)).toISOString().slice(0, 10);
}
