import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { api, ProfileT } from "@/src/api";

interface Store {
  profile: ProfileT | null;
  loading: boolean;
  version: number; // bump to force data reload across screens
  refresh: () => void;
  reloadProfile: () => Promise<void>;
  updateProfile: (patch: Partial<ProfileT>) => Promise<ProfileT | null>;
}

const Ctx = createContext<Store>({
  profile: null,
  loading: true,
  version: 0,
  refresh: () => {},
  reloadProfile: async () => {},
  updateProfile: async () => null,
});

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<ProfileT | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);

  const reloadProfile = useCallback(async () => {
    try {
      const p = await api.getProfile();
      if (mounted.current) setProfile(p);
    } catch (e) {
      console.log("profile load error", e);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    reloadProfile();
    return () => { mounted.current = false; };
  }, [reloadProfile]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const updateProfile = useCallback(async (patch: Partial<ProfileT>) => {
    const p = await api.saveProfile(patch);
    setProfile(p);
    setVersion((v) => v + 1);
    return p;
  }, []);

  return (
    <Ctx.Provider value={{ profile, loading, version, refresh, reloadProfile, updateProfile }}>
      {children}
    </Ctx.Provider>
  );
}

export const useStore = () => useContext(Ctx);
