import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { api, ProfileT, VehicleT } from "@/src/api";
import { storage } from "@/src/utils/storage";
import { AppState } from "react-native";
import { maybeAutoBackup } from "@/src/backup";

const PROFILE_CACHE = "gigtax.cache.profile";
const VEHICLES_CACHE = "gigtax.cache.vehicles";

interface Store {
  profile: ProfileT | null;
  vehicles: VehicleT[];
  activeVehicle: VehicleT | null;
  activeVehicleId: string | null;
  loading: boolean;
  loadError: boolean;
  version: number; // bump to force data reload across screens
  refresh: () => void;
  reloadProfile: () => Promise<void>;
  reloadVehicles: () => Promise<void>;
  setActiveVehicle: (id: string) => Promise<void>;
  updateProfile: (patch: Partial<ProfileT>) => Promise<ProfileT | null>;
}

const Ctx = createContext<Store>({
  profile: null,
  vehicles: [],
  activeVehicle: null,
  activeVehicleId: null,
  loading: true,
  loadError: false,
  version: 0,
  refresh: () => {},
  reloadProfile: async () => {},
  reloadVehicles: async () => {},
  setActiveVehicle: async () => {},
  updateProfile: async () => null,
});

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<ProfileT | null>(null);
  const [vehicles, setVehicles] = useState<VehicleT[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);

  const activeVehicle = vehicles.find((v) => v.is_active) || vehicles[0] || null;

  const reloadProfile = useCallback(async () => {
    try {
      const p = await api.getProfile();
      if (mounted.current) { setProfile(p); setLoadError(false); }
      storage.setItem(PROFILE_CACHE, JSON.stringify(p));
    } catch (e) {
      console.log("profile load error", e);
      // Keep any previously loaded profile; flag the error so the UI shows a
      // retry state instead of falsely dropping the driver into onboarding.
      if (mounted.current) setLoadError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const reloadVehicles = useCallback(async () => {
    try {
      const v = await api.listVehicles();
      if (mounted.current) setVehicles(v);
      storage.setItem(VEHICLES_CACHE, JSON.stringify(v));
    } catch (e) {
      console.log("vehicles load error", e);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Show the last-known profile/vehicles instantly, then refresh from the server.
    (async () => {
      try {
        const [p, v] = await Promise.all([
          storage.getItem<string>(PROFILE_CACHE, ""), storage.getItem<string>(VEHICLES_CACHE, ""),
        ]);
        if (mounted.current && v) setVehicles((cur) => (cur.length ? cur : JSON.parse(v)));
        if (mounted.current && p) { setProfile((cur) => cur || JSON.parse(p)); setLoading(false); }
      } catch { /* cache miss — network load below covers it */ }
    })();
    reloadProfile();
    reloadVehicles();
    return () => { mounted.current = false; };
  }, [reloadProfile, reloadVehicles]);

  // Daily Drive auto-backup: runs once signed in (this provider only mounts
  // after login) and again whenever the app comes back to the foreground.
  useEffect(() => {
    const t = setTimeout(() => { maybeAutoBackup(); }, 5000);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") maybeAutoBackup(); });
    return () => { clearTimeout(t); sub.remove(); };
  }, []);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const setActiveVehicle = useCallback(async (id: string) => {
    try {
      const list = await api.activateVehicle(id);
      setVehicles(list);
      setVersion((v) => v + 1);
    } catch (e) {
      console.log("setActiveVehicle failed", e);
    }
  }, []);

  const updateProfile = useCallback(async (patch: Partial<ProfileT>) => {
    try {
      const p = await api.saveProfile(patch);
      setProfile(p);
      setVersion((v) => v + 1);
      return p;
    } catch (e) {
      console.log("updateProfile failed", e);
      return null;
    }
  }, []);

  return (
    <Ctx.Provider value={{
      profile, vehicles, activeVehicle, activeVehicleId: activeVehicle?.id || null,
      loading, loadError, version, refresh, reloadProfile, reloadVehicles, setActiveVehicle, updateProfile,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const useStore = () => useContext(Ctx);
