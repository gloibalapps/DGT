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
  // dim brightened ~12% for stronger secondary-text hierarchy on the navy bg
  gradient: ["#0B2545", "#2E7FC2"],
  onGradient: "#F1F5F9",
  mode: "dark",
};

const LIGHT: Palette = {
  bg: "#F3F6FA",
  surface: "#FFFFFF",
  surfaceAlt: "#EAF0F7",
  text: "#0B2545",
  dim: "#5B7392",
  accent: "#0C7FD1",
  profit: "#12A25A",
  loss: "#D93A3A",
  warm: "#F2B84B",
  border: "rgba(11,37,69,0.10)",
  gradient: ["#0B2545", "#2E7FC2"],
  onGradient: "#F1F5F9",
  mode: "light",
};

// Plus Jakarta Sans — loaded as static weight files (see app/_layout.tsx).
// Weight is selected by family name so it renders correctly on iOS/Android/web.
export const FONT = {
  display: "PlusJakartaSans-Bold",
  displaySemi: "PlusJakartaSans-SemiBold",
  regular: "PlusJakartaSans-Regular",
  medium: "PlusJakartaSans-Medium",
  semibold: "PlusJakartaSans-SemiBold",
  bold: "PlusJakartaSans-Bold",
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
  colors: DARK,
  mode: "dark",
  setMode: () => {},
  toggle: () => {},
});

const KEY = "gigtax.theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<Mode>("dark");

  useEffect(() => {
    storage.getItem<Mode>(KEY, "dark").then((m) => m && setModeState(m));
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
