import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { storage } from "@/src/utils/storage";
import { api, setAuthProfileId, setAuthToken, getLocalProfileId } from "@/src/api";

const OAUTH_PENDING_KEY = "gigtax.oauth_pending";

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

  // Web comes back as a full page load, so the poll secret has to survive in
  // sessionStorage. The redirect URL itself never carries the session token.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(OAUTH_PENDING_KEY); } catch { raw = null; }
    if (!raw) return;
    let pending: { state?: string; poll_secret?: string } = {};
    try { pending = JSON.parse(raw); } catch { pending = {}; }
    if (!pending.state || !pending.poll_secret) return;
    let cancelled = false;
    setSigningIn(true);
    (async () => {
      try {
        for (let i = 0; i < 8 && !cancelled; i++) {
          const j = await api.pollGoogleAuth(pending.state!, pending.poll_secret!);
          if (j.status === "ready" && j.session_token) {
            try { sessionStorage.removeItem(OAUTH_PENDING_KEY); } catch { /* noop */ }
            await completeWithToken(j.session_token);
            try { window.history.replaceState({}, "", window.location.pathname); } catch { /* noop */ }
            return;
          }
          if (j.status === "invalid") {
            try { sessionStorage.removeItem(OAUTH_PENDING_KEY); } catch { /* noop */ }
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        console.log("auth complete failed", e);
      } finally {
        if (!cancelled) setSigningIn(false);
      }
    })();
    return () => { cancelled = true; };
  }, [completeWithToken]);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    try {
      // Force the app's own scheme on native. A dev-client https URL is not on
      // the backend allowlist. Web uses the page origin, which must be listed
      // in the server's OAUTH_REDIRECT_ORIGINS.
      const redirect = Platform.OS === "web"
        ? window.location.origin + "/"
        : Linking.createURL("/", { scheme: "driversgigtax" });
      const started = await api.startGoogleAuth({ app_redirect: redirect });
      if (Platform.OS === "web") {
        try { sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify({ state: started.state, poll_secret: started.poll_secret })); } catch { /* noop */ }
        window.location.href = started.auth_url;
        return;
      }

      let done = false;
      const finishToken = async (tok: string | null) => {
        if (done || !tok) return;
        done = true;
        await completeWithToken(tok);
      };
      const poll = (async () => {
        for (let i = 0; i < 80 && !done; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          if (done) return;
          try {
            const j = await api.pollGoogleAuth(started.state, started.poll_secret);
            if (j.status === "ready" && j.session_token) { await finishToken(j.session_token); return; }
            if (j.status === "invalid") return;
          } catch { /* keep polling */ }
        }
      })();

      const result = await WebBrowser.openAuthSessionAsync(started.auth_url, redirect);
      if (result.type === "cancel") done = true;
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
      const secret = process.env.EXPO_PUBLIC_DEMO_REVIEW_SECRET || "";
      const r = await fetch(`${BACKEND}/api/auth/demo`, {
        method: "POST",
        headers: secret ? { "X-Demo-Review-Secret": secret } : {},
      });
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
