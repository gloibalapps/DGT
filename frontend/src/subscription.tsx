import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Platform } from "react-native";
import { storage } from "@/src/utils/storage";
import { useAuth } from "@/src/auth";
import { api, setPaywallListener, SubscriptionStatus } from "@/src/api";

// Standard RevenueCat identifiers — must match the dashboard config.
// The server checks the SAME id (RC_ENTITLEMENT_ID, default "pro").
const ENTITLEMENT = process.env.EXPO_PUBLIC_RC_ENTITLEMENT_ID || "pro";
const CACHE_KEY = "gigtax.sub_active";

// TEMP: master switch to PAUSE RevenueCat entirely while testing the APK.
// The Test Store key (test_...) makes the RevenueCat SDK force-close a RELEASE
// build with a "Wrong API Key" dialog. While false, the SDK is never loaded or
// configured. Set to `true` (and add a real appl_/goog_ key) to re-enable.
const RC_ENABLED = false;

// Load the native SDK lazily so the web / Expo Go bundles don't break.
// Only require it when keys are configured (i.e. a real native build) — in
// preview / Expo Go the keys are empty and we never touch the native module.
// TEST_KEY is RevenueCat's Test Store key (test_...) usable on both platforms
// for dev builds; real appl_/goog_ keys take precedence when present.
const TEST_KEY = process.env.EXPO_PUBLIC_RC_TEST_KEY || "";
const IOS_KEY = process.env.EXPO_PUBLIC_RC_IOS_KEY || TEST_KEY;
const ANDROID_KEY = process.env.EXPO_PUBLIC_RC_ANDROID_KEY || TEST_KEY;

let Purchases: any = null;
if (RC_ENABLED && Platform.OS !== "web" && (IOS_KEY || ANDROID_KEY)) {
  try { Purchases = require("react-native-purchases").default; } catch { Purchases = null; }
}

// The native Paywall / Customer Center UI lives in a separate module. Load it
// lazily (native only) so the web / Expo Go bundles never touch native code.
function loadRCUI(): any {
  if (Platform.OS === "web" || !Purchases) return null;
  try {
    const mod = require("react-native-purchases-ui");
    return mod?.default ? mod : { default: mod };
  } catch { return null; }
}

export interface Plan {
  id: string;
  title: string;        // "Monthly" | "Yearly"
  price: string;        // localized store price string
  period: "month" | "year";
  trial: boolean;       // has an eligible intro/free-trial offer
  pkg: any;             // RevenueCat PurchasesPackage
}

interface SubCtx {
  loading: boolean;
  isActive: boolean;    // has the entitlement (real, from the store)
  managed: boolean;     // RevenueCat is actually running (real gate is enforced)
  plans: Plan[];
  buy: (pkg: any) => Promise<boolean>;
  restore: () => Promise<boolean>;
  refresh: () => Promise<void>;
  presentPaywall: () => Promise<boolean>;        // native RevenueCat remote paywall
  presentCustomerCenter: () => Promise<void>;    // native RevenueCat Customer Center
  // Server-side trial / entitlement (authoritative; see backend/subscription.py)
  server: SubscriptionStatus | null;
  expired: boolean;     // server enforces the paywall AND trial is over with no subscription
  refreshServer: (force?: boolean) => Promise<void>;
  paywallHit: number;   // bumps whenever a write got 402 (UI can react)
}

const Ctx = createContext<SubCtx>({
  loading: true, isActive: false, managed: false, plans: [],
  buy: async () => false, restore: async () => false, refresh: async () => {},
  presentPaywall: async () => false, presentCustomerCenter: async () => {},
  server: null, expired: false, refreshServer: async () => {}, paywallHit: 0,
});

function mapPackage(p: any): Plan {
  const prod = p?.product ?? {};
  const yearly =
    /year|annual/i.test(p?.identifier || "") ||
    /year|annual/i.test(p?.packageType || "") ||
    prod?.subscriptionPeriod === "P1Y";
  // Intro/free-trial eligibility varies by store; treat any intro offer as a trial.
  const trial = Boolean(
    prod?.introPrice ||
    (prod?.defaultOption && (prod.defaultOption.freePhase || prod.defaultOption.introPhase))
  );
  return {
    id: p?.identifier || (yearly ? "yearly" : "monthly"),
    title: yearly ? "Yearly" : "Monthly",
    price: prod?.priceString || "",
    period: yearly ? "year" : "month",
    trial,
    pkg: p,
  };
}

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [isActive, setIsActive] = useState(false);
  const [managed, setManaged] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [server, setServer] = useState<SubscriptionStatus | null>(null);
  const [paywallHit, setPaywallHit] = useState(0);

  // Server status works whether or not RevenueCat (the SDK) is paused: the trial
  // clock and enforcement live on the server, keyed by user_id.
  const refreshServer = useCallback(async (force = false) => {
    if (!user?.user_id) { setServer(null); return; }
    try { setServer(await api.subscriptionStatus(force)); } catch { /* offline: keep last */ }
  }, [user?.user_id]);

  useEffect(() => { refreshServer(); }, [refreshServer]);

  useEffect(() => {
    setPaywallListener(() => { setPaywallHit((n) => n + 1); refreshServer(true); });
    return () => setPaywallListener(null);
  }, [refreshServer]);

  const apply = useCallback(async (info: any) => {
    const val = Boolean(info?.entitlements?.active?.[ENTITLEMENT]?.isActive);
    setIsActive(val);
    await storage.setItem(CACHE_KEY, val);
    // A purchase/restore/renewal just happened (or app start): make the server
    // re-verify with RevenueCat now instead of waiting for its cache TTL.
    refreshServer(true);
    return val;
  }, [refreshServer]);

  const refresh = useCallback(async () => {
    if (!managed || !Purchases) return;
    try { await apply(await Purchases.getCustomerInfo()); } catch { /* offline */ }
  }, [managed, apply]);

  useEffect(() => {
    let sub: any;
    (async () => {
      const key = Platform.OS === "ios" ? IOS_KEY : ANDROID_KEY;
      // Unmanaged: web preview, Expo Go, or keys not configured yet.
      // We don't hard-lock the app in these environments — the gate only
      // enforces when RevenueCat is truly running (`managed`).
      if (!Purchases || !key) {
        const cached = await storage.getItem<boolean>(CACHE_KEY, false);
        setIsActive(Boolean(cached));
        setManaged(false);
        setLoading(false);
        return;
      }
      try {
        Purchases.configure({ apiKey: key, appUserID: user?.user_id || undefined });
        setManaged(true);
        sub = Purchases.addCustomerInfoUpdateListener((info: any) => { apply(info); });
        try {
          const offerings = await Purchases.getOfferings();
          const pkgs = offerings?.current?.availablePackages ?? [];
          setPlans(pkgs.map(mapPackage));
        } catch (e) { console.log("[sub] offerings failed", e); }
        await apply(await Purchases.getCustomerInfo());
      } catch (e) {
        // SDK failed to boot (e.g. Expo Go) — run unmanaged, never lock out.
        console.log("[sub] RevenueCat init failed, running unmanaged", e);
        setManaged(false);
      } finally {
        setLoading(false);
      }
    })();
    return () => { try { sub?.remove(); } catch { /* noop */ } };
  }, [user?.user_id, apply]);

  const buy = useCallback(async (pkg: any) => {
    if (!Purchases) return false;
    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      return await apply(customerInfo);
    } catch (e: any) {
      if (!e?.userCancelled) console.log("[sub] purchase failed", e);
      return false;
    }
  }, [apply]);

  const restore = useCallback(async () => {
    if (!Purchases) return false;
    try { return await apply(await Purchases.restorePurchases()); }
    catch (e) { console.log("[sub] restore failed", e); return false; }
  }, [apply]);

  // Present RevenueCat's remote-configured native paywall (Offering must be set
  // up in the dashboard). Returns true if the user purchased or restored.
  const presentPaywall = useCallback(async () => {
    if (!Purchases) return false;
    const RCUI = loadRCUI();
    if (!RCUI) return false;
    try {
      const result = await RCUI.default.presentPaywall();
      const R = RCUI.PAYWALL_RESULT || {};
      const ok = result === R.PURCHASED || result === R.RESTORED;
      if (ok) await apply(await Purchases.getCustomerInfo());
      return ok;
    } catch (e) { console.log("[sub] presentPaywall failed", e); return false; }
  }, [apply]);

  // Present RevenueCat's Customer Center (manage / cancel / restore / refund).
  const presentCustomerCenter = useCallback(async () => {
    if (!Purchases) return;
    const RCUI = loadRCUI();
    if (!RCUI) return;
    try {
      await RCUI.default.presentCustomerCenter();
      await apply(await Purchases.getCustomerInfo());
    } catch (e) { console.log("[sub] customerCenter failed", e); }
  }, [apply]);

  return (
    <Ctx.Provider value={{ loading, isActive, managed, plans, buy, restore, refresh, presentPaywall, presentCustomerCenter,
      server, expired: Boolean(server?.enforced && server.state === "expired"), refreshServer, paywallHit }}>
      {children}
    </Ctx.Provider>
  );
}

export const useSubscription = () => useContext(Ctx);
