import { assert, assertEquals } from "@std/assert";
import { handle, redirectAllowed, resetRateLimits, type AppDeps } from "../_shared/app.ts";
import { MemoryDb } from "../_shared/db.ts";

function deps(extra: Partial<AppDeps> = {}): AppDeps {
  resetRateLimits();
  return {
    db: new MemoryDb(),
    env: {
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      OAUTH_REDIRECT_ORIGINS: "https://driversgigtax.app",
      ...extra.env,
    },
    fetch: extra.fetch,
    now: extra.now,
  };
}

async function call(d: AppDeps, path: string, init: RequestInit = {}): Promise<Response> {
  return await handle(new Request(`http://local${path}`, init), d);
}

Deno.test("router health and api root", async () => {
  const d = deps();
  assertEquals((await call(d, "/health")).status, 200);
  const root = await call(d, "/api/");
  assertEquals(root.status, 200);
  assertEquals((await root.json()).message, "GigTax API");
});

Deno.test("routes match the function slug and the full gateway prefix", async () => {
  const d = deps();
  for (const path of ["/api/health", "/functions/v1/api/health"]) {
    const res = await call(d, path);
    assertEquals(res.status, 200, path);
    assertEquals((await res.json()).status, "ok");
  }
  for (const path of ["/api/api/", "/functions/v1/api/api/"]) {
    const res = await call(d, path);
    assertEquals(res.status, 200, path);
    assertEquals((await res.json()).message, "GigTax API");
  }
  for (const path of ["/api/api/auth/me", "/functions/v1/api/api/auth/me", "/api/auth/me"]) {
    const res = await call(d, path);
    assertEquals(res.status, 401, path);
  }
  for (const path of ["/api/api/auth/google/start", "/functions/v1/api/api/auth/google/start"]) {
    const started = await (await call(d, path, {
      method: "POST",
      body: JSON.stringify({ app_redirect: "driversgigtax://auth" }),
    })).json();
    assert(String(started.auth_url).includes("functions%2Fv1%2Fapi%2Fapi%2Fauth%2Fgoogle%2Fcallback"), path);
  }
});

Deno.test("evil redirect is 400 and GET start cannot redirect", async () => {
  const d = deps();
  const post = await call(d, "/api/auth/google/start", {
    method: "POST",
    body: JSON.stringify({ app_redirect: "https://evil.example/steal" }),
  });
  assertEquals(post.status, 400);
  assertEquals(post.headers.get("location"), null);
  const get = await call(d, "/api/auth/google/start?app_redirect=https://evil.example/steal");
  assertEquals(get.status, 405);
  assertEquals(get.headers.get("location"), null);
});

Deno.test("allowlist rejects non-https and lookalike hosts", () => {
  const allowed = new Set(["https://driversgigtax.app"]);
  for (const bad of ["javascript:alert(1)", "http://driversgigtax.app/", "https://driversgigtax.app.evil.com/", "https://user@driversgigtax.app/", ""]) {
    assertEquals(redirectAllowed(bad, allowed), false, bad);
  }
  assert(redirectAllowed("driversgigtax://auth", allowed));
  assert(redirectAllowed("https://driversgigtax.app/back", allowed));
});

Deno.test("start returns poll secret only in JSON and login omits the token", async () => {
  const d = deps({
    fetch: (input) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "g", expires_in: 3600 }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ email: "driver@example.com", name: "Driver" }), { status: 200 }));
    },
  });
  const started = await (await call(d, "/api/auth/google/start", {
    method: "POST",
    body: JSON.stringify({ app_redirect: "driversgigtax://auth" }),
  })).json();
  assert(started.poll_secret);
  assert(!String(started.auth_url).includes(started.poll_secret));
  assert(String(started.auth_url).includes(started.state));

  const missing = await call(d, "/api/auth/google/poll", { method: "POST", body: JSON.stringify({ state: started.state }) });
  assertEquals(missing.status, 401);
  const wrong = await call(d, "/api/auth/google/poll", {
    method: "POST",
    body: JSON.stringify({ state: started.state, poll_secret: "nope" }),
  });
  assertEquals(wrong.status, 401);

  const cb = await call(d, `/api/auth/google/callback?code=fakecode&state=${encodeURIComponent(started.state)}`);
  assertEquals(cb.status, 302);
  const loc = cb.headers.get("location") ?? "";
  assert(loc.startsWith("driversgigtax://auth"));
  assert(!loc.includes("session_token"));
  assert(!loc.includes(started.poll_secret));

  const ready = await call(d, "/api/auth/google/poll", {
    method: "POST",
    body: JSON.stringify({ state: started.state, poll_secret: started.poll_secret }),
  });
  assertEquals(ready.status, 200);
  const token = (await ready.json()).session_token;
  assert(token && !loc.includes(token));
  const again = await call(d, "/api/auth/google/poll", {
    method: "POST",
    body: JSON.stringify({ state: started.state, poll_secret: started.poll_secret }),
  });
  assertEquals(again.status, 401);
});

Deno.test("planted disallowed redirect is not followed", async () => {
  const d = deps();
  await d.db.oauth_states.insertOne({ state: "planted", app_redirect: "https://evil.example/steal", poll_secret: "sek" });
  const r = await call(d, "/api/auth/google/callback?error=access_denied&state=planted");
  assertEquals(r.status, 400);
  assertEquals(r.headers.get("location"), null);
});

Deno.test("demo is off unless enabled with the review secret", async () => {
  const off = deps();
  assertEquals((await call(off, "/api/auth/demo", { method: "POST" })).status, 404);
  const on = deps({ env: { DEMO_ENABLED: "true", DEMO_REVIEW_SECRET: "review-secret", DEMO_RATE_LIMIT: "2" } });
  assertEquals((await call(on, "/api/auth/demo", { method: "POST" })).status, 401);
  assertEquals((await call(on, "/api/auth/demo", { method: "POST", headers: { "X-Demo-Review-Secret": "wrong" } })).status, 401);
  assertEquals((await call(on, "/api/auth/demo", { method: "POST", headers: { "X-Demo-Review-Secret": "wrong" } })).status, 429);
});

Deno.test("demo session cannot ask and a real user can", async () => {
  const d = deps({
    env: { DEMO_ENABLED: "true", DEMO_REVIEW_SECRET: "review-secret", ANTHROPIC_API_KEY: "sk-test" },
    fetch: () => Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: "Fuel can be claimed." }] }), { status: 200 })),
  });
  const created = await (await call(d, "/api/auth/demo", { method: "POST", headers: { "X-Demo-Review-Secret": "review-secret" } })).json();
  const denied = await call(d, "/api/ask", {
    method: "POST",
    headers: { authorization: `Bearer ${created.session_token}` },
    body: JSON.stringify({ question: "fuel?", country: "AU" }),
  });
  assertEquals(denied.status, 403);

  await d.db.users.insertOne({ user_id: "user_real", email: "a@b.c", is_demo: false, trial_started_at: new Date().toISOString(), trial_ends_at: new Date(Date.now() + 86400000).toISOString() });
  await d.db.user_sessions.insertOne({ session_token: "tok-real", user_id: "user_real", expires_at: "2099-01-01T00:00:00.000Z" });
  const ok = await call(d, "/api/ask", {
    method: "POST",
    headers: { authorization: "Bearer tok-real" },
    body: JSON.stringify({ question: "fuel?", country: "AU" }),
  });
  assertEquals(ok.status, 200);
  assert((await ok.json()).answer.includes("Fuel"));
});

Deno.test("paywall stays off by default and demo entitlement defaults off", async () => {
  const d = deps();
  const start = new Date(Date.now() - 60 * 86400000).toISOString();
  await d.db.users.insertOne({ user_id: "demo_old", is_demo: true, trial_started_at: start, trial_ends_at: start });
  await d.db.user_sessions.insertOne({ session_token: "tok-old", user_id: "demo_old", expires_at: "2099-01-01T00:00:00.000Z" });
  const st = await (await call(d, "/api/subscription/status", { headers: { authorization: "Bearer tok-old" } })).json();
  assertEquals(st.enforced, false);
  assertEquals(st.state, "expired");
  assertEquals(st.entitlement, null);
});
