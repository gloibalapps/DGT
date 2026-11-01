import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { storage } from "@/src/utils/storage";

export type Mode = "dark" | "light";

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  dim: string;
  accent: string;
  profit: string;
  loss: string;
  warm: string;
  border: string;
  divider: string;
  rowLabel: string;
  gradient: [string, string];
  onGradient: string;
  mode: Mode;
}

const DARK: Palette = {
  bg: "#0A1420",
  surface: "#111F31",
  surfaceAlt: "#16293F",
  text: "#F1F5F9",
  dim: "#A6B8CE",
  accent: "#38BDF8",
  profit: "#2BD47D",
  loss: "#FF5C5C",
  warm: "#F2B84B",
  border: "rgba(140,163,188,0.16)",
  divider: "rgba(140,163,188,0.12)",
  rowLabel: "#CBD5E1",
  // dim brightened ~12% for stronger secondary-text hierarchy on the navy bg
  gradient: ["#0B2545", "#2E7FC2"],
  onGradient: "#F1F5F9",
  mode: "dark",
};

// Light "Reports redesign" system — one white card style everywhere.
const LIGHT: Palette = {
  bg: "#F6F7FA",
  surface: "#FFFFFF",
  surfaceAlt: "#F1F4F8",
  text: "#0F172A",
  dim: "#5B6475",
  accent: "#0B6FD6",
  profit: "#15803D",
  loss: "#C2403A",
  warm: "#B45309",
  border: "#E2E6EE",
  divider: "#EEF1F6",
  rowLabel: "#334155",
  // gradients retired — kept as flat values for any legacy consumer
  gradient: ["#FFFFFF", "#FFFFFF"],
  onGradient: "#0F172A",
  mode: "light",
};

// Inter — loaded as static weight files (see app/_layout.tsx).
// Weight is selected by family name so it renders correctly on iOS/Android/web.
export const FONT = {
  display: "Inter-Bold",
  displaySemi: "Inter-SemiBold",
  regular: "Inter-Regular",
  medium: "Inter-Medium",
  semibold: "Inter-SemiBold",
  bold: "Inter-Bold",
};

export const WEIGHT: Record<string, "400" | "500" | "600" | "700"> = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
};

interface ThemeCtx {
  colors: Palette;
  mode: Mode;
  setMode: (m: Mode) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx>({
  colors: LIGHT,
  mode: "light",
  setMode: () => {},
  toggle: () => {},
});

const KEY = "gigtax.theme.v2"; // v2: light redesign is the default

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<Mode>("light");

  useEffect(() => {
    storage.getItem<Mode>(KEY, "light").then((m) => m && setModeState(m));
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    storage.setItem(KEY, m);
  }, []);

  const toggle = useCallback(() => setMode(mode === "dark" ? "light" : "dark"), [mode, setMode]);

  return (
    <Ctx.Provider value={{ colors: mode === "dark" ? DARK : LIGHT, mode, setMode, toggle }}>
      {children}
    </Ctx.Provider>
  );
}

export const useTheme = () => useContext(Ctx);
