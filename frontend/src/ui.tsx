import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import {
  Text, TextProps, View, ViewProps, Pressable, StyleSheet, ScrollView,
  ActivityIndicator, TextInput, TextInputProps, Platform, Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { Image } from "expo-image";
import { Calendar } from "react-native-calendars";
import { useTheme, FONT, WEIGHT, Palette } from "@/src/theme";
import { useStore } from "@/src/store";
import { flagUrl } from "@/src/config";
import { isoToAU } from "@/src/date";

// ---------------------------------------------------------------- Text
type Variant = "display" | "displaySemi" | "h1" | "h2" | "body" | "bodyMed" | "bodySemi" | "label" | "caption";
const FAM: Record<Variant, string> = {
  display: FONT.display, displaySemi: FONT.displaySemi,
  h1: FONT.bold, h2: FONT.semibold, body: FONT.regular, bodyMed: FONT.medium,
  bodySemi: FONT.semibold, label: FONT.medium, caption: FONT.regular,
};
// Inter is variable — weight comes from fontWeight; Barlow display uses its own file.
const WGT: Partial<Record<Variant, "400" | "500" | "600" | "700">> = {
  h1: WEIGHT.bold, h2: WEIGHT.semibold, body: WEIGHT.regular, bodyMed: WEIGHT.medium,
  bodySemi: WEIGHT.semibold, label: WEIGHT.medium, caption: WEIGHT.regular,
};
const SIZE: Record<Variant, number> = {
  display: 40, displaySemi: 30, h1: 22, h2: 18, body: 15, bodyMed: 15,
  bodySemi: 15, label: 13, caption: 12,
};

export function AppText({ variant = "body", color, style, children, ...rest }:
  TextProps & { variant?: Variant; color?: string }) {
  const { colors } = useTheme();
  return (
    <Text
      {...rest}
      style={[
        {
          fontFamily: FAM[variant], fontSize: SIZE[variant], color: color || colors.text,
          ...(WGT[variant] ? { fontWeight: WGT[variant] } : {}),
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------- Money
export function fmtMoney(v: number, symbol = "$"): string {
  const neg = v < 0;
  const s = Math.abs(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? "-" : ""}${symbol}${s}`;
}

export function Money({ value, symbol = "$", size = 30, color, signed = false, style }:
  { value: number; symbol?: string; size?: number; color?: string; signed?: boolean; style?: any }) {
  const { colors } = useTheme();
  let c = color || colors.text;
  if (signed) c = value > 0 ? colors.profit : value < 0 ? colors.loss : colors.dim;
  const txt = signed && value > 0 ? `+${fmtMoney(value, symbol)}` : fmtMoney(value, symbol);
  return (
    <Text style={[{
      fontFamily: FONT.display, fontSize: size, color: c,
      fontVariant: ["tabular-nums"], letterSpacing: 0.3,
    }, style]}>
      {txt}
    </Text>
  );
}

// ---------------------------------------------------------------- Screen
export function Screen({ children, header, scroll = false, refreshControl }:
  { children: React.ReactNode; header?: React.ReactNode; scroll?: boolean; refreshControl?: any }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        {header}
      </SafeAreaView>
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={refreshControl}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{children}</View>
      )}
    </View>
  );
}

export function ScreenHeader({ title, right, subtitle }:
  { title: string; right?: React.ReactNode; subtitle?: string }) {
  const { colors } = useTheme();
  const { profile } = useStore();
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
      flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
        {profile?.country ? (
          <Image testID="header-flag" source={{ uri: flagUrl(profile.country, 160) }}
            style={{ width: 40, height: 27, borderRadius: 5, marginRight: 12, borderWidth: 1, borderColor: colors.border }}
            contentFit="cover" />
        ) : null}
        <View style={{ flex: 1 }}>
          {subtitle ? <AppText variant="label" color={colors.dim}>{subtitle}</AppText> : null}
          <AppText variant="h1" style={{ fontFamily: FONT.displaySemi, fontSize: 26 }}>{title}</AppText>
        </View>
      </View>
      {right}
    </View>
  );
}

// ---------------------------------------------------------------- Card
export function Card({ children, style, ...rest }: ViewProps) {
  const { colors } = useTheme();
  return (
    <View {...rest} style={[{
      backgroundColor: colors.surface, borderRadius: 20, padding: 16,
      borderWidth: 1, borderColor: colors.border,
    }, style]}>
      {children}
    </View>
  );
}

export function GradientCard({ children, style }: { children: React.ReactNode; style?: any }) {
  const { colors } = useTheme();
  return (
    <LinearGradient colors={colors.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
      style={[{ borderRadius: 24, padding: 20 }, style]}>
      {children}
    </LinearGradient>
  );
}

// ---------------------------------------------------------------- Buttons
export function PrimaryButton({ label, onPress, icon, disabled, testID, style }:
  { label: string; onPress: () => void; icon?: any; disabled?: boolean; testID?: string; style?: any }) {
  const { colors } = useTheme();
  return (
    <Pressable testID={testID} onPress={onPress} disabled={disabled}
      style={({ pressed }) => [{ opacity: disabled ? 0.5 : pressed ? 0.9 : 1 }, style]}>
      <LinearGradient colors={colors.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={styles.btn}>
        {icon ? <Ionicons name={icon} size={18} color="#F1F5F9" style={{ marginRight: 8 }} /> : null}
        <AppText variant="bodySemi" color="#F1F5F9">{label}</AppText>
      </LinearGradient>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, icon, testID, style, tone }:
  { label: string; onPress: () => void; icon?: any; testID?: string; style?: any; tone?: "default" | "danger" }) {
  const { colors } = useTheme();
  const color = tone === "danger" ? colors.loss : colors.accent;
  return (
    <Pressable testID={testID} onPress={onPress}
      style={({ pressed }) => [styles.btn, {
        borderWidth: 1, borderColor: color, opacity: pressed ? 0.7 : 1,
        backgroundColor: colors.surfaceAlt,
      }, style]}>
      {icon ? <Ionicons name={icon} size={18} color={color} style={{ marginRight: 8 }} /> : null}
      <AppText variant="bodySemi" color={color}>{label}</AppText>
    </Pressable>
  );
}

export function IconButton({ icon, onPress, color, size = 22, testID }:
  { icon: any; onPress: () => void; color?: string; size?: number; testID?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable testID={testID} onPress={onPress} hitSlop={10}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, padding: 6 })}>
      <Ionicons name={icon} size={size} color={color || colors.text} />
    </Pressable>
  );
}

// ---------------------------------------------------------------- Chips row
export function ChipRow({ options, value, onChange, testIDPrefix }:
  { options: { key: string; label: string }[]; value: string; onChange: (k: string) => void; testIDPrefix?: string }) {
  const { colors } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
      style={{ maxHeight: 56 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable key={o.key} testID={testIDPrefix ? `${testIDPrefix}-${o.key}` : undefined}
            onPress={() => onChange(o.key)}
            style={{
              height: 36, flexShrink: 0, paddingHorizontal: 16, borderRadius: 999,
              alignItems: "center", justifyContent: "center",
              backgroundColor: active ? colors.accent : colors.surfaceAlt,
              borderWidth: 1, borderColor: active ? colors.accent : colors.border,
            }}>
            <AppText variant="bodyMed" color={active ? colors.bg : colors.dim}>{o.label}</AppText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ---------------------------------------------------------------- Badge
export function Badge({ label, color, bg }: { label: string; color?: string; bg?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{
      paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
      backgroundColor: bg || colors.surfaceAlt, alignSelf: "flex-start",
    }}>
      <AppText variant="caption" color={color || colors.dim}>{label}</AppText>
    </View>
  );
}

// ---------------------------------------------------------------- Input
export function Field({ label, hint, children }:
  { label?: string; hint?: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ marginBottom: 16 }}>
      {label ? <AppText variant="label" color={colors.dim} style={{ marginBottom: 6 }}>{label}</AppText> : null}
      {children}
      {hint ? <AppText variant="caption" color={colors.dim} style={{ marginTop: 6 }}>{hint}</AppText> : null}
    </View>
  );
}

export function Input(props: TextInputProps) {
  const { colors } = useTheme();
  return (
    <TextInput
      placeholderTextColor={colors.dim}
      {...props}
      style={[{
        backgroundColor: colors.surfaceAlt, borderRadius: 12, paddingHorizontal: 14,
        paddingVertical: 14, color: colors.text, fontFamily: FONT.regular, fontSize: 16,
        borderWidth: 1, borderColor: colors.border,
      }, props.style]}
    />
  );
}

// Tappable date field that pops open a calendar — no manual typing.
export function DateField({ value, onChange, placeholder = "Select date", testID, maxToday }:
  { value: string; onChange: (iso: string) => void; placeholder?: string; testID?: string; maxToday?: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const display = value ? isoToAU(value) : "";
  const todayISO = new Date().toLocaleDateString("en-CA");
  return (
    <>
      <Pressable testID={testID} onPress={() => setOpen(true)}
        style={{
          backgroundColor: colors.surfaceAlt, borderRadius: 12, paddingHorizontal: 14,
          paddingVertical: 15, borderWidth: 1, borderColor: colors.border,
          flexDirection: "row", alignItems: "center", justifyContent: "space-between",
        }}>
        <AppText variant="body" color={display ? colors.text : colors.dim} style={{ fontSize: 16 }}>
          {display || placeholder}
        </AppText>
        <Ionicons name="calendar-outline" size={20} color={colors.accent} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable testID="date-picker-backdrop" onPress={() => setOpen(false)}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <Pressable onPress={() => {}} style={{ width: "100%", maxWidth: 380 }}>
            <View style={{ backgroundColor: colors.surface, borderRadius: 20, padding: 12, borderWidth: 1, borderColor: colors.border }}>
              <Calendar
                current={value || todayISO}
                maxDate={maxToday ? todayISO : undefined}
                onDayPress={(d: any) => { onChange(d.dateString); setOpen(false); }}
                markedDates={value ? { [value]: { selected: true, selectedColor: colors.accent } } : {}}
                firstDay={1}
                enableSwipeMonths
                theme={{
                  calendarBackground: colors.surface,
                  textSectionTitleColor: colors.dim,
                  dayTextColor: colors.text,
                  todayTextColor: colors.accent,
                  monthTextColor: colors.text,
                  textMonthFontFamily: FONT.semibold,
                  textDayFontFamily: FONT.regular,
                  textDayHeaderFontFamily: FONT.medium,
                  arrowColor: colors.accent,
                  selectedDayBackgroundColor: colors.accent,
                  selectedDayTextColor: colors.bg,
                  textDisabledColor: colors.dim,
                }}
              />
              <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
                {value ? (
                  <SecondaryButton testID="date-picker-clear" label="Clear" tone="danger" style={{ flex: 1 }}
                    onPress={() => { onChange(""); setOpen(false); }} />
                ) : null}
                <SecondaryButton testID="date-picker-close" label="Close" style={{ flex: 1 }} onPress={() => setOpen(false)} />
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- misc
export function Spinner() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator color={colors.accent} size="large" />
    </View>
  );
}

export function EmptyState({ icon, title, subtitle }:
  { icon: any; title: string; subtitle?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignItems: "center", justifyContent: "center", padding: 40 }}>
      <View style={{
        width: 72, height: 72, borderRadius: 999, backgroundColor: colors.surfaceAlt,
        alignItems: "center", justifyContent: "center", marginBottom: 16,
      }}>
        <Ionicons name={icon} size={34} color={colors.accent} />
      </View>
      <AppText variant="h2" style={{ marginBottom: 4 }}>{title}</AppText>
      {subtitle ? <AppText variant="body" color={colors.dim} style={{ textAlign: "center" }}>{subtitle}</AppText> : null}
    </View>
  );
}

// ---------------------------------------------------------------- Toast
interface ToastCtx { show: (msg: string, tone?: "info" | "success" | "error") => void; }
const ToastContext = createContext<ToastCtx>({ show: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const [toast, setToast] = useState<{ msg: string; tone: string } | null>(null);

  const show = useCallback((msg: string, tone: "info" | "success" | "error" = "info") => {
    setToast({ msg, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const toneColor = toast?.tone === "success" ? colors.profit
    : toast?.tone === "error" ? colors.loss : colors.accent;

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast ? (
        <Animated.View entering={FadeInDown} exiting={FadeOut}
          style={{
            position: "absolute", bottom: Platform.OS === "ios" ? 110 : 90, left: 16, right: 16,
            backgroundColor: colors.surface, borderRadius: 14, padding: 14,
            borderLeftWidth: 4, borderLeftColor: toneColor, borderWidth: 1, borderColor: colors.border,
            flexDirection: "row", alignItems: "center",
          }}>
          <Ionicons
            name={toast.tone === "success" ? "checkmark-circle" : toast.tone === "error" ? "alert-circle" : "information-circle"}
            size={20} color={toneColor} style={{ marginRight: 10 }} />
          <AppText variant="bodyMed" style={{ flex: 1 }}>{toast.msg}</AppText>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    height: 52, borderRadius: 14, paddingHorizontal: 20,
  },
});
