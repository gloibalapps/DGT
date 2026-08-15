import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { storage } from "@/src/utils/storage";
import { api, setAuthProfileId, setAuthToken, getLocalProfileId } from "@/src/api";

const TOKEN_KEY = "gigtax.session_token";
const USER_KEY = "gigtax.user";
const AUTH_BASE = "https://auth.emergentagent.com";

export interface AuthUser { user_id: string; email: string; name?: string | null; picture?: string | null; }

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  signingIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  user: null, loading: true, signingIn: false,
  signIn: async () => {}, signOut: async () => {},
});

function parseSessionId(url: string): string | null {
  if (!url) return null;
  const frag = url.split("#")[1] || "";
  const q = url.split("?")[1]?.split("#")[0] || "";
  for (const part of [frag, q]) {
    const m = new URLSearchParams(part).get("session_id");
    if (m) return m;
  }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);

  const applySession = useCallback(async (token: string, u: AuthUser) => {
    setAuthToken(token);
    setAuthProfileId(u.user_id);
    await storage.secureSet(TOKEN_KEY, token);
    await storage.setItem(USER_KEY, JSON.stringify(u));
    setUser(u);
  }, []);

  const completeWithSessionId = useCallback(async (sessionId: string) => {
    const res = await api.authSession(sessionId);
    await applySession(res.session_token, res.user);
    // one-time: move this device's local data onto the account
    try {
      const localPid = await getLocalProfileId();
      await api.authClaim(localPid);
    } catch { /* non-blocking */ }
  }, [applySession]);

  // Restore an existing session on launch
  useEffect(() => {
    (async () => {
      try {
        const token = await storage.secureGet<string>(TOKEN_KEY, "");
        const rawUser = await storage.getItem<string>(USER_KEY, "");
        if (token) {
          setAuthToken(token);
          if (rawUser) {
            const u = JSON.parse(rawUser) as AuthUser;
            setAuthProfileId(u.user_id);
            setUser(u);
          }
          try {
            const me = await api.authMe();
            setAuthProfileId(me.user.user_id);
            setUser(me.user);
            await storage.setItem(USER_KEY, JSON.stringify(me.user));
          } catch {
            // token invalid/expired -> clear
            await storage.secureRemove(TOKEN_KEY);
            await storage.removeItem(USER_KEY);
            setAuthToken(null); setAuthProfileId(null); setUser(null);
          }
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Web: handle redirect back with #session_id
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const url = window.location.href;
    const sid = parseSessionId(url);
    if (sid) {
      setSigningIn(true);
      completeWithSessionId(sid)
        .catch((e) => console.log("auth complete failed", e))
        .finally(() => {
          setSigningIn(false);
          try { window.history.replaceState({}, "", window.location.pathname); } catch { /* noop */ }
        });
    }
  }, [completeWithSessionId]);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    try {
      if (Platform.OS === "web") {
        const redirect = window.location.origin + "/";
        window.location.href = `${AUTH_BASE}/?redirect=${encodeURIComponent(redirect)}`;
        return; // browser navigates away
      }
      const redirect = Linking.createURL("/");
      const authUrl = `${AUTH_BASE}/?redirect=${encodeURIComponent(redirect)}`;
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirect);
      if (result.type === "success" && result.url) {
        const sid = parseSessionId(result.url);
        if (sid) await completeWithSessionId(sid);
      }
    } catch (e) {
      console.log("signIn error", e);
    } finally {
      setSigningIn(false);
    }
  }, [completeWithSessionId]);

  const signOut = useCallback(async () => {
    try { await api.authLogout(); } catch { /* noop */ }
    await storage.secureRemove(TOKEN_KEY);
    await storage.removeItem(USER_KEY);
    setAuthToken(null);
    setAuthProfileId(null);
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, signingIn, signIn, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
