import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Platform } from "react-native";
import { storage } from "@/src/utils/storage";
import { useAuth } from "@/src/auth";

// Standard RevenueCat identifiers — must match the dashboard config.
const ENTITLEMENT = "pro_access";
const CACHE_KEY = "gigtax.sub_active";

// Load the native SDK lazily so the web / Expo Go bundles don't break.
// Only require it when keys are configured (i.e. a real native build) — in
// preview / Expo Go the keys are empty and we never touch the native module.
const IOS_KEY = process.env.EXPO_PUBLIC_RC_IOS_KEY || "";
const ANDROID_KEY = process.env.EXPO_PUBLIC_RC_ANDROID_KEY || "";

let Purchases: any = null;
if (Platform.OS !== "web" && (IOS_KEY || ANDROID_KEY)) {
  try { Purchases = require("react-native-purchases").default; } catch { Purchases = null; }
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
  isActive: boolean;    // has the pro_access entitlement (real, from the store)
  managed: boolean;     // RevenueCat is actually running (real gate is enforced)
  plans: Plan[];
  buy: (pkg: any) => Promise<boolean>;
  restore: () => Promise<boolean>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SubCtx>({
  loading: true, isActive: false, managed: false, plans: [],
  buy: async () => false, restore: async () => false, refresh: async () => {},
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

  const apply = useCallback(async (info: any) => {
    const val = Boolean(info?.entitlements?.active?.[ENTITLEMENT]?.isActive);
    setIsActive(val);
    await storage.setItem(CACHE_KEY, val);
    return val;
  }, []);

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

  return (
    <Ctx.Provider value={{ loading, isActive, managed, plans, buy, restore, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export const useSubscription = () => useContext(Ctx);
