import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Alert, Platform } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { useTheme } from "@/src/theme";
import { api, todayISO } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { AppText, Card, DateField, Field, IconButton, ListCard, ListRow, PrimaryButton, Screen, SecondaryButton, useToast } from "@/src/ui";
import { UEJobRow, Draft, newKey, toJob, fromJob } from "@/src/UEJobRow";
import { UEJob, isDup, missingFields, parseVoiceJob, auDate } from "@/src/ueParse";
import { useSpeech } from "@/src/useSpeech";

const NEW_DATE_KEY = "gigtax.ue.newdate";
const blank = (date: string, type: Draft["type"] = "DELIVERY"): Draft =>
  ({ key: newKey(), date, time: "", type, dur: "", amount: "", km: "" });

const notify = (title: string, msg: string) => (Platform.OS === "web" ? window.alert(`${title}\n\n${msg}`) : Alert.alert(title, msg));

export default function UEJobs() {
  const { colors } = useTheme();
  const router = useRouter();
  const { show } = useToast();
  const params = useLocalSearchParams<{ date?: string }>();
  const [newDate, setNewDate] = useState(params.date || todayISO());
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [saved, setSaved] = useState<Draft[]>([]);
  const [all, setAll] = useState<UEJob[]>([]);
  const [busy, setBusy] = useState(false);
  const speech = useSpeech();

  useEffect(() => {
    if (params.date) return;
    storage.getItem<string>(NEW_DATE_KEY, "").then((v) => { if (v) setNewDate(v); });
  }, [params.date]);
  const changeNewDate = (v: string) => { if (!v) return; setNewDate(v); storage.setItem(NEW_DATE_KEY, v); };

  const load = useCallback(async () => {
    try { const j = await api.ueJobs(); setAll(j); } catch { show("Couldn't load jobs", "error"); }
  }, [show]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { setSaved(all.filter((j) => j.date === newDate).map(fromJob)); }, [all, newDate]);

  // live duplicate flags for unsaved rows: vs saved jobs, and only the LATER copy within the batch
  const draftView = useMemo(() => drafts.map((d, i) => {
    const j = toJob(d);
    const dup = d.dup || all.some((s) => isDup(j, s)) || drafts.slice(0, i).some((p) => isDup(j, toJob(p)));
    return { ...d, dup };
  }), [drafts, all]);

  const addDraft = (type: Draft["type"]) => setDrafts((ds) => [...ds, blank(newDate, type)]);

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
      added.push({ ...fromJob(job), key: newKey(), id: undefined });
    }
    setDrafts((ds) => [...ds, ...added]);
    show(`${added.length} job${added.length > 1 ? "s" : ""} added — check and save`, "success");
  };

  const saveDrafts = async () => {
    if (draftView.some((d) => missingFields(toJob(d)).length)) { notify("Some rows are incomplete", "Fill in the amber rows before saving."); return; }
    setBusy(true);
    try {
      const keep = draftView.filter((d) => !d.dup);
      const dupRows = draftView.filter((d) => d.dup);
      const r = keep.length ? await api.ueAddJobs(keep.map(toJob)) : { saved: [], duplicates: [] };
      const serverDups = r.duplicates.map((i) => ({ ...keep[i], dup: true }));
      const leftover = [...dupRows.map((d) => ({ ...d, dup: true })), ...serverDups];
      setDrafts(leftover);
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
        setSaved((ss) => ss.map((s) => (s.key === d.key ? { ...s, dup: true } : s)));
        notify("Duplicate job", "Another job has the same date, start time and amount.");
      } else show("Couldn't update", "error");
    }
  };
  const deleteExisting = async (d: Draft) => {
    try { await api.ueDeleteJob(d.id!); show("Job deleted", "success"); load(); } catch { show("Couldn't delete", "error"); }
  };

  return (
    <Screen scroll header={
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 }}>
        <IconButton testID="ue-back" icon="chevron-back" onPress={() => router.back()} />
        <AppText variant="title" style={{ flex: 1 }}>Uber Eats jobs</AppText>
        <IconButton testID="ue-open-guarantee" icon="stats-chart-outline" onPress={() => router.push("/guarantee" as any)} />
      </View>
    }>
      <Field label="Date for new jobs" hint="Stays set until you change it.">
        <DateField testID="ue-new-date" value={newDate} onChange={changeNewDate} maxToday />
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

      {draftView.length ? (
        <>
          <AppText variant="section" style={{ marginBottom: 8, marginLeft: 4 }}>New jobs — not saved yet</AppText>
          {draftView.map((d, i) => (
            <UEJobRow key={d.key} testID={`ue-draft-${i}`} d={d}
              onChange={(nd) => setDrafts((ds) => ds.map((x) => (x.key === d.key ? nd : x)))}
              onDelete={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))} />
          ))}
          <PrimaryButton testID="ue-save-all" label={busy ? "Saving…" : `Save ${draftView.length} job${draftView.length > 1 ? "s" : ""}`}
            disabled={busy} onPress={saveDrafts} style={{ marginBottom: 20 }} />
        </>
      ) : null}

      <AppText variant="section" style={{ marginBottom: 8, marginLeft: 4 }}>Saved on {auDate(newDate)} · {saved.length}</AppText>
      {saved.length === 0 ? (
        <AppText variant="caption" color={colors.dim} style={{ marginBottom: 24, marginLeft: 4 }}>No jobs saved for this date yet.</AppText>
      ) : saved.map((d, i) => (
        <UEJobRow key={d.key} testID={`ue-saved-${i}`} d={d}
          onChange={(nd) => setSaved((ss) => ss.map((x) => (x.key === d.key ? nd : x)))}
          onDelete={() => deleteExisting(d)} onSave={() => saveExisting(d)} />
      ))}
    </Screen>
  );
}
