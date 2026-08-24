import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { storage } from "@/src/utils/storage";
import { api, setAuthProfileId, setAuthToken, getLocalProfileId } from "@/src/api";

// Finalise any pending auth session (native browser dismissal handling).
WebBrowser.maybeCompleteAuthSession();

const TOKEN_KEY = "gigtax.session_token";
const USER_KEY = "gigtax.user";
const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL;

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

function parseToken(url: string): string | null {
  if (!url) return null;
  const frag = url.split("#")[1] || "";
  const q = url.split("?")[1]?.split("#")[0] || "";
  for (const part of [frag, q]) {
    const m = new URLSearchParams(part).get("session_token");
    if (m) return m;
  }
  return null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const sentIds = useRef<Set<string>>(new Set());

  const applySession = useCallback(async (token: string, u: AuthUser) => {
    setAuthToken(token);
    setAuthProfileId(u.user_id);
    await storage.secureSet(TOKEN_KEY, token);
    await storage.setItem(USER_KEY, JSON.stringify(u));
    setUser(u);
  }, []);

  const completeWithToken = useCallback(async (token: string) => {
    // Guard: a re-mount, hot deep link and the auth-session result can all
    // surface the same token — only apply it once.
    if (!token || sentIds.current.has(token)) return;
    sentIds.current.add(token);
    setAuthToken(token);
    const me = await api.authMe();
    await applySession(token, me.user);
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

  // Native: handle cold-start deep link + hot links (Android Custom Tabs often
  // returns `dismiss` with no URL, so these sources are co-equal, not fallbacks).
  useEffect(() => {
    if (Platform.OS === "web") return;
    let active = true;
    const tryUrl = (url?: string | null) => {
      const tok = url ? parseToken(url) : null;
      if (!tok || !active) return;
      setSigningIn(true);
      completeWithToken(tok)
        .catch((e) => console.log("auth complete failed", e))
        .finally(() => { if (active) setSigningIn(false); });
    };
    Linking.getInitialURL().then(tryUrl);
    const sub = Linking.addEventListener("url", ({ url }) => tryUrl(url));
    return () => { active = false; sub.remove(); };
  }, [completeWithToken]);

  // Web: handle redirect back with #session_token
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const url = window.location.href;
    const tok = parseToken(url);
    if (tok) {
      setSigningIn(true);
      completeWithToken(tok)
        .catch((e) => console.log("auth complete failed", e))
        .finally(() => {
          setSigningIn(false);
          try { window.history.replaceState({}, "", window.location.pathname); } catch { /* noop */ }
        });
    }
  }, [completeWithToken]);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    try {
      if (Platform.OS === "web") {
        const redirect = window.location.origin + "/";
        window.location.href = `${BACKEND}/api/auth/google/start?app_redirect=${encodeURIComponent(redirect)}`;
        return; // browser navigates away
      }
      const redirect = Linking.createURL("/");
      const authUrl = `${BACKEND}/api/auth/google/start?app_redirect=${encodeURIComponent(redirect)}`;
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirect);
      if (result.type === "success" && result.url) {
        const tok = parseToken(result.url);
        if (tok) await completeWithToken(tok);
      }
    } catch (e) {
      console.log("signIn error", e);
    } finally {
      setSigningIn(false);
    }
  }, [completeWithToken]);

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
