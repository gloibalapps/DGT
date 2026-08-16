import React, { useEffect, useRef, useState } from "react";
import {
  View, ScrollView, TextInput, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import { useTheme, FONT } from "@/src/theme";
import { useStore } from "@/src/store";
import { api } from "@/src/api";
import { AppText, ScreenHeader } from "@/src/ui";

interface Msg { role: "user" | "assistant"; text: string }

const SUGGESTIONS_AU = [
  "Can I claim fuel on the cents-per-km method?",
  "What car expenses can I claim with a logbook?",
  "Do I have to register for GST as an Uber driver?",
  "Can I claim parking fines?",
];
const SUGGESTIONS_US = [
  "What is the standard mileage rate this year?",
  "Can I deduct tolls on top of standard mileage?",
  "What expenses go on my Schedule C?",
  "Do I pay estimated taxes quarterly?",
];

export default function Ask() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { profile } = useStore();
  const isUS = profile?.country === "US";
  const authority = isUS ? "IRS" : "ATO";

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(t);
  }, [messages, loading]);

  const send = async (q?: string) => {
    const question = (q ?? input).trim();
    if (!question || loading) return;
    const history = messages.slice(-6);
    setMessages((m) => [...m, { role: "user", text: question }]);
    setInput("");
    setLoading(true);
    try {
      const res = await api.ask(question, isUS ? "US" : "AU", history);
      setMessages((m) => [...m, { role: "assistant", text: res?.answer || "Sorry, I couldn't answer that." }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: "Something went wrong reaching the assistant. Please try again." }]);
    } finally {
      setLoading(false);
    }
  };

  const suggestions = isUS ? SUGGESTIONS_US : SUGGESTIONS_AU;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
        <ScreenHeader subtitle={`Grounded in ${authority} guidance`} title="Ask GigTax" />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top + 8}>
        <ScrollView ref={scrollRef} style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 8 }} showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">

          {/* Disclaimer */}
          <View style={{ flexDirection: "row", backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 12, marginBottom: 14 }}>
            <Ionicons name="shield-checkmark" size={16} color={colors.accent} style={{ marginRight: 8, marginTop: 1 }} />
            <AppText variant="caption" color={colors.dim} style={{ flex: 1, lineHeight: 16 }}>
              Answers use only verified {authority} guidance — no web search. General info, not personal tax advice. Confirm with a registered tax agent before {isUS ? "filing" : "lodging"}.
            </AppText>
          </View>

          {messages.length === 0 ? (
            <View>
              <View style={{ alignItems: "center", marginVertical: 12 }}>
                <View style={{ width: 60, height: 60, borderRadius: 18, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
                  <Ionicons name="sparkles" size={28} color={colors.bg} />
                </View>
                <AppText variant="bodySemi" style={{ textAlign: "center" }}>Ask about what you can claim</AppText>
                <AppText variant="caption" color={colors.dim} style={{ textAlign: "center", marginTop: 4, maxWidth: 300, lineHeight: 18 }}>
                  Tax questions for {isUS ? "US" : "Australian"} rideshare & delivery drivers, answered from official {authority} rules.
                </AppText>
              </View>
              <AppText variant="label" color={colors.dim} style={{ marginBottom: 8, marginTop: 8 }}>TRY ASKING</AppText>
              {suggestions.map((s) => (
                <Pressable key={s} testID={`ask-suggestion-${s.slice(0, 10)}`} onPress={() => send(s)}
                  style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.surface,
                    borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, marginBottom: 8 }}>
                  <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.accent} style={{ marginRight: 10 }} />
                  <AppText variant="bodyMed" style={{ flex: 1 }}>{s}</AppText>
                  <Ionicons name="arrow-forward" size={16} color={colors.dim} />
                </Pressable>
              ))}
            </View>
          ) : (
            messages.map((m, i) => (
              <View key={i} style={{ alignItems: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 10 }}>
                <View style={{
                  maxWidth: "88%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10,
                  backgroundColor: m.role === "user" ? colors.accent : colors.surface,
                  borderWidth: m.role === "user" ? 0 : 1, borderColor: colors.border,
                }}>
                  <AppText variant="body"
                    color={m.role === "user" ? colors.bg : colors.text}
                    style={{ lineHeight: 21 }}>{m.text}</AppText>
                </View>
              </View>
            ))
          )}

          {loading ? (
            <View style={{ alignItems: "flex-start", marginBottom: 10 }}>
              <View style={{ borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
                <ActivityIndicator color={colors.accent} />
              </View>
            </View>
          ) : null}
        </ScrollView>

        {/* Input bar */}
        <View style={{
          flexDirection: "row", alignItems: "flex-end", gap: 8,
          paddingHorizontal: 12, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 10),
          borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface,
        }}>
          <TextInput
            testID="ask-input"
            value={input}
            onChangeText={setInput}
            placeholder={`Ask a ${authority} tax question…`}
            placeholderTextColor={colors.dim}
            multiline
            style={{
              flex: 1, color: colors.text, fontFamily: FONT.regular, fontSize: 16,
              maxHeight: 120, backgroundColor: colors.surfaceAlt, borderRadius: 20,
              paddingHorizontal: 16, paddingTop: 10, paddingBottom: 10,
            }}
            onSubmitEditing={() => send()}
          />
          <Pressable testID="ask-send" onPress={() => send()} disabled={loading || !input.trim()}
            style={{
              width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center",
              backgroundColor: input.trim() && !loading ? colors.accent : colors.surfaceAlt,
            }}>
            <Ionicons name="arrow-up" size={22} color={input.trim() && !loading ? colors.bg : colors.dim} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
