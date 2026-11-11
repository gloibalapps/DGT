/**
 * Drivers Gig Tax API, ported from backend/server.py + subscription.py.
 * Same /api/* paths and the OAuth / demo / entitlement rules from PR #1.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Collection, Db, Doc } from "./db.ts";
import { kbFor } from "./tax_kb.ts";
import * as tax from "./tax.ts";
import * as ue from "./ue.ts";
import { HttpError, backupErrorText, backupProfile, decryptToken, restoreProfile, saveDriveTokens } from "./drive.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AppDeps {
  db: Db;
  fetch?: FetchLike;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

const buckets = new Map<string, number[]>();

export function resetRateLimits(): void {
  buckets.clear();
}

function envGet(deps: AppDeps, name: string): string {
  const from = deps.env ?? Deno.env.toObject();
  return from[name] ?? "";
}

function envBool(deps: AppDeps, name: string, fallback: boolean): boolean {
  const v = envGet(deps, name).trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function constEq(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(), ...extra },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, apikey, x-demo-review-secret",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  };
}

export function redirectAllowed(url: string, origins: Set<string>): boolean {
  if (!url || /[\r\n\0\\]/.test(url)) return false;
  let parts: URL;
  try {
    parts = new URL(url);
  } catch {
    return false;
  }
  if (parts.username || parts.password) return false;
  if (parts.protocol === "driversgigtax:") return true;
  if (parts.protocol !== "https:") return false;
  const port = parts.port && parts.port !== "443" ? `:${parts.port}` : "";
  return origins.has(`https://${parts.hostname}${port}`);
}

function origins(deps: AppDeps): Set<string> {
  return new Set(envGet(deps, "OAUTH_REDIRECT_ORIGINS").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean));
}

async function rateLimit(deps: AppDeps, key: string, limit: number, windowMs = 60_000): Promise<boolean> {
  return await deps.db.hitRate(key, limit, windowMs);
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return "unknown";
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  return h.slice(7).trim() || null;
}

function nowIso(deps: AppDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function id(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

interface Owner {
  user: Doc;
  profileId: string;
}

async function currentUser(deps: AppDeps, req: Request): Promise<Owner | Response> {
  const token = bearer(req);
  if (!token) return json({ detail: "Not authenticated" }, 401);
  const sess = await deps.db.user_sessions.findOne({ session_token: token });
  if (!sess) return json({ detail: "Invalid session" }, 401);
  const exp = Date.parse(String(sess.expires_at ?? ""));
  if (!Number.isNaN(exp) && exp < (deps.now ?? (() => new Date()))().getTime()) {
    return json({ detail: "Session expired" }, 401);
  }
  const user = await deps.db.users.findOne({ user_id: sess.user_id });
  if (!user) return json({ detail: "User not found" }, 401);
  return { user, profileId: String(user.user_id) };
}

function isOwner(v: Owner | Response): v is Owner {
  return !(v instanceof Response);
}

function checkPid(owner: Owner, supplied: unknown): Response | null {
  if (supplied != null && supplied !== "" && supplied !== owner.profileId) {
    return json({ detail: "Not your profile" }, 403);
  }
  return null;
}

async function requireEntitled(deps: AppDeps, owner: Owner): Promise<Response | null> {
  if (!envBool(deps, "PAYWALL_ENFORCED", false)) return null;
  const st = await subscriptionStatus(deps, owner.user, false);
  if (st.state === "expired") {
    return json({
      detail: {
        code: "subscription_required",
        message: "Your 14-day free trial has ended. Subscribe to keep adding records. You can still view, export and back up your data, or delete your account.",
        trial_ends_at: st.trial_ends_at,
      },
    }, 402);
  }
  return null;
}

function trialDays(deps: AppDeps): number {
  return Number(envGet(deps, "TRIAL_DAYS") || "14");
}

function newTrial(deps: AppDeps): Doc {
  const start = (deps.now ?? (() => new Date()))();
  const end = new Date(start.getTime() + trialDays(deps) * 86400000);
  return { trial_started_at: start.toISOString(), trial_ends_at: end.toISOString(), sub_status: "trial" };
}

async function subscriptionStatus(deps: AppDeps, user: Doc, force: boolean): Promise<Doc> {
  const now = deps.now ?? (() => new Date());
  const nowD = now();
  if (user.is_demo && envBool(deps, "DEMO_ENTITLED", false)) {
    return { state: "active", entitlement: "demo", trial_ends_at: user.trial_ends_at ?? null, days_left: null, is_demo: true, enforced: envBool(deps, "PAYWALL_ENFORCED", false), trial_days: trialDays(deps) };
  }
  let u = user;
  if (!u.trial_started_at) {
    const fields = newTrial(deps);
    await deps.db.users.updateOne({ user_id: u.user_id }, { $set: fields });
    u = { ...u, ...fields };
  }
  const ends = Date.parse(String(u.trial_ends_at));
  const inTrial = nowD.getTime() < ends;
  const daysLeft = Math.max(0, Math.ceil((ends - nowD.getTime()) / 86400000));
  const state = inTrial ? "trial" : "expired";
  return {
    state, entitlement: null, trial_started_at: u.trial_started_at, trial_ends_at: u.trial_ends_at,
    days_left: state === "trial" ? daysLeft : 0, expires_at: null, is_demo: Boolean(u.is_demo),
    enforced: envBool(deps, "PAYWALL_ENFORCED", false), trial_days: trialDays(deps),
    force,
  };
}

async function newSession(deps: AppDeps, userId: string, hours = 24 * 7): Promise<string> {
  const token = id();
  const start = deps.now ?? (() => new Date());
  const exp = new Date(start().getTime() + hours * 3600000);
  await deps.db.user_sessions.insertOne({
    session_token: token, user_id: userId, created_at: start().toISOString(), expires_at: exp.toISOString(),
  });
  return token;
}

function apiPath(url: URL): string {
  const marker = "/functions/v1/api";
  const path = url.pathname.startsWith(marker) ? url.pathname.slice(marker.length) : url.pathname;
  return path || "/";
}

export async function handle(req: Request, deps: AppDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  const url = new URL(req.url);
  const path = apiPath(url);
  const method = req.method.toUpperCase();
  try {
    return await route(method, path, url, req, deps);
  } catch (e) {
    console.error(e);
    return json({ detail: "Internal error" }, 500);
  }
}

async function route(method: string, path: string, url: URL, req: Request, deps: AppDeps): Promise<Response> {
  if (method === "GET" && (path === "/health" || path === "/")) return json({ status: "ok" });
  if (method === "GET" && path === "/api/") return json({ message: "GigTax API", market: "AU" });
  if (method === "GET" && path === "/api/auth/google/start") return json({ detail: "Method Not Allowed" }, 405);
  if (method === "POST" && path === "/api/auth/google/start") return await googleStart(req, deps);
  if (method === "GET" && path === "/api/auth/google/callback") return await googleCallback(url, deps);
  if (method === "POST" && path === "/api/auth/google/poll") return await googlePoll(req, deps);
  if (method === "POST" && path === "/api/auth/demo") return await demo(req, deps);
  if (method === "POST" && path === "/api/auth/apple") return await appleSignIn(req, deps);
  if (method === "GET" && path === "/api/auth/me") return await authMe(req, deps);
  if (method === "POST" && path === "/api/auth/logout") return await logout(req, deps);
  if (method === "POST" && path === "/api/auth/ticket") return await authTicket(req, deps);
  if (method === "POST" && path === "/api/auth/claim") return await authClaim(req, deps);
  if (method === "DELETE" && path === "/api/account") return await deleteAccount(req, deps);
  if (method === "GET" && path === "/api/subscription/status") return await subStatus(req, url, deps);
  if (method === "POST" && path === "/api/subscription/webhook") return await webhook(req, deps);
  if (method === "POST" && path === "/api/ask") return await ask(req, deps);
  if (method === "POST" && path === "/api/receipts/scan") return await scan(req, deps);
  if (method === "GET" && path === "/api/profile") return await getProfile(req, deps);
  if (method === "PUT" && path === "/api/profile") return await saveProfile(req, deps);
  if (path.startsWith("/api/reports") || path.startsWith("/api/dashboard") || path === "/api/money" ||
      path === "/api/insights" || path === "/api/performance" || path === "/api/tax-mileage" ||
      path === "/api/export" || path === "/api/export-mileage") {
    return await calcRoute(method, path, url, req, deps);
  }
  if (path.startsWith("/api/ue/")) return await ueRoute(method, path, url, req, deps);
  if (path.startsWith("/api/backups")) return await backupRoute(method, path, req, deps);
  const activate = path.match(/^\/api\/vehicles\/([^/]+)\/activate$/);
  if (activate && method === "POST") return await activateVehicle(activate[1], req, deps);
  const crud = path.match(/^\/api\/(trips|income|expenses|shifts|vehicles)(?:\/([^/]+))?$/);
  if (crud) return await resource(method, crud[1], crud[2], req, deps);
  if (method === "POST" && path === "/api/waitlist") return await waitlist(req, deps);
  return json({ detail: "Not found" }, 404);
}

async function readJson(req: Request): Promise<Doc> {
  if (req.headers.get("content-length") === "0") return {};
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function googleStart(req: Request, deps: AppDeps): Promise<Response> {
  const body = await readJson(req);
  const appRedirect = String(body.app_redirect ?? "");
  if (!redirectAllowed(appRedirect, origins(deps))) return json({ detail: "Invalid redirect" }, 400);
  let profileId: string | null = null;
  if (body.backup) {
    const owner = await ownerOrTicket(req, deps);
    if (!isOwner(owner)) return owner;
    profileId = owner.profileId;
  }
  if (!envGet(deps, "GOOGLE_CLIENT_ID")) return json({ detail: "Google login not configured" }, 500);
  const state = crypto.randomUUID() + crypto.randomUUID();
  const pollSecret = crypto.randomUUID() + crypto.randomUUID();
  await deps.db.oauth_states.insertOne({
    state, app_redirect: appRedirect, poll_secret: pollSecret,
    backup: Boolean(body.backup), profile_id: profileId, created_at: nowIso(deps),
  });
  const redirectUri = `${publicBase(req)}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: envGet(deps, "GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: body.backup ? "openid email profile https://www.googleapis.com/auth/drive.file" : "openid email profile",
    state,
    prompt: body.backup ? "consent" : "select_account",
  });
  if (body.backup) {
    params.set("access_type", "offline");
    params.set("include_granted_scopes", "true");
  }
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  if (authUrl.includes(pollSecret)) throw new Error("poll secret leaked into auth url");
  return json({ auth_url: authUrl, state, poll_secret: pollSecret });
}

function publicBase(req: Request): string {
  const url = new URL(req.url);
  const marker = "/functions/v1/api";
  const path = url.pathname.startsWith(marker) ? marker : "";
  return `${url.origin}${path}`;
}

async function googleCallback(url: URL, deps: AppDeps): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const st = state ? await deps.db.oauth_states.findOne({ state }) : null;
  const appRedirect = String(st?.app_redirect ?? "");
  if (!redirectAllowed(appRedirect, origins(deps))) return json({ detail: "Invalid redirect" }, 400);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code || !st) return bounce(appRedirect, "auth_error=1");
  const fetcher = deps.fetch ?? fetch;
  const redirectUri = redirectUriOf(url);
  const tok = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: envGet(deps, "GOOGLE_CLIENT_ID"), client_secret: envGet(deps, "GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  if (!tok.ok) return bounce(appRedirect, "auth_error=token");
  const tokJson = await tok.json();
  const ui = await fetcher("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${tokJson.access_token}` },
  });
  if (!ui.ok) return bounce(appRedirect, "auth_error=userinfo");
  const info = await ui.json();
  if (!info.email) return bounce(appRedirect, "auth_error=noemail");
  if (st.backup && st.profile_id) {
    await saveDriveTokens(deps.db, envGet(deps, "DRIVE_ENCRYPTION_KEY"), String(st.profile_id), tokJson, String(info.email), nowIso(deps));
    await deps.db.oauth_states.deleteOne({ state });
    return bounce(appRedirect, "drive_connected=1");
  }
  const existing = await deps.db.users.findOne({ email: info.email });
  const userId = existing ? String(existing.user_id) : `user_${id().slice(0, 12)}`;
  if (!existing) {
    await deps.db.users.insertOne({
      user_id: userId, email: info.email, name: info.name ?? null, picture: info.picture ?? null,
      created_at: nowIso(deps), ...newTrial(deps),
    });
  }
  const token = await newSession(deps, userId);
  await deps.db.oauth_states.updateOne({ state }, { $set: { session_token: token, ready_at: nowIso(deps) } });
  return bounce(appRedirect, "signed_in=1");
}

function redirectUriOf(url: URL): string {
  const marker = "/functions/v1/api";
  const basePath = url.pathname.startsWith(marker) ? marker : "";
  return `${url.origin}${basePath}/api/auth/google/callback`;
}

function bounce(appRedirect: string, fragment: string): Response {
  if (appRedirect.startsWith("https://")) {
    const loc = `${appRedirect}#${fragment}`;
    return new Response(null, { status: 302, headers: { location: loc, ...corsHeaders() } });
  }
  const sep = appRedirect.includes("?") ? "&" : "?";
  const loc = `${appRedirect}${sep}${fragment}`;
  return new Response(null, { status: 302, headers: { location: loc, ...corsHeaders() } });
}

async function googlePoll(req: Request, deps: AppDeps): Promise<Response> {
  const body = await readJson(req);
  const state = String(body.state ?? "");
  const secret = String(body.poll_secret ?? "");
  const doc = state ? await deps.db.oauth_states.findOne({ state }) : null;
  const expected = String(doc?.poll_secret ?? "");
  if (!doc || !constEq(secret, expected)) return json({ detail: "Invalid poll" }, 401);
  const token = doc.session_token ? String(doc.session_token) : "";
  if (!token) return json({ status: "pending" });
  await deps.db.oauth_states.deleteOne({ state });
  return json({ status: "ready", session_token: token });
}

async function demo(req: Request, deps: AppDeps): Promise<Response> {
  const limit = Number(envGet(deps, "DEMO_RATE_LIMIT") || "5");
  if (await rateLimit(deps, `demo:${clientIp(req)}`, limit)) return json({ detail: "Too many requests" }, 429);
  if (!envBool(deps, "DEMO_ENABLED", false)) return json({ detail: "Not found" }, 404);
  const provided = req.headers.get("x-demo-review-secret") ?? "";
  if (!constEq(provided, envGet(deps, "DEMO_REVIEW_SECRET"))) return json({ detail: "Demo access denied" }, 401);
  const uid = `demo_${id().slice(0, 12)}`;
  await deps.db.users.insertOne({
    user_id: uid, email: `${uid}@demo.driversgigtax.app`, name: "Demo Driver", is_demo: true,
    created_at: nowIso(deps), ...newTrial(deps),
  });
  const token = await newSession(deps, uid, 24);
  return json({ session_token: token, user_id: uid });
}

const appleJwks = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

async function appleSignIn(req: Request, deps: AppDeps): Promise<Response> {
  const body = await readJson(req);
  const token = String(body.identity_token ?? "");
  if (!token) return json({ detail: "identity_token required" }, 400);
  const audiences = envGet(deps, "APPLE_AUDIENCES").split(",").map((s) => s.trim()).filter(Boolean);
  if (!audiences.length) return json({ detail: "Apple sign-in not configured" }, 500);
  let sub = "";
  let email: string | null = null;
  try {
    const { payload } = await jwtVerify(token, appleJwks, { issuer: "https://appleid.apple.com", audience: audiences });
    sub = String(payload.sub);
    if (String(payload.email_verified ?? "").toLowerCase() === "true" && payload.email) email = String(payload.email);
  } catch {
    return json({ detail: "Invalid Apple sign-in" }, 401);
  }
  let user = await deps.db.users.findOne({ apple_sub: sub });
  if (!user && email) user = await deps.db.users.findOne({ email });
  const userId = user ? String(user.user_id) : `user_${id().slice(0, 12)}`;
  if (!user) {
    await deps.db.users.insertOne({
      user_id: userId, apple_sub: sub, email: email ?? `${sub}@appleid.private`,
      name: body.full_name ?? null, created_at: nowIso(deps), ...newTrial(deps),
    });
  } else if (!user.apple_sub) {
    await deps.db.users.updateOne({ user_id: userId }, { $set: { apple_sub: sub } });
  }
  return json({ session_token: await newSession(deps, userId), user_id: userId });
}

async function authMe(req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  return json({ user: owner.user });
}

async function logout(req: Request, deps: AppDeps): Promise<Response> {
  const token = bearer(req);
  if (token) await deps.db.user_sessions.deleteOne({ session_token: token });
  return json({ ok: true });
}

async function subStatus(req: Request, url: URL, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const force = url.searchParams.get("refresh") === "true";
  return json(await subscriptionStatus(deps, owner.user, force));
}

async function webhook(req: Request, deps: AppDeps): Promise<Response> {
  const expected = envGet(deps, "REVENUECAT_WEBHOOK_AUTH");
  if (!expected) return json({ detail: "Webhook not configured" }, 503);
  const auth = req.headers.get("authorization") ?? "";
  if (!constEq(auth, expected)) return json({ detail: "Bad webhook auth" }, 401);
  const body = await readJson(req);
  const ev = (body.event ?? {}) as Doc;
  const ids = [ev.app_user_id, ev.original_app_user_id, ...((ev.aliases as unknown[]) ?? [])].filter(Boolean);
  const typ = String(ev.type ?? "");
  const ents = (ev.entitlement_ids as string[]) ?? (ev.entitlement_id ? [String(ev.entitlement_id)] : []);
  const ent = envGet(deps, "RC_ENTITLEMENT_ID") || "pro";
  let upd: Doc = { sub_checked_at: null };
  if (["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "NON_RENEWING_PURCHASE", "SUBSCRIPTION_EXTENDED", "TEMPORARY_ENTITLEMENT_GRANT"].includes(typ) && ents.includes(ent)) {
    upd = { sub_status: "active", sub_product: ev.product_id ?? null, sub_checked_at: nowIso(deps) };
  } else if (typ === "EXPIRATION" && (!ents.length || ents.includes(ent))) {
    upd = { sub_status: "expired", sub_checked_at: nowIso(deps) };
  }
  let n = 0;
  for (const uid of ids) {
    const res = await deps.db.users.updateMany({ user_id: uid }, { $set: upd });
    n += res.modified_count;
  }
  return json({ ok: true, updated: n, type: typ });
}

async function ask(req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  if (owner.user.is_demo) return json({ detail: "Demo accounts can't use this feature" }, 403);
  const gate = await requireEntitled(deps, owner);
  if (gate) return gate;
  const limit = Number(envGet(deps, "AI_RATE_LIMIT") || "30");
  if (await rateLimit(deps, `ai:${owner.profileId}`, limit)) return json({ detail: "Too many requests" }, 429);
  const key = envGet(deps, "ANTHROPIC_API_KEY");
  if (!key) return json({ detail: "AI is not configured on the server (ANTHROPIC_API_KEY missing)" }, 503);
  const body = await readJson(req);
  const country = String(body.country ?? "AU").toUpperCase();
  const authority = country === "US" ? "the IRS (Internal Revenue Service)" : "the ATO (Australian Taxation Office)";
  const place = country === "US" ? "the United States" : "Australia";
  const system = `You are the GigTax Assistant, a tax helper for gig-economy rideshare and delivery drivers in ${place}. You answer questions using ONLY the VERIFIED KNOWLEDGE BASE below, which is based on ${authority} guidance.\n\nSTRICT RULES:\n1. Use ONLY the facts in the VERIFIED KNOWLEDGE BASE. Never use outside knowledge, never guess, never browse the web.\n2. If the answer is not covered by the knowledge base, say clearly: "That's not in my verified ${authority} sources — please check with a registered tax professional." Do not attempt an answer from general knowledge.\n3. When you state a rule or rate, mention the section it came from (e.g. "cents-per-km method") and the year for any rate, and note that rates are updated each year.\n4. Focus on what IS and what is NOT claimable/deductible. Be concise, plain-English, and practical.\n5. Never invent dollar figures for the driver's personal return. This is general guidance, not personal tax advice; remind them to confirm with a registered tax agent before lodging/filing.\n6. Keep answers short (a few sentences or a short bullet list). Do not output JSON or markdown headers.\n\n=== VERIFIED KNOWLEDGE BASE (your ONLY source of truth) ===\n${kbFor(country)}\n=== END KNOWLEDGE BASE ===`;
  let transcript = "";
  for (const m of ((body.history as Doc[]) ?? []).slice(-6)) {
    const role = m.role === "user" ? "Driver" : "Assistant";
    const txt = String(m.text ?? "").trim();
    if (txt) transcript += `${role}: ${txt}\n`;
  }
  let userText = String(body.question ?? "").trim();
  if (transcript) userText = `Conversation so far (for context only):\n${transcript}\nNow answer the driver's latest question:\n${userText}`;
  const model = envGet(deps, "ANTHROPIC_MODEL") || "claude-sonnet-4-6";
  const fetcher = deps.fetch ?? fetch;
  const r = await fetcher("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages: [{ role: "user", content: userText }] }),
  });
  if (!r.ok) return json({ detail: "Assistant failed" }, 502);
  const data = await r.json();
  const answer = ((data.content ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return json({ answer: answer.trim(), country });
}

async function scan(req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  if (owner.user.is_demo) return json({ detail: "Demo accounts can't use this feature" }, 403);
  const gate = await requireEntitled(deps, owner);
  if (gate) return gate;
  const limit = Number(envGet(deps, "AI_RATE_LIMIT") || "30");
  if (await rateLimit(deps, `ai:${owner.profileId}`, limit)) return json({ detail: "Too many requests" }, 429);
  const key = envGet(deps, "ANTHROPIC_API_KEY");
  if (!key) return json({ detail: "AI is not configured on the server (ANTHROPIC_API_KEY missing)" }, 503);
  const body = await readJson(req);
  let img = String(body.image_base64 ?? "");
  let media = "image/jpeg";
  if (img.includes(",") && img.trim().startsWith("data:")) {
    const [header, rest] = img.split(",", 2);
    img = rest;
    const mt = header.slice(5).split(";")[0];
    if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mt)) media = mt;
  } else if (img.startsWith("iVBOR")) media = "image/png";
  const system = "You are a receipt data extractor for an Australian gig-driver tax app. Extract fields from the receipt image and respond with ONLY a compact JSON object, no markdown, no prose. Schema: {\"amount\": number (total incl GST, no currency symbol), \"date\": \"YYYY-MM-DD\" (best guess, today if unclear), \"merchant\": string, \"gst\": number|null (the GST/tax amount printed on the invoice; null if the invoice shows NO GST), \"liters\": number|null (fuel volume in litres for FUEL receipts, e.g. 42.15; null for non-fuel), \"category\": one of \"fuel\",\"tolls\",\"vehicle\",\"phone\",\"other\"}. Map petrol/servo/gas -> fuel; car service/tyres/repairs/parts -> vehicle; toll/etoll/linkt -> tolls; telco/mobile/data -> phone; everything else -> other.";
  const model = envGet(deps, "ANTHROPIC_VISION_MODEL") || envGet(deps, "ANTHROPIC_MODEL") || "claude-sonnet-4-6";
  const fetcher = deps.fetch ?? fetch;
  const r = await fetcher("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 512, system,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: media, data: img } },
        { type: "text", text: "Extract the receipt fields as JSON." },
      ] }],
    }),
  });
  if (!r.ok) return json({ detail: "Receipt scan failed" }, 502);
  const data = await r.json();
  let text = ((data.content ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```/, "").replace(/```$/, "");
    if (text.toLowerCase().startsWith("json")) text = text.slice(4);
  }
  let parsed: Doc = {};
  try {
    const s = text.indexOf("{");
    const en = text.lastIndexOf("}");
    parsed = JSON.parse(text.slice(s, en + 1));
  } catch { /* empty */ }
  let cat = String(parsed.category ?? "other");
  if (!["fuel", "tolls", "vehicle", "phone", "other"].includes(cat)) cat = "other";
  const numOr = (v: unknown, ok: boolean) => {
    if (!ok || v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? tax.pyRound(n, 2) : null;
  };
  return json({
    amount: parsed.amount ?? null,
    date: parsed.date || tax.iso(tax.taxToday()),
    merchant: parsed.merchant || "",
    category: cat,
    liters: numOr(parsed.liters, cat === "fuel"),
    gst: numOr(parsed.gst, true),
  });
}

async function getProfile(req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const bad = checkPid(owner, new URL(req.url).searchParams.get("profile_id"));
  if (bad) return bad;
  let doc = await deps.db.profiles.findOne({ profile_id: owner.profileId });
  if (!doc) {
    doc = { profile_id: owner.profileId, country: "AU", work_type: "delivery", platforms: [], vehicle_ownership: "own", accounting_method: "cash", tax_id_on_file: false, business_use_fallback: 100, week_start: 0, theme: "dark", onboarded: false, created_at: nowIso(deps), updated_at: nowIso(deps) };
    await deps.db.profiles.insertOne(doc);
  }
  return json(doc);
}

async function saveProfile(req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const gate = await requireEntitled(deps, owner);
  if (gate) return gate;
  const body = await readJson(req);
  const bad = checkPid(owner, body.profile_id);
  if (bad) return bad;
  const existing = await deps.db.profiles.findOne({ profile_id: owner.profileId }) ?? { profile_id: owner.profileId, country: "AU" };
  const next = { ...existing, ...body, profile_id: owner.profileId, updated_at: nowIso(deps) };
  await deps.db.profiles.updateOne({ profile_id: owner.profileId }, { $set: next }, true);
  return json(next);
}

async function resource(method: string, name: string, itemId: string | undefined, req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const writing = method !== "GET";
  if (writing) {
    const gate = await requireEntitled(deps, owner);
    if (gate) return gate;
  }
  const col = deps.db.col(name) as Collection;
  if (method === "GET" && !itemId) {
    if (name === "vehicles") return json(await ensureVehicles(deps, owner.profileId));
    const rows = await col.find({ profile_id: owner.profileId }).sort("date", -1).toList(2000);
    if (name === "expenses") {
      return json(rows.map((d) => {
        const has = Boolean(d.receipt_image);
        const { receipt_image: _img, ...rest } = d;
        return { ...rest, has_receipt: has };
      }));
    }
    return json(rows);
  }
  if (method === "GET" && itemId) {
    const doc = await col.findOne({ id: itemId, profile_id: owner.profileId });
    if (!doc) return json({ detail: `${name} not found` }, 404);
    return json(doc);
  }
  if (method === "POST" && !itemId) {
    const body = await readJson(req);
    const bad = checkPid(owner, body.profile_id);
    if (bad) return bad;
    if (name === "trips" && body.start_time && body.end_time) {
      const clash = await col.findOne({
        profile_id: owner.profileId,
        start_time: { $ne: null, $lt: body.end_time },
        end_time: { $ne: null, $gt: body.start_time },
      });
      if (clash) return json({ detail: "overlaps an existing trip" }, 409);
    }
    const doc: Doc = { ...body, id: body.id ?? crypto.randomUUID(), profile_id: owner.profileId, created_at: body.created_at ?? nowIso(deps) };
    if (name === "vehicles") {
      const existing = await ensureVehicles(deps, owner.profileId);
      doc.is_active = Boolean(body.is_active) || existing.length === 0;
    }
    await col.insertOne(doc);
    if (name === "vehicles" && doc.is_active) await setActive(deps, owner.profileId, String(doc.id));
    if (name === "vehicles") return json(await ensureVehicles(deps, owner.profileId));
    return json(doc);
  }
  if (!itemId) return json({ detail: "Not found" }, 404);
  if (method === "PUT") {
    const existing = await col.findOne({ id: itemId, profile_id: owner.profileId });
    if (!existing) return json({ detail: `${name} not found` }, 404);
    const body = await readJson(req);
    const bad = checkPid(owner, body.profile_id);
    if (bad) return bad;
    const next: Doc = { ...existing, ...body, id: itemId, profile_id: owner.profileId };
    await col.updateOne({ id: itemId, profile_id: owner.profileId }, { $set: next });
    if (name === "vehicles" && next.is_active) await setActive(deps, owner.profileId, itemId);
    if (name === "vehicles") return json(await ensureVehicles(deps, owner.profileId));
    return json(next);
  }
  if (method === "DELETE") {
    if (name === "vehicles") {
      const all = await ensureVehicles(deps, owner.profileId);
      if (!all.some((v) => v.id === itemId)) return json({ detail: "vehicle not found" }, 404);
      if (all.length <= 1) return json({ detail: "You must keep at least one vehicle" }, 400);
      const was = all.find((v) => v.id === itemId)?.is_active;
      await col.deleteOne({ id: itemId, profile_id: owner.profileId });
      const remaining = await col.find({ profile_id: owner.profileId }).sort("created_at", 1).toList(100);
      if (was && remaining[0]) await setActive(deps, owner.profileId, String(remaining[0].id));
      return json(await ensureVehicles(deps, owner.profileId));
    }
    const res = await col.deleteOne({ id: itemId, profile_id: owner.profileId });
    if (!res.deleted_count) return json({ detail: `${name} not found` }, 404);
    return json({ ok: true });
  }
  return json({ detail: "Method Not Allowed" }, 405);
}

async function waitlist(req: Request, deps: AppDeps): Promise<Response> {
  const body = await readJson(req);
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email.includes("@") || !email.includes(".")) return json({ detail: "Invalid email" }, 400);
  await deps.db.waitlist.updateOne({ email }, { $setOnInsert: { email, created_at: nowIso(deps) } }, true);
  return json({ ok: true });
}

const DATA_COLLS = ["profiles", "vehicles", "trips", "income", "expenses", "shifts", "ue_jobs", "drive_tokens"];

async function ownerOrTicket(req: Request, deps: AppDeps): Promise<Owner | Response> {
  if (bearer(req)) return await currentUser(deps, req);
  const ticket = new URL(req.url).searchParams.get("ticket") ?? "";
  if (!ticket) return json({ detail: "Not authenticated" }, 401);
  const doc = await deps.db.oauth_states.findOne({ state: `tkt_${ticket}` });
  if (!doc || doc.kind !== "ticket") return json({ detail: "Invalid ticket" }, 401);
  await deps.db.oauth_states.deleteOne({ state: `tkt_${ticket}` });
  const created = Date.parse(String(doc.created_at ?? ""));
  if (Number.isNaN(created) || created + 5 * 60_000 < (deps.now ?? (() => new Date()))().getTime()) {
    return json({ detail: "Ticket expired" }, 401);
  }
  const user = await deps.db.users.findOne({ user_id: doc.user_id });
  if (!user) return json({ detail: "User not found" }, 401);
  const owner = { user, profileId: String(user.user_id) };
  const bad = checkPid(owner, new URL(req.url).searchParams.get("profile_id"));
  if (bad) return bad;
  return owner;
}

async function authTicket(req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const t = id() + id();
  await deps.db.oauth_states.insertOne({ state: `tkt_${t}`, kind: "ticket", user_id: owner.profileId, created_at: nowIso(deps) });
  return json({ ticket: t, expires_in: 300 });
}

async function authClaim(req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const body = await readJson(req);
  const src = String(body.from_profile_id ?? "");
  const uid = owner.profileId;
  if (owner.user.is_demo || !src || src === uid) return json({ claimed: false });
  if (await deps.db.users.findOne({ user_id: src }) || src.startsWith("user_") || src.startsWith("demo_")) {
    return json({ detail: "Not an anonymous device profile" }, 403);
  }
  for (const name of DATA_COLLS) {
    if (await deps.db.col(name).findOne({ profile_id: uid })) return json({ claimed: false });
  }
  let moved = 0;
  for (const name of DATA_COLLS) {
    const res = await deps.db.col(name).updateMany({ profile_id: src }, { $set: { profile_id: uid } });
    moved += res.modified_count;
  }
  return json({ claimed: moved > 0, moved });
}

async function deleteAccount(req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const uid = owner.profileId;
  const row = await deps.db.drive_tokens.findOne({ profile_id: uid });
  if (row) {
    const key = envGet(deps, "DRIVE_ENCRYPTION_KEY");
    const enc = String(row.refresh_token || row.access_token || "");
    if (key && enc) {
      try {
        const token = await decryptToken(key, enc);
        await (deps.fetch ?? fetch)("https://oauth2.googleapis.com/revoke", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }),
        });
      } catch { /* best effort */ }
    }
  }
  const deleted: Record<string, number> = {};
  for (const name of DATA_COLLS) {
    deleted[name] = (await deps.db.col(name).deleteMany({ profile_id: uid })).deleted_count;
  }
  deleted.oauth_states = (await deps.db.oauth_states.deleteMany({ user_id: uid })).deleted_count +
    (await deps.db.oauth_states.deleteMany({ profile_id: uid })).deleted_count;
  deleted.user_sessions = (await deps.db.user_sessions.deleteMany({ user_id: uid })).deleted_count;
  deleted.user = (await deps.db.users.deleteOne({ user_id: uid })).deleted_count;
  return json({ ok: true, deleted });
}

async function ensureVehicles(deps: AppDeps, profileId: string): Promise<Doc[]> {
  let docs = await deps.db.vehicles.find({ profile_id: profileId }).sort("created_at", 1).toList(100);
  if (!docs.length) {
    const profile = await deps.db.profiles.findOne({ profile_id: profileId }) ?? {};
    const v = (profile.vehicle as Doc) ?? {};
    const doc: Doc = {
      id: crypto.randomUUID(), profile_id: profileId, name: v.make_model || "My Vehicle",
      registration: v.registration ?? null, make_model: v.make_model ?? null, year: v.year ?? null,
      ownership: profile.vehicle_ownership ?? "own", recurring_payment: profile.recurring_payment ?? null,
      is_active: true, created_at: nowIso(deps),
    };
    await deps.db.vehicles.insertOne(doc);
    await deps.db.trips.updateMany({ profile_id: profileId, vehicle_id: null }, { $set: { vehicle_id: doc.id } });
    await deps.db.expenses.updateMany({ profile_id: profileId, vehicle_id: null }, { $set: { vehicle_id: doc.id } });
    docs = [doc];
  }
  if (!docs.some((d) => d.is_active)) {
    await deps.db.vehicles.updateOne({ id: docs[0].id }, { $set: { is_active: true } });
    docs[0].is_active = true;
  }
  return docs;
}

async function setActive(deps: AppDeps, profileId: string, vehicleId: string): Promise<void> {
  await deps.db.vehicles.updateMany({ profile_id: profileId }, { $set: { is_active: false } });
  await deps.db.vehicles.updateOne({ id: vehicleId, profile_id: profileId }, { $set: { is_active: true } });
}

async function activateVehicle(id: string, req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const gate = await requireEntitled(deps, owner);
  if (gate) return gate;
  if (!await deps.db.vehicles.findOne({ id, profile_id: owner.profileId })) return json({ detail: "vehicle not found" }, 404);
  await setActive(deps, owner.profileId, id);
  return json(await ensureVehicles(deps, owner.profileId));
}

function refDate(url: URL): Date {
  const s = url.searchParams.get("ref_date");
  return s ? tax.parseDate(s) : tax.taxToday();
}

async function loadAll(deps: AppDeps, profileId: string): Promise<[Doc, Doc[], Doc[], Doc[], Doc[]]> {
  const profile = await deps.db.profiles.findOne({ profile_id: profileId }) ?? { profile_id: profileId, country: "AU" };
  const vehicles = await ensureVehicles(deps, profileId);
  const trips = await deps.db.trips.find({ profile_id: profileId }).toList(5000);
  const income = await deps.db.income.find({ profile_id: profileId }).toList(5000);
  const expenses = (await deps.db.expenses.find({ profile_id: profileId }).toList(5000)).map((e) => {
    const { receipt_image: _img, ...rest } = e;
    return rest;
  });
  return [profile, trips, income, expenses, vehicles];
}

function csvResponse(text: string, filename: string): Response {
  return new Response(text, {
    headers: { "content-type": "text/csv", "content-disposition": `attachment; filename=${filename}`, ...corsHeaders() },
  });
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

async function calcRoute(method: string, path: string, url: URL, req: Request, deps: AppDeps): Promise<Response> {
  if (method !== "GET") return json({ detail: "Method Not Allowed" }, 405);
  const owner = path.startsWith("/api/export") ? await ownerOrTicket(req, deps) : await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const bad = checkPid(owner, url.searchParams.get("profile_id"));
  if (bad) return bad;
  const [profile, trips, income, expenses, vehicles] = await loadAll(deps, owner.profileId);
  const ref = refDate(url);
  const shifts = path === "/api/reports" || path === "/api/dashboard" || path === "/api/export" || path === "/api/export-mileage" || path === "/api/tax-mileage"
    ? []
    : await deps.db.shifts.find({ profile_id: owner.profileId }).toList(5000);
  if (path === "/api/reports") return json(tax.computeReport(profile, trips, income, expenses, url.searchParams.get("period") || "quarter", ref, vehicles));
  if (path === "/api/reports/analytics") {
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    if (!start || !end) return json({ detail: "start and end required" }, 400);
    const allShifts = await deps.db.shifts.find({ profile_id: owner.profileId }).toList(5000);
    const prov = url.searchParams.get("providers");
    return json(tax.computeAnalytics(profile, trips, income, expenses, allShifts, vehicles, tax.parseDate(start), tax.addDays(tax.parseDate(end), 1), prov ? prov.split(",").filter(Boolean) : null, url.searchParams.get("vehicle_id")));
  }
  if (path === "/api/dashboard") return json(tax.dashboard(profile, trips, income, expenses, ref, vehicles));
  if (path === "/api/performance") return json(tax.performance(profile, trips, income, expenses, ref, shifts));
  if (path === "/api/insights") return json(tax.insights(profile, income, expenses, shifts, ref));
  if (path === "/api/money") return json(tax.moneyOverview(profile, trips, income, expenses, shifts, ref, url.searchParams.get("period") || "week", vehicles));
  if (path === "/api/tax-mileage") return json(tax.taxMileage(profile, trips, income, expenses, ref, vehicles, url.searchParams.get("vehicle_id")));
  if (path === "/api/export") {
    const period = url.searchParams.get("period") || "quarter";
    const rep = tax.computeReport(profile, trips, income, expenses, period, ref, vehicles);
    const start = tax.parseDate(String(rep.period_start));
    const end = tax.parseDate(String(rep.period_end));
    const inP = (row: Doc) => { const d = tax.parseDate(String(row.date)); return d >= start && d < end; };
    const lines: unknown[][] = [["GigTax export", rep.period_label], [], ["Type", "Date", "Description", "Category/Platform", "Amount (AUD)", "Tax treatment"]];
    for (const i of income) if (inP(i)) lines.push(["Income", i.date, i.note || "", i.platform || "", Number(i.amount).toFixed(2), i.tax_treatment ?? "inclusive"]);
    for (const e of expenses) if (inP(e)) lines.push(["Expense", e.date, e.merchant || "", e.category ?? "", `-${Number(e.amount).toFixed(2)}`, e.tax_treatment ?? "inclusive"]);
    for (const t of trips) if (inP(t)) lines.push(["Trip", t.date, t.note || "", t.type ?? "business", `${t.distance_km} km`, ""]);
    const rp = Number(rep.vehicle_deduction?.recurring_payment_gross ?? 0);
    if (rp) lines.push(["Recurring vehicle payment (calculated)", rep.period_label, "Elapsed cycles × amount", profile.vehicle_ownership ?? "", `-${rp.toFixed(2)}`, "inclusive"]);
    lines.push([], ["--- Summary ---"], ["Total income", Number(rep.total_income).toFixed(2)], ["Total deductions", Number(rep.total_deductions).toFixed(2)], ["Net profit", Number(rep.net_profit).toFixed(2)], ["Business-use %", rep.business_use_pct]);
    if (rep.show_bas) {
      lines.push(["G1 (total sales incl GST)", Number(rep.bas.G1).toFixed(2)], ["1A (GST on sales)", Number(rep.bas["1A"]).toFixed(2)], ["1B (GST on purchases)", Number(rep.bas["1B"]).toFixed(2)], ["Net GST (1A-1B)", Number(rep.bas.net_gst).toFixed(2)]);
    }
    return csvResponse(lines.map((r) => r.map(csvCell).join(",")).join("\n") + "\n", `gigtax_${period}.csv`);
  }
  const tm = tax.taxMileage(profile, trips, income, expenses, ref, vehicles, url.searchParams.get("vehicle_id"));
  const v = (tm.vehicle ?? {}) as Doc;
  const fy = tm.financial_year as Doc;
  const lb = tm.logbook as Doc;
  const mc = tm.method_comparison as Doc;
  const odo = tm.odometer as Doc;
  const lines: unknown[][] = [
    ["GigTax — Motor Vehicle Report", `FY ${fy.label}`], [],
    ["Vehicle", v.make_model || ""], ["Registration", v.registration || ""], ["Year", v.year || ""], ["Fuel type", v.fuel_type || ""],
    ["Opening odometer", odo.opening || ""], ["Closing odometer", odo.closing || ""], ["Odometer kilometres", odo.odometer_km || ""], ["GPS kilometres", odo.gps_km], [],
    ["Total kilometres (FY)", fy.total_km], ["Business kilometres (FY)", fy.business_km], ["Private kilometres (FY)", fy.private_km], ["Business-use %", fy.business_pct], [],
  ];
  if (lb.available) {
    lines.push(["--- ATO Logbook (12-week) ---"], ["Period", lb.period_label], ["Business %", lb.business_pct], ["Journeys", lb.journey_count], [], ["Date", "From", "To", "Distance (km)", "Business (km)", "Type", "Purpose"]);
    for (const j of (lb.journeys as Doc[]) ?? []) lines.push([j.date_label, j.from_label || "", j.to_label || "", j.distance_km, j.business_km, j.type, j.purpose || ""]);
    lines.push([]);
  }
  const log = mc.logbook as Doc;
  const cpk = mc.cents_per_km as Doc;
  lines.push(["--- Method comparison ---"], ["Logbook deduction", Number(log.deduction).toFixed(2), `(${log.business_pct}% of $${Number(log.eligible_expenses).toFixed(2)})`], ["Cents per km deduction", Number(cpk.deduction).toFixed(2), `(${cpk.rate_cents}c x ${Number(cpk.claimable_km).toFixed(0)} km)`], ["Recommended method", mc.recommend_label, `better by $${Number(mc.difference).toFixed(2)}`], [], [mc.disclaimer]);
  return csvResponse(lines.map((r) => r.map(csvCell).join(",")).join("\n") + "\n", "gigtax_motor_vehicle.csv");
}

async function ueJobs(deps: AppDeps, pid: string, start?: string, end?: string): Promise<Doc[]> {
  const flt: Doc = { profile_id: pid };
  if (start && end) flt.date = { $gte: start, $lt: end };
  const docs = await deps.db.ue_jobs.find(flt).toList(20000);
  return docs.sort((a, b) => String(a.date).localeCompare(String(b.date)) || ((ue.startMinutes(String(a.start_time ?? "")) ?? 0) - (ue.startMinutes(String(b.start_time ?? "")) ?? 0)));
}

async function ueCycle(deps: AppDeps, pid: string, cycleStart: string | null): Promise<Doc> {
  const prof = await deps.db.profiles.findOne({ profile_id: pid }) ?? {};
  const vtype = String(prof.ue_vehicle_type || "car");
  const rate = ue.rateFor(vtype);
  const today = tax.iso(tax.taxToday());
  const cs = cycleStart ? ue.cycleStartFor(cycleStart) : ue.cycleStartFor(today);
  const ce = tax.iso(tax.addDays(tax.parseDate(cs), 21));
  const all = await ueJobs(deps, pid, cs, ce);
  const jobs = all.filter((j) => (j.platform || ue.UE_PLATFORM) === ue.UE_PLATFORM);
  const weeks = [0, 1, 2].map((w) => {
    const ws = tax.iso(tax.addDays(tax.parseDate(cs), 7 * w));
    const we = tax.iso(tax.addDays(tax.parseDate(ws), 7));
    const wj = jobs.filter((j) => ws <= String(j.date) && String(j.date) < we);
    return { index: w, start: ws, end: tax.iso(tax.addDays(tax.parseDate(we), -1)), ...ue.summarise(wj, rate) };
  });
  const first = (await deps.db.ue_jobs.find({ profile_id: pid }).toList(20000)).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  let earliest = first ? ue.cycleStartFor(String(first.date)) : tax.iso(tax.addDays(tax.parseDate(ue.cycleStartFor(today)), -42));
  if (earliest > cs) earliest = cs;
  const cycles: Doc[] = [];
  let c = ue.cycleStartFor(today);
  while (c >= earliest) {
    cycles.push({ start: c, end: tax.iso(tax.addDays(tax.parseDate(c), 20)) });
    c = tax.iso(tax.addDays(tax.parseDate(c), -21));
  }
  const income = await deps.db.income.find({ profile_id: pid, date: { $gte: cs, $lt: ce } }).toList(5000);
  return { cycle_start: cs, cycle_end: tax.iso(tax.addDays(tax.parseDate(ce), -1)), vehicle_type: vtype, rate, weeks, total: ue.summarise(jobs, rate), jobs, cycles, mismatches: ue.mismatches(all, income) };
}

async function ueRoute(method: string, path: string, url: URL, req: Request, deps: AppDeps): Promise<Response> {
  const authed = path === "/api/ue/export" ? await ownerOrTicket(req, deps) : await currentUser(deps, req);
  if (!isOwner(authed)) return authed;
  const owner = authed;
  if (method !== "GET") {
    const gate = await requireEntitled(deps, owner);
    if (gate) return gate;
  }
  const bad = checkPid(owner, url.searchParams.get("profile_id"));
  if (bad) return bad;
  const idMatch = path.match(/^\/api\/ue\/jobs\/([^/]+)$/);
  if (path === "/api/ue/jobs" && method === "GET") {
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    const rows = start && end ? await ueJobs(deps, owner.profileId, start, tax.iso(tax.addDays(tax.parseDate(end), 1))) : await ueJobs(deps, owner.profileId);
    return json(rows);
  }
  if (path === "/api/ue/jobs" && method === "POST") {
    const body = await readJson(req);
    const badBody = checkPid(owner, body.profile_id);
    if (badBody) return badBody;
    const rows = (body.jobs as Doc[]) ?? [];
    const existing = await ueJobs(deps, owner.profileId);
    const saved: Doc[] = [];
    const dups: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const raw: Doc = { ...rows[i], profile_id: owner.profileId, id: crypto.randomUUID(), created_at: nowIso(deps) };
      delete raw.profile_id;
      raw.profile_id = owner.profileId;
      const err = ue.validateJob(raw);
      if (err) return json({ detail: err }, 422);
      if (existing.some((e) => ue.isDup(raw, e)) || saved.some((e) => ue.isDup(raw, e))) { dups.push(i); continue; }
      saved.push(raw);
    }
    if (saved.length) await deps.db.ue_jobs.insertMany(saved);
    return json({ saved, duplicates: dups });
  }
  if (idMatch && method === "PUT") {
    const cur = await deps.db.ue_jobs.findOne({ id: idMatch[1], profile_id: owner.profileId });
    if (!cur) return json({ detail: "job not found" }, 404);
    const body = await readJson(req);
    const next = { ...cur, ...body, id: idMatch[1], profile_id: owner.profileId };
    const err = ue.validateJob(next);
    if (err) return json({ detail: err }, 422);
    const others = (await ueJobs(deps, owner.profileId)).filter((e) => e.id !== idMatch[1]);
    if (others.some((e) => ue.isDup(next, e))) return json({ detail: "duplicate of an existing job" }, 409);
    await deps.db.ue_jobs.updateOne({ id: idMatch[1], profile_id: owner.profileId }, { $set: next });
    return json(next);
  }
  if (idMatch && method === "DELETE") {
    const res = await deps.db.ue_jobs.deleteOne({ id: idMatch[1], profile_id: owner.profileId });
    if (!res.deleted_count) return json({ detail: "job not found" }, 404);
    return json({ ok: true });
  }
  if (path === "/api/ue/guarantee" && method === "GET") return json(await ueCycle(deps, owner.profileId, url.searchParams.get("cycle_start")));
  if (path === "/api/ue/mismatches" && method === "GET") {
    const end = tax.addDays(tax.taxToday(), 1);
    const start = tax.addDays(end, -22);
    const jobs = await ueJobs(deps, owner.profileId, tax.iso(start), tax.iso(end));
    const income = await deps.db.income.find({ profile_id: owner.profileId, date: { $gte: tax.iso(start), $lt: tax.iso(end) } }).toList(5000);
    return json(ue.mismatches(jobs, income));
  }
  if (path === "/api/ue/export" && method === "GET") {
    const cycle = await ueCycle(deps, owner.profileId, url.searchParams.get("cycle_start"));
    const bytes = ue.guaranteeWorkbook(cycle);
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename=uber-eats-guarantee-${cycle.cycle_start}.xlsx`,
        ...corsHeaders(),
      },
    });
  }
  return json({ detail: "Not found" }, 404);
}

const backupJobs = new Set<Promise<void>>();
export function drainBackups(): Promise<void> {
  return Promise.all([...backupJobs]).then(() => undefined);
}

async function backupRoute(method: string, path: string, req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  const bad = checkPid(owner, new URL(req.url).searchParams.get("profile_id"));
  if (bad) return bad;
  const pid = owner.profileId;
  if (path === "/api/backups/status" && method === "GET") {
    const row = await deps.db.drive_tokens.findOne({ profile_id: pid });
    if (!row) return json({ connected: false });
    return json({
      connected: Boolean(row.refresh_token) && !row.needs_reauth, needs_reauth: Boolean(row.needs_reauth),
      email: row.email ?? null, last_backup_at: row.last_backup_at ?? null, last_backup_count: row.last_backup_count ?? null,
      backup_state: row.backup_state || "idle", last_error: row.last_error ?? null,
    });
  }
  if (path === "/api/backups/disconnect" && method === "POST") {
    await deps.db.drive_tokens.deleteOne({ profile_id: pid });
    return json({ connected: false });
  }
  if (path === "/api/backups/google-drive" && method === "POST") {
    if (!envGet(deps, "DRIVE_ENCRYPTION_KEY")) return json({ detail: "Backups aren't configured on the server (DRIVE_ENCRYPTION_KEY missing)" }, 503);
    const row = await deps.db.drive_tokens.findOne({ profile_id: pid });
    if (!row?.refresh_token) return json({ detail: "Google Drive not connected" }, 409);
    const started = Number(row.backup_started_at ?? 0);
    if (row.backup_state === "running" && Date.now() / 1000 - started < 600) return json({ state: "running" });
    await deps.db.drive_tokens.updateOne({ profile_id: pid }, { $set: { backup_state: "running", backup_started_at: Date.now() / 1000, last_error: null } });
    const job = backupProfile(deps.db, envGet(deps, "DRIVE_ENCRYPTION_KEY"), pid, deps.env ?? Deno.env.toObject(), deps.fetch ?? fetch, nowIso(deps))
      .then(() => undefined)
      .catch(async (e) => {
        await deps.db.drive_tokens.updateOne({ profile_id: pid }, { $set: { backup_state: "error", last_error: backupErrorText(e), backup_started_at: null } });
      });
    backupJobs.add(job);
    job.finally(() => backupJobs.delete(job));
    const er = (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(job);
    return json({ state: "running" });
  }
  if (path === "/api/backups/restore" && method === "POST") {
    try {
      return json(await restoreProfile(deps.db, envGet(deps, "DRIVE_ENCRYPTION_KEY"), pid, deps.env ?? Deno.env.toObject(), deps.fetch ?? fetch));
    } catch (e) {
      if (e instanceof HttpError) return json({ detail: e.detail }, e.status);
      return json({ detail: "Backup failed — check your connection and try again" }, 502);
    }
  }
  return json({ detail: "Not found" }, 404);
}
