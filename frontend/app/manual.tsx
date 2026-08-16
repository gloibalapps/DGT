import React, { useState } from "react";
import { View, ScrollView, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useTheme } from "@/src/theme";
import { useStore } from "@/src/store";
import { AppText, Card, IconButton } from "@/src/ui";

type Line = string;
interface Sect { icon: any; title: string; lines: Line[] }

function Accordion({ sect, open, onToggle }: { sect: Sect; open: boolean; onToggle: () => void }) {
  const { colors } = useTheme();
  return (
    <Card style={{ marginBottom: 12, padding: 0, overflow: "hidden" }}>
      <Pressable onPress={onToggle}
        style={{ flexDirection: "row", alignItems: "center", padding: 16 }}>
        <View style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: colors.surfaceAlt,
          alignItems: "center", justifyContent: "center", marginRight: 12 }}>
          <Ionicons name={sect.icon} size={20} color={colors.accent} />
        </View>
        <AppText variant="bodySemi" style={{ flex: 1 }}>{sect.title}</AppText>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={20} color={colors.dim} />
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}>
          {sect.lines.map((l, i) => (
            <View key={i} style={{ flexDirection: "row" }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent,
                marginTop: 7, marginRight: 10 }} />
              <AppText variant="body" color={colors.dim} style={{ flex: 1, lineHeight: 21 }}>{l}</AppText>
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

export default function Manual() {
  const { colors } = useTheme();
  const router = useRouter();
  const { profile } = useStore();
  const isUS = profile?.country === "US";
  const [openIdx, setOpenIdx] = useState<number>(0);

  const taxSection: Sect = isUS
    ? {
        icon: "document-text",
        title: "Reports & your tax figures (US)",
        lines: [
          "Pick a period at the top — Week, Month, Quarter or Year (calendar quarters for 1040-ES).",
          "Schedule C card estimates your gross receipts, car & truck expense, other expenses and net profit (Line 31).",
          "\u201CWhich method is better?\u201D compares the IRS standard mileage rate against your actual car costs and recommends the larger deduction.",
          "\u201CSet aside for taxes\u201D estimates self-employment tax (~15.3%) plus estimated federal and state income tax to save.",
          "Tap Export CSV to download every line for your records or your accountant.",
        ],
      }
    : {
        icon: "document-text",
        title: "Reports & your tax figures (AU)",
        lines: [
          "Pick a period at the top — Week, Month, BAS Quarter or Financial Year (1 Jul\u201330 Jun).",
          "Net profit = total income minus your vehicle deduction and other work expenses.",
          "\u201CWhich method is better?\u201D shows your logbook deduction vs cents-per-km so you claim the bigger one.",
          "If you're GST-registered, the BAS/GST card gives you G1, 1A, 1B and Net GST to copy onto your BAS.",
          "\u201CSet aside for taxes\u201D estimates income tax (incl. Medicare levy) plus any GST to remit.",
          "Tap Export CSV to download every line for your records or your tax agent.",
        ],
      };

  const sections: Sect[] = [
    {
      icon: "rocket",
      title: "Welcome to GigTax",
      lines: [
        "GigTax turns your driving into the income, mileage and tax figures you actually need to lodge.",
        "Built for rideshare and delivery drivers (Uber, DoorDash, Uber Eats, Menulog, Amazon Flex and more).",
        "Everything you log is saved to your device and (when signed in) synced to the cloud.",
        "The bottom tabs are your main areas: Home, Mileage, Ledger, Reports and Profile.",
      ],
    },
    {
      icon: "flag",
      title: "Getting set up",
      lines: [
        "On first launch, choose your country and state/territory — this sets your tax rules and currency.",
        "Pick your work type (passengers, delivery, or both). Only the platforms that match are shown next.",
        "Select the platforms you drive for, then add your vehicle details.",
        "You can change any of this later in the Profile tab.",
      ],
    },
    {
      icon: "home",
      title: "Your Home dashboard",
      lines: [
        "See your net earnings today, plus income and expenses at a glance.",
        "Business kilometres/miles driven today are shown as you log trips.",
        "If you set a recurring vehicle payment, you'll see what's owed this quarter.",
        "The Performance chart shows your last 4 weeks of profit, $/km and $/hr.",
      ],
    },
    {
      icon: "add-circle",
      title: "Logging income & expenses",
      lines: [
        "Use the quick-add on Home, or the Ledger tab, to add income or an expense.",
        "Tag each expense with a category (fuel, tolls, vehicle, phone, other) and the vehicle it belongs to.",
        "Scan a receipt with your camera and GigTax reads the amount and merchant for you.",
        "Every entry can be edited or deleted later — just tap it.",
      ],
    },
    {
      icon: "navigate",
      title: "Tracking your mileage",
      lines: [
        "The Mileage tab is your logbook. Start a GPS shift and GigTax records the drive, then asks you to tag it Business or Personal.",
        "You can also add a trip manually with distance and purpose.",
        "Your business-use % is calculated from your tagged trips — a real logbook, not a guess.",
        "Add your odometer readings (start & end of the tax year) for an audit-proof total; GigTax reconciles them against your GPS.",
      ],
    },
    {
      icon: "car-sport",
      title: "Managing your vehicles",
      lines: [
        "Add and edit all your cars in Profile \u203A Vehicles.",
        "Each car keeps its own trips, expenses, logbook and deduction.",
        "Vehicles are identified by their registration number when you pick which car you're driving.",
        "Tap \u201CSet active\u201D to choose the car you're currently driving — new trips are assigned to it.",
      ],
    },
    taxSection,
    {
      icon: "shield-checkmark",
      title: "Tax setup",
      lines: [
        "Open Profile \u203A Tax setup to add your legal name and registration details.",
        isUS
          ? "This keeps your Schedule C and estimated-tax figures accurate."
          : "Mark whether you're GST-registered so your BAS/GST summary shows correctly. Passenger drivers must register from their first dollar; delivery-only above $75,000 turnover.",
      ],
    },
    {
      icon: "flash",
      title: "Automatic drive detection",
      lines: [
        "In Profile \u203A Automatic tracking you can let GigTax detect drives in the background — no start/stop needed.",
        "It logs each drive and asks you to tag it Business or Personal later.",
        "Grant background-location permission when asked so it can log drives while you work.",
      ],
    },
    {
      icon: "star",
      title: "GigTax Pro",
      lines: [
        "GigTax Pro unlocks the full app with a 7-day free trial, then a monthly or yearly plan.",
        "Manage or start your subscription in Profile \u203A Subscription.",
        "Purchases are handled securely through the App Store or Google Play.",
      ],
    },
    {
      icon: "bulb",
      title: "Tips for a bullet-proof logbook",
      lines: [
        "Tag every trip Business or Personal on the day — it's quick and keeps your % accurate.",
        "Keep 12 continuous weeks of trips for a valid ATO logbook (AU); keep a mileage log all year (US).",
        "Snap receipts as you go so nothing is missed at tax time.",
        "Enter odometer readings at the start and end of the tax year.",
      ],
    },
    {
      icon: "information-circle",
      title: "Important",
      lines: [
        "GigTax gives estimates to help you plan — it is not tax advice.",
        "Your final figures depend on your actual records and your country's tax rules.",
        "Always confirm with a registered tax professional before you lodge.",
      ],
    },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 }}>
          <IconButton icon="close" testID="manual-close" onPress={() => router.back()} />
          <AppText variant="h2">User Guide</AppText>
          <View style={{ width: 34 }} />
        </View>
      </SafeAreaView>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <AppText variant="body" color={colors.dim} style={{ marginBottom: 16, lineHeight: 21 }}>
          A quick operating manual for drivers. Tap any section to expand it.
        </AppText>
        {sections.map((s, i) => (
          <Accordion key={i} sect={s} open={openIdx === i} onToggle={() => setOpenIdx(openIdx === i ? -1 : i)} />
        ))}
      </ScrollView>
    </View>
  );
}
