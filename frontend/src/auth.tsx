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

export interface AuthUser { user_id: string; email: string; name?: string | null; picture?: string | null; is_demo?: boolean; }

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  signingIn: boolean;
  signIn: () => Promise<void>;
  signInApple: () => Promise<void>;
  signInDemo: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  user: null, loading: true, signingIn: false,
  signIn: async () => {}, signInApple: async () => {}, signInDemo: async () => {}, signOut: async () => {},
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
    // surface the same token — only process it once *at a time*. But if the
    // attempt fails (transient network / API hiccup), release the guard so a
    // later duplicate deep-link event can retry instead of being swallowed
    // (which would leave the user stuck logged-out on Android).
    if (!token || sentIds.current.has(token)) return;
    sentIds.current.add(token);
    try {
      setAuthToken(token);
      // Right after returning from the Google browser (esp. on Android) the
      // first request can fail while the app is still resuming — retry a few
      // times so a single transient hiccup doesn't leave the user logged out.
      let me; let lastErr;
      for (let i = 0; i < 4; i++) {
        try { me = await api.authMe(); break; }
        catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 700)); }
      }
      if (!me) throw lastErr;
      await applySession(token, me.user);
      // one-time: move this device's local data onto the account (never into a
      // throwaway demo account — that data would be deleted with it)
      if (!me.user?.is_demo) try {
        const localPid = await getLocalProfileId();
        await api.authClaim(localPid);
      } catch { /* non-blocking */ }
    } catch (e) {
      sentIds.current.delete(token); // allow a retry from another source
      throw e;
    }
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
            // Fast open: trust the cached session immediately and validate it in
            // the background, instead of holding the splash on a network call.
            let u: AuthUser | null = null;
            try { u = (typeof rawUser === "string" ? JSON.parse(rawUser) : rawUser) as AuthUser; } catch { u = null; }
            if (u?.user_id) {
              setAuthProfileId(u.user_id);
              setUser(u);
              setLoading(false);
            }
          }
          try {
            const me = await api.authMe();
            setAuthProfileId(me.user.user_id);
            setUser(me.user);
            await storage.setItem(USER_KEY, JSON.stringify(me.user));
          } catch (e: any) {
            // Only a real 401 means the session is gone — never sign the driver
            // out just because they opened the app with weak/no signal.
            if (/^401/.test(e?.message || "") || !rawUser) {
              await storage.secureRemove(TOKEN_KEY);
              await storage.removeItem(USER_KEY);
              setAuthToken(null); setAuthProfileId(null); setUser(null);
            }
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
      // Force the app's OWN custom scheme (frontend://) as the return address.
      // Plain Linking.createURL("/") resolves to the https dev/preview URL in
      // non-standalone builds, so Google sends the token to a web page in the
      // browser instead of back into the native app (user stays logged out).
      const redirect = Linking.createURL("/", { scheme: "frontend" });
      // A client-generated state lets us POLL the backend for the sign-in result.
      // This is the reliable path on Android, where the deep-link payload that
      // carries the token is frequently dropped on the way back into the app.
      const state = `${Date.now().toString(16)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      const authUrl = `${BACKEND}/api/auth/google/start?state=${state}&app_redirect=${encodeURIComponent(redirect)}`;

      let done = false;
      const finishToken = async (tok: string | null) => {
        if (done || !tok) return;
        done = true;
        await completeWithToken(tok);
      };

      // Poll for the result in parallel with the browser session.
      const poll = (async () => {
        for (let i = 0; i < 80 && !done; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          if (done) return;
          try {
            const r = await fetch(`${BACKEND}/api/auth/google/poll?state=${state}`);
            const j = await r.json();
            if (j.status === "ready" && j.session_token) { await finishToken(j.session_token); return; }
            if (j.status === "expired" && i > 3) return;
          } catch { /* keep polling */ }
        }
      })();

      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirect);
      // Fast path: token came straight back through the deep link.
      if (result.type === "success" && result.url) {
        const tok = parseToken(result.url);
        if (tok) await finishToken(tok);
      } else if (result.type === "cancel") {
        done = true; // user backed out — stop polling
      }
      await poll;
    } catch (e) {
      console.log("signIn error", e);
    } finally {
      setSigningIn(false);
    }
  }, [completeWithToken]);

  // iOS: native Sign in with Apple → backend verifies the identity token.
  const signInApple = useCallback(async () => {
    const AppleAuthentication = await import("expo-apple-authentication");
    setSigningIn(true);
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!cred.identityToken) throw new Error("No identity token from Apple");
      const fullName = [cred.fullName?.givenName, cred.fullName?.familyName].filter(Boolean).join(" ");
      const r = await fetch(`${BACKEND}/api/auth/apple`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity_token: cred.identityToken, full_name: fullName || null, email: cred.email || null }),
      });
      if (!r.ok) throw new Error(`Apple sign-in failed (${r.status})`);
      const j = await r.json();
      await completeWithToken(j.session_token);
    } catch (e: any) {
      if (e?.code !== "ERR_REQUEST_CANCELED") throw e;
    } finally {
      setSigningIn(false);
    }
  }, [completeWithToken]);

  // Guest demo: a fresh sample account (no Google/Apple needed) — used by
  // App Store / Play reviewers and anyone who wants to look around first.
  const signInDemo = useCallback(async () => {
    setSigningIn(true);
    try {
      const r = await fetch(`${BACKEND}/api/auth/demo`, { method: "POST" });
      if (!r.ok) throw new Error(`Demo failed (${r.status})`);
      const j = await r.json();
      await completeWithToken(j.session_token);
    } finally {
      setSigningIn(false);
    }
  }, [completeWithToken]);

  const signOut = useCallback(async () => {
    try { await api.authLogout(); } catch { /* noop */ }
    await storage.secureRemove(TOKEN_KEY);
    await storage.removeItem(USER_KEY);
    await storage.removeItem("gigtax.cache.profile");
    await storage.removeItem("gigtax.cache.vehicles");
    setAuthToken(null);
    setAuthProfileId(null);
    setUser(null);
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, signingIn, signIn, signInApple, signInDemo, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
