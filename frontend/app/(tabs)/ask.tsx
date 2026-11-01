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
import { AppText, ScreenHeader, ListCard, ListRow } from "@/src/ui";

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
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top + 8}>
        <ScreenHeader title="Ask" />
        <ScrollView ref={scrollRef} style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingTop: 4, paddingBottom: 8 }} showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">

          {/* Disclaimer */}
          <View style={{ flexDirection: "row", marginBottom: 16 }}>
            <Ionicons name="shield-checkmark-outline" size={16} color={colors.dim} style={{ marginRight: 8, marginTop: 1 }} />
            <AppText variant="caption" color={colors.dim} style={{ flex: 1, lineHeight: 18 }}>
              Answers use only verified {authority} guidance — no web search. General info, not personal tax advice. Confirm with a registered tax agent before {isUS ? "filing" : "lodging"}.
            </AppText>
          </View>

          {messages.length === 0 ? (
            <View>
              <View style={{ marginBottom: 16 }}>
                <AppText variant="h2">Ask about what you can claim</AppText>
                <AppText variant="caption" color={colors.dim} style={{ marginTop: 4, lineHeight: 18 }}>
                  Tax questions for {isUS ? "US" : "Australian"} rideshare & delivery drivers, answered from official {authority} rules.
                </AppText>
              </View>
              <ListCard label="Try asking">
                {suggestions.map((s, i) => (
                  <ListRow key={s} testID={`ask-suggestion-${i}`} label={s} onPress={() => send(s)} />
                ))}
              </ListCard>
            </View>
          ) : (
            messages.map((m, i) => (
              <View key={i} style={{ alignItems: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 10 }}>
                <View style={{
                  maxWidth: "88%", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
                  backgroundColor: m.role === "user" ? colors.accent : colors.surface,
                  borderWidth: m.role === "user" ? 0 : 1, borderColor: colors.border,
                }}>
                  <AppText variant="body"
                    color={m.role === "user" ? "#FFFFFF" : colors.text}
                    style={{ lineHeight: 21 }}>{m.text}</AppText>
                </View>
              </View>
            ))
          )}

          {loading ? (
            <View style={{ alignItems: "flex-start", marginBottom: 10 }}>
              <View style={{ borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
                <ActivityIndicator color={colors.accent} />
              </View>
            </View>
          ) : null}
        </ScrollView>

        {/* Input bar */}
        <View style={{
          flexDirection: "row", alignItems: "flex-end", gap: 8,
          paddingHorizontal: 20, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 10),
          borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface,
        }}>
          <TextInput
            testID="ask-input"
            value={input}
            onChangeText={setInput}
            placeholder={`Ask an ${authority} tax question…`}
            placeholderTextColor={colors.dim}
            multiline
            style={{
              flex: 1, color: colors.text, fontFamily: FONT.regular, fontSize: 15, minHeight: 44, height: Platform.OS === "web" ? 44 : undefined,
              maxHeight: 120, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
              paddingHorizontal: 14, paddingTop: 11, paddingBottom: 11,
            }}
            onSubmitEditing={() => send()}
          />
          <Pressable testID="ask-send" onPress={() => send()} disabled={loading || !input.trim()}
            style={{
              width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center",
              backgroundColor: input.trim() && !loading ? colors.accent : colors.surfaceAlt,
            }}>
            <Ionicons name="arrow-up" size={22} color={input.trim() && !loading ? "#FFFFFF" : colors.dim} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
