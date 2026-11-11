/**
 * Drivers Gig Tax API, ported from backend/server.py + subscription.py.
 * Same /api/* paths and the OAuth / demo / entitlement rules from PR #1.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Collection, Db, Doc } from "./db.ts";

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

function rateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  if (limit <= 0) return false;
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) return true;
  hits.push(now);
  buckets.set(key, hits);
  return false;
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
  if (method === "GET" && path === "/api/subscription/status") return await subStatus(req, url, deps);
  if (method === "POST" && path === "/api/subscription/webhook") return await webhook(req, deps);
  if (method === "POST" && path === "/api/ask") return await ask(req, deps);
  if (method === "POST" && path === "/api/receipts/scan") return await scan(req, deps);
  if (method === "GET" && path === "/api/profile") return await getProfile(req, deps);
  if (method === "PUT" && path === "/api/profile") return await saveProfile(req, deps);
  const crud = path.match(/^\/api\/(trips|income|expenses|shifts|vehicles)(?:\/([^/]+))?$/);
  if (crud) return await resource(method, crud[1], crud[2], req, deps);
  if (method === "POST" && path === "/api/waitlist") return await waitlist(req, deps);
  if (path.startsWith("/api/reports") || path.startsWith("/api/dashboard") || path.startsWith("/api/money") ||
      path.startsWith("/api/insights") || path.startsWith("/api/performance") || path.startsWith("/api/tax-mileage") ||
      path.startsWith("/api/export") || path.startsWith("/api/ue/") || path.startsWith("/api/backups")) {
    return json({ detail: `Not ported to the edge function yet: ${path}` }, 501);
  }
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
  if (body.backup) {
    const owner = await currentUser(deps, req);
    if (!isOwner(owner)) return owner;
  }
  if (!envGet(deps, "GOOGLE_CLIENT_ID")) return json({ detail: "Google login not configured" }, 500);
  const state = crypto.randomUUID() + crypto.randomUUID();
  const pollSecret = crypto.randomUUID() + crypto.randomUUID();
  await deps.db.oauth_states.insertOne({
    state, app_redirect: appRedirect, poll_secret: pollSecret,
    backup: Boolean(body.backup), created_at: nowIso(deps),
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
  if (rateLimit(`demo:${clientIp(req)}`, limit)) return json({ detail: "Too many requests" }, 429);
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
  if (rateLimit(`ai:${owner.profileId}`, limit)) return json({ detail: "Too many requests" }, 429);
  const key = envGet(deps, "ANTHROPIC_API_KEY");
  if (!key) return json({ detail: "AI is not configured on the server (ANTHROPIC_API_KEY missing)" }, 503);
  const body = await readJson(req);
  const model = envGet(deps, "ANTHROPIC_MODEL") || "claude-sonnet-4-6";
  const fetcher = deps.fetch ?? fetch;
  const r = await fetcher("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 1024,
      system: "You are the GigTax Assistant. Use only the verified knowledge you were given.",
      messages: [{ role: "user", content: String(body.question ?? "") }],
    }),
  });
  if (!r.ok) return json({ detail: "Assistant failed" }, 502);
  const data = await r.json();
  const answer = ((data.content ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return json({ answer: answer.trim(), country: String(body.country ?? "AU").toUpperCase() });
}

async function scan(req: Request, deps: AppDeps): Promise<Response> {
  const owner = await currentUser(deps, req);
  if (!isOwner(owner)) return owner;
  if (owner.user.is_demo) return json({ detail: "Demo accounts can't use this feature" }, 403);
  const gate = await requireEntitled(deps, owner);
  if (gate) return gate;
  const limit = Number(envGet(deps, "AI_RATE_LIMIT") || "30");
  if (rateLimit(`ai:${owner.profileId}`, limit)) return json({ detail: "Too many requests" }, 429);
  if (!envGet(deps, "ANTHROPIC_API_KEY")) return json({ detail: "AI is not configured on the server (ANTHROPIC_API_KEY missing)" }, 503);
  return json({ detail: "Receipt scan is not ported to the edge function yet" }, 501);
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
    const rows = await col.find({ profile_id: owner.profileId }).sort("date", -1).toList(2000);
    return json(rows);
  }
  if (method === "POST" && !itemId) {
    const body = await readJson(req);
    const bad = checkPid(owner, body.profile_id);
    if (bad) return bad;
    const doc = { ...body, id: body.id ?? crypto.randomUUID(), profile_id: owner.profileId, created_at: body.created_at ?? nowIso(deps) };
    await col.insertOne(doc);
    return json(doc);
  }
  if (!itemId) return json({ detail: "Not found" }, 404);
  if (method === "PUT") {
    const existing = await col.findOne({ id: itemId, profile_id: owner.profileId });
    if (!existing) return json({ detail: `${name} not found` }, 404);
    const body = await readJson(req);
    const bad = checkPid(owner, body.profile_id);
    if (bad) return bad;
    const next = { ...existing, ...body, id: itemId, profile_id: owner.profileId };
    await col.updateOne({ id: itemId, profile_id: owner.profileId }, { $set: next });
    return json(next);
  }
  if (method === "DELETE") {
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
