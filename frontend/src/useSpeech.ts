import { useEffect, useRef, useState } from "react";
import { Alert, Linking, Platform } from "react-native";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";

const SILENCE_MS = 60_000;

/**
 * Continuous en-AU dictation. Keeps listening through pauses; stops on stop()
 * or after 60 s with no new speech. `finalText` accumulates finished phrases,
 * `interim` is the live partial phrase.
 */
export function useSpeech() {
  const [listening, setListening] = useState(false);
  const [finalText, setFinalText] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wantRef = useRef(false);

  const armSilence = () => {
    if (silenceRef.current) clearTimeout(silenceRef.current);
    silenceRef.current = setTimeout(() => stop(), SILENCE_MS);
  };

  useSpeechRecognitionEvent("result", (e: any) => {
    const txt = e.results?.[0]?.transcript || "";
    if (e.isFinal) { setFinalText((t) => (t ? `${t}\n${txt}` : txt).trim()); setInterim(""); }
    else setInterim(txt);
    armSilence();
  });
  useSpeechRecognitionEvent("error", (e: any) => {
    if (e.error === "no-speech" || e.error === "speech-timeout") return; // silence — keep going
    wantRef.current = false; // fatal (permission/network/no service) — don't auto-restart
    setListening(false);
    setError(e.message || e.error || "Speech recognition failed");
  });
  useSpeechRecognitionEvent("end", () => {
    // Some engines end after a pause even in continuous mode — restart until
    // the driver taps Done or the 60 s silence timer fires.
    if (wantRef.current) { try { begin(); } catch { setListening(false); } }
    else setListening(false);
  });

  const begin = () => ExpoSpeechRecognitionModule.start({
    lang: "en-AU", interimResults: true, continuous: true, addsPunctuation: false,
  });

  /** Ask for mic + speech permission contextually; Open Settings if blocked. */
  const ensurePermission = async (): Promise<boolean> => {
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setError(Platform.OS === "web" ? "Voice input isn't supported in this browser" : "Speech recognition isn't available on this phone");
      return false;
    }
    const cur = await ExpoSpeechRecognitionModule.getPermissionsAsync();
    if (cur.granted) return true;
    if (!cur.canAskAgain) {
      Alert.alert("Microphone is off", "Turn on Microphone and Speech Recognition for GigTax in Settings to speak your jobs.",
        [{ text: "Not now", style: "cancel" }, { text: "Open Settings", onPress: () => Linking.openSettings() }]);
      return false;
    }
    const res = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!res.granted && !res.canAskAgain) {
      Alert.alert("Microphone is off", "You can turn it on any time in Settings.",
        [{ text: "Not now", style: "cancel" }, { text: "Open Settings", onPress: () => Linking.openSettings() }]);
    }
    return res.granted;
  };

  const start = async () => {
    setError(null); setFinalText(""); setInterim("");
    if (!(await ensurePermission())) return false;
    wantRef.current = true;
    setListening(true);
    armSilence();
    try { begin(); } catch (e: any) { wantRef.current = false; setListening(false); setError(e?.message || "Couldn't start the mic"); return false; }
    return true;
  };

  function stop() {
    wantRef.current = false;
    if (silenceRef.current) clearTimeout(silenceRef.current);
    try { ExpoSpeechRecognitionModule.stop(); } catch { /* already stopped */ }
    setListening(false);
  }

  useEffect(() => () => { wantRef.current = false; if (silenceRef.current) clearTimeout(silenceRef.current); try { ExpoSpeechRecognitionModule.abort(); } catch { /* noop */ } }, []);

  const transcript = [finalText, interim].filter(Boolean).join("\n");
  return { listening, transcript, finalText, interim, error, start, stop };
}
