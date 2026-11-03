import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import {
  Text, TextProps, View, ViewProps, Pressable, StyleSheet, ScrollView,
  ActivityIndicator, TextInput, TextInputProps, Platform, Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { Calendar } from "react-native-calendars";
import { useTheme, FONT } from "@/src/theme";
import { useStore } from "@/src/store";
import { isoToAU } from "@/src/date";

// ---------------------------------------------------------------- Text
type Variant = "title" | "display" | "displaySemi" | "h1" | "h2" | "body" | "bodyMed" | "bodySemi" | "label" | "caption" | "section";
const FAM: Record<Variant, string> = {
  title: FONT.bold, section: FONT.semibold,
  display: FONT.display, displaySemi: FONT.displaySemi,
  h1: FONT.bold, h2: FONT.semibold, body: FONT.regular, bodyMed: FONT.medium,
  bodySemi: FONT.semibold, label: FONT.medium, caption: FONT.regular,
};
// Inter loaded as static per-weight files — weight comes from the family name
// (FAM), so it renders identically on iOS, Android and web.
// Scale: title 28 · hero 40 · rows 15 · section 12 caps · helper 13.
const SIZE: Record<Variant, number> = {
  title: 28, display: 40, displaySemi: 30, h1: 22, h2: 18, body: 15, bodyMed: 15,
  bodySemi: 15, label: 13, caption: 13, section: 12,
};

export function AppText({ variant = "body", color, style, children, ...rest }:
  TextProps & { variant?: Variant; color?: string }) {
  const { colors } = useTheme();
  return (
    <Text
      {...rest}
      style={[
        {
          fontFamily: FAM[variant], fontSize: SIZE[variant], color: color || (variant === "section" ? colors.dim : colors.text),
        },
        variant === "section" ? { textTransform: "uppercase", letterSpacing: 0.5 } : null,
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
  return `${neg ? "\u2212" : ""}${symbol}${s}`; // true minus sign (aligns with tabular figures)
}

export function Money({ value, symbol = "$", size = 30, color, signed = false, style, numberOfLines, adjustsFontSizeToFit, minimumFontScale }:
  { value: number; symbol?: string; size?: number; color?: string; signed?: boolean; style?: any;
    numberOfLines?: number; adjustsFontSizeToFit?: boolean; minimumFontScale?: number }) {
  const { colors } = useTheme();
  let c = color || colors.text;
  if (signed) c = value > 0 ? colors.profit : value < 0 ? colors.loss : colors.dim;
  const txt = signed && value > 0 ? `+${fmtMoney(value, symbol)}` : fmtMoney(value, symbol);
  return (
    <Text
      numberOfLines={numberOfLines}
      adjustsFontSizeToFit={adjustsFontSizeToFit}
      minimumFontScale={minimumFontScale}
      style={[{
        fontFamily: FONT.display, fontSize: size, color: c,
        fontVariant: ["tabular-nums"], letterSpacing: size >= 28 ? -0.5 : 0,
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
          contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
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

// Title left, small country badge right. No eyebrow/subtitle line (the
// `subtitle` prop is accepted for compatibility but intentionally not shown).
export function ScreenHeader({ title, right }:
  { title: string; right?: React.ReactNode; subtitle?: string }) {
  const { colors } = useTheme();
  const { profile } = useStore();
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, minHeight: 52,
      flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <AppText variant="title" style={{ flex: 1 }} numberOfLines={1}>{title}</AppText>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {right}
        {profile?.country ? (
          <View testID="header-country" style={{ paddingHorizontal: 8, height: 24, borderRadius: 6, justifyContent: "center",
            borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
            <AppText variant="section" color={colors.rowLabel} style={{ letterSpacing: 0.3 }}>{profile.country}</AppText>
          </View>
        ) : null}
      </View>
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

// Gradients are retired — kept as an alias so existing screens get the one
// white card style.
export function GradientCard({ children, style }: { children: React.ReactNode; style?: any }) {
  return <Card style={[{ padding: 20 }, style]}>{children}</Card>;
}

// ---------------------------------------------------------------- Buttons
// One primary (solid primary colour) and one secondary (white + border).
// `tone="danger"` on Secondary renders plain red text with no box.
export function PrimaryButton({ label, onPress, icon, disabled, testID, style }:
  { label: string; onPress: () => void; icon?: any; disabled?: boolean; testID?: string; style?: any; solid?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable testID={testID} onPress={onPress} disabled={disabled}
      style={({ pressed }) => [styles.btn, { backgroundColor: colors.accent, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }, style]}>
      {icon ? <Ionicons name={icon} size={18} color="#FFFFFF" style={{ marginRight: 8 }} /> : null}
      <AppText variant="bodySemi" color="#FFFFFF">{label}</AppText>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, icon, testID, style, tone, disabled }:
  { label: string; onPress: () => void; icon?: any; testID?: string; style?: any; tone?: "default" | "danger"; disabled?: boolean }) {
  const { colors } = useTheme();
  const danger = tone === "danger";
  const color = danger ? colors.loss : colors.text;
  return (
    <Pressable testID={testID} onPress={onPress} disabled={disabled}
      style={({ pressed }) => [styles.btn, danger ? null : {
        borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
      }, { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }, style]}>
      {icon ? <Ionicons name={icon} size={18} color={danger ? colors.loss : colors.accent} style={{ marginRight: 8 }} /> : null}
      <AppText variant="bodySemi" color={color}>{label}</AppText>
    </Pressable>
  );
}

export function IconButton({ icon, onPress, color, size = 22, testID }:
  { icon: any; onPress: () => void; color?: string; size?: number; testID?: string }) {
  const { colors } = useTheme();
  return (
    <Pressable testID={testID} onPress={onPress} hitSlop={10}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" })}>
      <Ionicons name={icon} size={size} color={color || colors.text} />
    </Pressable>
  );
}

// ---------------------------------------------------------------- Section label
export function SectionLabel({ text, style }: { text: string; style?: any }) {
  return <AppText variant="section" style={[{ marginBottom: 8 }, style]}>{text}</AppText>;
}

// ---------------------------------------------------------------- Hero card
// Small muted label · one big number · one line of supporting figures.
export function HeroCard({ label, value, symbol = "$", valueColor, children, testID, unit, display }:
  { label: string; value: number; symbol?: string; valueColor?: string; children?: React.ReactNode; testID?: string; unit?: string; display?: string }) {
  const { colors } = useTheme();
  return (
    <Card testID={testID} style={{ padding: 20, marginBottom: 16 }}>
      <AppText variant="label" color={colors.dim}>{label}</AppText>
      <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 4 }}>
        {display != null ? (
          <Text style={{ fontFamily: FONT.display, fontSize: 40, color: valueColor || colors.text, fontVariant: ["tabular-nums"], letterSpacing: -0.5 }}
            numberOfLines={1}>{display}</Text>
        ) : (
          <Money value={value} symbol={symbol} size={40} color={valueColor} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} />
        )}
        {unit ? <AppText variant="bodySemi" color={colors.dim} style={{ marginLeft: 6 }}>{unit}</AppText> : null}
      </View>
      {children ? <View style={{ marginTop: 6 }}>{children}</View> : null}
    </Card>
  );
}

// ---------------------------------------------------------------- List card
// White card, optional uppercase section label, 48px rows with dividers.
const ListDividerCtx = createContext(false);

export function ListCard({ label, children, style, testID }:
  { label?: string; children: React.ReactNode; style?: any; testID?: string }) {
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <View testID={testID} style={[{ marginBottom: 16 }, style]}>
      {label ? <SectionLabel text={label} style={{ marginLeft: 4 }} /> : null}
      <Card style={{ paddingVertical: 0 }}>
        {items.map((c, i) => (
          <ListDividerCtx.Provider key={i} value={i > 0}>{c}</ListDividerCtx.Provider>
        ))}
      </Card>
    </View>
  );
}

export function ListRow({ label, value, sub, onPress, chevron, valueColor, strong, icon, iconColor, right, testID, trailingIcon }:
  { label: string; value?: string; sub?: string; onPress?: () => void; chevron?: boolean; valueColor?: string;
    strong?: boolean; icon?: any; iconColor?: string; right?: React.ReactNode; testID?: string; trailingIcon?: any }) {
  const { colors } = useTheme();
  const divider = useContext(ListDividerCtx);
  const body = (
    <View style={{ minHeight: 48, paddingVertical: sub ? 10 : 12, flexDirection: "row", alignItems: "center",
      borderTopWidth: divider ? 1 : 0, borderTopColor: colors.divider }}>
      {icon ? <Ionicons name={icon} size={20} color={iconColor || colors.accent} style={{ marginRight: 12 }} /> : null}
      <View style={{ flex: 1, paddingRight: 12 }}>
        <AppText variant={strong ? "bodySemi" : "body"} color={strong ? colors.text : colors.rowLabel}>{label}</AppText>
        {sub ? <AppText variant="caption" color={colors.dim} style={{ marginTop: 2 }}>{sub}</AppText> : null}
      </View>
      {right}
      {value != null ? (
        <AppText variant="bodySemi" color={valueColor || colors.text} style={{ fontVariant: ["tabular-nums"] }}>{value}</AppText>
      ) : null}
      {trailingIcon || chevron || onPress
        ? <Ionicons name={trailingIcon || "chevron-forward"} size={18} color={colors.dim} style={{ marginLeft: 6 }} /> : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{body}</View>;
  return <Pressable testID={testID} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>{body}</Pressable>;
}

// ---------------------------------------------------------------- Toggle
export function Toggle({ value, onChange, testID, disabled }:
  { value: boolean; onChange: () => void; testID?: string; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable testID={testID} onPress={onChange} disabled={disabled} hitSlop={8}
      accessibilityRole="switch" accessibilityState={{ checked: value }}
      style={{ minHeight: 44, justifyContent: "center", marginLeft: 8, opacity: disabled ? 0.5 : 1 }}>
      <View style={{ width: 46, height: 28, borderRadius: 14, padding: 3,
        backgroundColor: value ? colors.accent : colors.border, alignItems: value ? "flex-end" : "flex-start" }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: "#FFFFFF" }} />
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------- Underline tabs
// Max 4 tabs, 15px, active = primary + 2px underline. No pill backgrounds.
export function UnderlineTabs({ options, value, onChange, testIDPrefix }:
  { options: readonly { key: string; label: string }[]; value: string; onChange: (k: string) => void; testIDPrefix?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border, marginHorizontal: 20 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable key={o.key} testID={testIDPrefix ? `${testIDPrefix}-${o.key}` : undefined}
            onPress={() => onChange(o.key)}
            style={{ flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center",
              borderBottomWidth: 2, borderBottomColor: active ? colors.accent : "transparent", marginBottom: -1 }}>
            <AppText variant={active ? "bodySemi" : "body"} color={active ? colors.accent : colors.dim} numberOfLines={1}>{o.label}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- Segmented tabs
// Fixed-width segmented control that always fits the viewport (no horizontal
// scroll/clipping). Labels wrap to two lines when needed (e.g. "Financial Year").
export function SegmentedTabs({ options, value, onChange, testIDPrefix }:
  { options: readonly { key: string; label: string }[]; value: string; onChange: (k: string) => void; testIDPrefix?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 3, marginHorizontal: 20 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable key={o.key} testID={testIDPrefix ? `${testIDPrefix}-${o.key}` : undefined}
            onPress={() => onChange(o.key)}
            style={{ flex: 1, minHeight: 40, borderRadius: 10, alignItems: "center", justifyContent: "center",
              paddingVertical: 5, paddingHorizontal: 2, backgroundColor: active ? colors.surface : "transparent",
              borderWidth: active ? 1 : 0, borderColor: colors.border }}>
            <AppText variant="caption" numberOfLines={2}
              style={{ fontFamily: FONT.semibold, textAlign: "center", fontSize: 13, lineHeight: 16 }}
              color={active ? colors.text : colors.dim}>{o.label}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- Chips row
export function ChipRow({ options, value, onChange, testIDPrefix }:
  { options: { key: string; label: string }[]; value: string; onChange: (k: string) => void; testIDPrefix?: string }) {
  const { colors } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }}
      style={{ maxHeight: 56 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable key={o.key} testID={testIDPrefix ? `${testIDPrefix}-${o.key}` : undefined}
            onPress={() => onChange(o.key)}
            style={{
              minHeight: 44, flexShrink: 0, paddingHorizontal: 14, borderRadius: 12,
              alignItems: "center", justifyContent: "center",
              backgroundColor: colors.surface,
              borderWidth: active ? 1.5 : 1, borderColor: active ? colors.accent : colors.border,
            }}>
            <AppText variant={active ? "bodySemi" : "body"} color={active ? colors.accent : colors.rowLabel}>{o.label}</AppText>
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
        backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 14, minHeight: 44,
        paddingVertical: 12, color: colors.text, fontFamily: FONT.regular, fontSize: 15,
        borderWidth: 1, borderColor: colors.border,
      }, props.style]}
    />
  );
}

// Tappable date field that pops open a calendar — no manual typing.
const CAL_MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

export function DateField({ value, onChange, placeholder = "Select date", testID, maxToday }:
  { value: string; onChange: (iso: string) => void; placeholder?: string; testID?: string; maxToday?: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [yearOpen, setYearOpen] = useState(false);
  const todayISO = new Date().toLocaleDateString("en-CA");
  const [view, setView] = useState(value || todayISO);   // YYYY-MM-DD of the displayed month
  const [calKey, setCalKey] = useState(0);                // bump to remount when jumping years
  const display = value ? isoToAU(value) : "";

  const openPicker = () => {
    setView(value || todayISO);
    setYearOpen(false);
    setCalKey((k) => k + 1);
    setOpen(true);
  };

  const nowYear = new Date().getFullYear();
  const endYear = maxToday ? nowYear : nowYear + 1;
  const years: number[] = [];
  for (let y = endYear; y >= nowYear - 60; y--) years.push(y);

  const pickYear = (y: number) => {
    const mm = view.slice(5, 7) || "01";
    setView(`${y}-${mm}-01`);
    setCalKey((k) => k + 1);   // remount so the calendar jumps to the chosen year
    setYearOpen(false);
  };

  return (
    <>
      <Pressable testID={testID} onPress={openPicker}
        style={{
          backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 14, minHeight: 44,
          paddingVertical: 11, borderWidth: 1, borderColor: colors.border,
          flexDirection: "row", alignItems: "center", justifyContent: "space-between",
        }}>
        <AppText variant="body" color={display ? colors.text : colors.dim}>
          {display || placeholder}
        </AppText>
        <Ionicons name="calendar-outline" size={18} color={colors.dim} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable testID="date-picker-backdrop" onPress={() => setOpen(false)}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <Pressable onPress={() => {}} style={{ width: "100%", maxWidth: 380 }}>
            <View style={{ backgroundColor: colors.surface, borderRadius: 20, padding: 12, borderWidth: 1, borderColor: colors.border }}>
              {yearOpen ? (
                <View>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 6, paddingVertical: 6, marginBottom: 4 }}>
                    <AppText variant="bodySemi" style={{ fontSize: 16 }}>Select year</AppText>
                    <Pressable testID="date-picker-year-back" onPress={() => setYearOpen(false)} hitSlop={8}>
                      <Ionicons name="close" size={20} color={colors.dim} />
                    </Pressable>
                  </View>
                  <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
                    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                      {years.map((y) => {
                        const active = String(y) === view.slice(0, 4);
                        return (
                          <Pressable key={y} testID={`date-picker-year-${y}`} onPress={() => pickYear(y)}
                            style={{ width: "33.33%", paddingVertical: 8, alignItems: "center" }}>
                            <View style={{ paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999,
                              backgroundColor: active ? colors.accent : "transparent" }}>
                              <AppText variant="bodyMed" color={active ? colors.bg : colors.text}>{y}</AppText>
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>
                  </ScrollView>
                </View>
              ) : (
                <>
                  <Calendar
                    key={calKey}
                    current={view}
                    maxDate={maxToday ? todayISO : undefined}
                    onDayPress={(d: any) => { onChange(d.dateString); setOpen(false); }}
                    onMonthChange={(m: any) => setView(m.dateString)}
                    markedDates={value ? { [value]: { selected: true, selectedColor: colors.accent } } : {}}
                    firstDay={1}
                    renderHeader={(d: any) => (
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 6 }}>
                        <AppText variant="bodySemi" style={{ fontSize: 16 }}>{CAL_MONTHS[d.getMonth()]}</AppText>
                        <Pressable testID="date-picker-year-open" onPress={() => setYearOpen(true)} hitSlop={8}
                          style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.surfaceAlt,
                            borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                          <AppText variant="bodySemi" color={colors.accent} style={{ fontSize: 16 }}>{d.getFullYear()}</AppText>
                          <Ionicons name="chevron-down" size={14} color={colors.accent} style={{ marginLeft: 2 }} />
                        </Pressable>
                      </View>
                    )}
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
                    <SecondaryButton testID="date-picker-today" label="Today" style={{ flex: 1 }}
                      onPress={() => { onChange(todayISO); setOpen(false); }} />
                    <SecondaryButton testID="date-picker-close" label="Cancel" style={{ flex: 1 }} onPress={() => setOpen(false)} />
                  </View>
                </>
              )}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

// Compact dropdown that opens a bottom-sheet list — keeps forms short vs. long
// pill rows. Used for GST treatment and expense category.
export function Select({ value, onChange, options, placeholder = "Select", testID, style, title }:
  { value: string; onChange: (k: string) => void;
    options: readonly { key: string; label: string; desc?: string; icon?: any }[];
    placeholder?: string; testID?: string; style?: any; title?: string }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const sel = options.find((o) => o.key === value);
  return (
    <>
      <Pressable testID={testID} onPress={() => setOpen(true)}
        style={{
          backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 14, height: 44,
          borderWidth: 1, borderColor: colors.border,
          flexDirection: "row", alignItems: "center", justifyContent: "space-between", ...(style || {}),
        }}>
        <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
          {sel?.icon ? <Ionicons name={sel.icon} size={18} color={colors.accent} style={{ marginRight: 8 }} /> : null}
          <AppText variant="bodyMed" color={sel ? colors.text : colors.dim} numberOfLines={1}>
            {sel?.label || placeholder}
          </AppText>
        </View>
        <Ionicons name="chevron-down" size={18} color={colors.dim} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable testID={testID ? `${testID}-backdrop` : undefined} onPress={() => setOpen(false)}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}>
          <Pressable onPress={() => {}}
            style={{ backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
              paddingHorizontal: 12, paddingTop: 8, borderWidth: 1, borderColor: colors.border }}>
            <View style={{ alignItems: "center", paddingVertical: 6 }}>
              <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border }} />
            </View>
            {title ? <AppText variant="section" style={{ paddingHorizontal: 10, paddingVertical: 8 }}>{title}</AppText> : null}
            <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingBottom: 16 }} showsVerticalScrollIndicator>
            {options.map((o) => {
              const active = o.key === value;
              return (
                <Pressable key={o.key} testID={testID ? `${testID}-opt-${o.key}` : undefined}
                  onPress={() => { onChange(o.key); setOpen(false); }}
                  style={{ flexDirection: "row", alignItems: "center", minHeight: 48, paddingVertical: 12, paddingHorizontal: 10,
                    borderRadius: 12, backgroundColor: active ? colors.surfaceAlt : "transparent" }}>
                  {o.icon ? <Ionicons name={o.icon} size={20} color={active ? colors.accent : colors.dim} style={{ marginRight: 12 }} /> : null}
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodySemi" color={active ? colors.accent : colors.text}>{o.label}</AppText>
                    {o.desc ? <AppText variant="caption" color={colors.dim} style={{ marginTop: 2 }}>{o.desc}</AppText> : null}
                  </View>
                  {active ? <Ionicons name="checkmark" size={20} color={colors.accent} /> : null}
                </Pressable>
              );
            })}
            </ScrollView>
            <SafeAreaView edges={["bottom"]} />
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
    minHeight: 48, borderRadius: 12, paddingHorizontal: 20,
  },
});
