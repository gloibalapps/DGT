import { assert, assertEquals } from "@std/assert";
import { drainBackups, handle, type AppDeps } from "../_shared/app.ts";
import { MemoryDb } from "../_shared/db.ts";
import { fernetDecrypt } from "../_shared/fernet.ts";

function deps(extra: Partial<AppDeps> = {}): AppDeps {
  return { db: extra.db ?? new MemoryDb(), env: extra.env, fetch: extra.fetch, now: extra.now };
}

async function call(d: AppDeps, path: string, init: RequestInit = {}): Promise<Response> {
  return await handle(new Request(`http://local${path}`, init), d);
}

async function user(d: AppDeps, id = "user_ada"): Promise<string> {
  await d.db.users.insertOne({
    user_id: id, email: `${id}@example.com`, is_demo: false,
    trial_started_at: "2026-11-01T00:00:00.000Z", trial_ends_at: "2026-12-01T00:00:00.000Z",
  });
  await d.db.user_sessions.insertOne({ session_token: `tok-${id}`, user_id: id, expires_at: "2099-01-01T00:00:00.000Z" });
  return `tok-${id}`;
}

function auth(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } };
}

Deno.test("frontend paths are routed and do not return 501", async () => {
  const d = deps({ env: { ANTHROPIC_API_KEY: "sk", DRIVE_ENCRYPTION_KEY: "" }, fetch: () => Promise.resolve(new Response("{}", { status: 200 })) });
  const token = await user(d);
  const paths: [string, RequestInit][] = [
    ["/api/auth/ticket", { method: "POST" }],
    ["/api/subscription/status", {}],
    ["/api/auth/me", {}],
    ["/api/auth/logout", { method: "POST" }],
    ["/api/auth/claim", { method: "POST", body: JSON.stringify({ from_profile_id: "device-1" }) }],
    ["/api/account", { method: "DELETE" }],
    ["/api/backups/status", {}],
    ["/api/backups/google-drive", { method: "POST" }],
    ["/api/backups/restore", { method: "POST" }],
    ["/api/backups/disconnect", { method: "POST" }],
    ["/api/profile", {}],
    ["/api/profile", { method: "PUT", body: "{}" }],
    ["/api/trips", {}],
    ["/api/income", {}],
    ["/api/expenses", {}],
    ["/api/expenses/missing", {}],
    ["/api/shifts", {}],
    ["/api/receipts/scan", { method: "POST", body: JSON.stringify({ image_base64: "aa" }) }],
    ["/api/dashboard?ref_date=2026-11-11", {}],
    ["/api/performance?ref_date=2026-11-11", {}],
    ["/api/insights?ref_date=2026-11-11", {}],
    ["/api/money?period=week&ref_date=2026-11-11", {}],
    ["/api/tax-mileage?ref_date=2026-11-11", {}],
    ["/api/vehicles", {}],
    ["/api/vehicles", { method: "POST", body: JSON.stringify({ name: "Bike" }) }],
    ["/api/reports?period=quarter&ref_date=2026-11-11", {}],
    ["/api/reports/analytics?start=2026-11-01&end=2026-11-11", {}],
    ["/api/ue/jobs", {}],
    ["/api/ue/jobs", { method: "POST", body: JSON.stringify({ jobs: [] }) }],
    ["/api/ue/guarantee", {}],
    ["/api/ue/mismatches", {}],
    ["/api/ask", { method: "POST", body: JSON.stringify({ question: "fuel?", country: "AU" }) }],
    ["/api/export?period=week&ref_date=2026-11-11", {}],
    ["/api/export-mileage?ref_date=2026-11-11", {}],
    ["/api/ue/export", {}],
    ["/api/vehicles/missing/activate", { method: "POST" }],
    ["/api/auth/google/start", { method: "POST", body: JSON.stringify({ app_redirect: "driversgigtax://auth" }) }],
    ["/api/auth/apple", { method: "POST", body: "{}" }],
    ["/api/auth/demo", { method: "POST" }],
  ];
  for (const [path, init] of paths) {
    const res = await call(d, path, auth(token, init));
    assert(res.status !== 501, `${path} -> ${res.status} ${(await res.clone().text()).slice(0, 180)}`);
  }
});

Deno.test("overlapping trips are 409 and a ticket downloads csv", async () => {
  const d = deps();
  const token = await user(d);
  const first = await call(d, "/api/trips", auth(token, {
    method: "POST",
    body: JSON.stringify({ date: "2026-11-10", distance_km: 5, start_time: "2026-11-10T01:00:00Z", end_time: "2026-11-10T02:00:00Z" }),
  }));
  assertEquals(first.status, 200);
  const clash = await call(d, "/api/trips", auth(token, {
    method: "POST",
    body: JSON.stringify({ date: "2026-11-10", distance_km: 3, start_time: "2026-11-10T01:30:00Z", end_time: "2026-11-10T02:30:00Z" }),
  }));
  assertEquals(clash.status, 409);

  const denied = await call(d, "/api/export?period=week&ref_date=2026-11-11");
  assertEquals(denied.status, 401);
  const ticket = await (await call(d, "/api/auth/ticket", auth(token, { method: "POST" }))).json();
  const csv = await call(d, `/api/export?period=week&ref_date=2026-11-11&ticket=${ticket.ticket}`);
  assertEquals(csv.status, 200);
  assert((await csv.text()).includes("GigTax export"));
  const again = await call(d, `/api/export?period=week&ref_date=2026-11-11&ticket=${ticket.ticket}`);
  assertEquals(again.status, 401);
});

Deno.test("claim moves anonymous rows once and delete removes the account", async () => {
  const d = deps();
  const token = await user(d);
  await d.db.trips.insertOne({ id: "t", profile_id: "device-9", date: "2026-11-01", distance_km: 1 });
  const claimed = await (await call(d, "/api/auth/claim", auth(token, { method: "POST", body: JSON.stringify({ from_profile_id: "device-9" }) }))).json();
  assertEquals(claimed.claimed, true);
  assertEquals((await d.db.trips.findOne({ id: "t" }))?.profile_id, "user_ada");
  const again = await (await call(d, "/api/auth/claim", auth(token, { method: "POST", body: JSON.stringify({ from_profile_id: "device-8" }) }))).json();
  assertEquals(again.claimed, false);
  const other = await call(d, "/api/auth/claim", auth(token, { method: "POST", body: JSON.stringify({ from_profile_id: "user_other" }) }));
  assertEquals(other.status, 403);
  const gone = await call(d, "/api/account", auth(token, { method: "DELETE" }));
  assertEquals(gone.status, 200);
  assertEquals(await d.db.users.findOne({ user_id: "user_ada" }), null);
  assertEquals(await d.db.trips.findOne({ id: "t" }), null);
});

Deno.test("ask sends the tax knowledge base and scan parses the vision JSON", async () => {
  let body = "";
  const d = deps({
    env: { ANTHROPIC_API_KEY: "sk" },
    fetch: (_url, init) => {
      body = String(init?.body ?? "");
      const receipt = body.includes("receipt");
      const text = receipt
        ? "```json\n{\"amount\":12.5,\"date\":\"2026-11-01\",\"merchant\":\"Shell\",\"category\":\"fuel\",\"liters\":8.2,\"gst\":1.14}\n```"
        : "Cents per kilometre is in the knowledge base.";
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 }));
    },
  });
  const token = await user(d);
  const asked = await call(d, "/api/ask", auth(token, { method: "POST", body: JSON.stringify({ question: "Can I claim fuel?", country: "AU", history: [{ role: "user", text: "hi" }] }) }));
  assertEquals(asked.status, 200);
  assert(body.includes("VERIFIED KNOWLEDGE BASE"));
  assert(body.includes("88 cents per business km"));
  const scanned = await (await call(d, "/api/receipts/scan", auth(token, { method: "POST", body: JSON.stringify({ image_base64: "data:image/png;base64,iVBOR" }) }))).json();
  assertEquals(scanned.merchant, "Shell");
  assertEquals(scanned.liters, 8.2);
  assertEquals(scanned.category, "fuel");
});

Deno.test("drive connect stores a Fernet token the Python key can open", async () => {
  const key = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
  const d = deps({
    env: { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", OAUTH_REDIRECT_ORIGINS: "https://driversgigtax.app", DRIVE_ENCRYPTION_KEY: key },
    fetch: (input) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "acc", refresh_token: "refr", expires_in: 3600, scope: "email" }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ email: "ada@example.com" }), { status: 200 }));
    },
  });
  const token = await user(d);
  const started = await (await call(d, "/api/auth/google/start", auth(token, {
    method: "POST", body: JSON.stringify({ app_redirect: "driversgigtax://auth", backup: 1 }),
  }))).json();
  assert(String(started.auth_url).includes("drive.file"));
  assert(String(started.auth_url).includes("access_type=offline"));
  const back = await call(d, `/api/auth/google/callback?code=c&state=${encodeURIComponent(started.state)}`);
  assertEquals(back.status, 302);
  assert((back.headers.get("location") ?? "").includes("drive_connected=1"));
  const row = await d.db.drive_tokens.findOne({ profile_id: "user_ada" });
  assertEquals(await fernetDecrypt(key, String(row?.refresh_token)), "refr");
  const status = await (await call(d, "/api/backups/status", auth(token))).json();
  assertEquals(status.connected, true);
});

Deno.test("backup run and restore use Drive and expense lists hide the image", async () => {
  const key = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
  const files = new Map<string, string>();
  const d = deps({
    env: { DRIVE_ENCRYPTION_KEY: key },
    fetch: (input, init) => {
      const url = String(input);
      if (url.includes("q=")) return Promise.resolve(new Response(JSON.stringify({ files: [] }), { status: 200 }));
      if (init?.method === "POST" && url.includes("drive/v3/files") && !url.includes("upload")) {
        return Promise.resolve(new Response(JSON.stringify({ id: "folder" }), { status: 200 }));
      }
      if (url.includes("upload")) {
        files.set("backup", "1");
        return Promise.resolve(new Response(JSON.stringify({ id: "file" }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });
  const token = await user(d);
  const enc = await (await import("../_shared/fernet.ts")).fernetEncrypt(key, "refr");
  const acc = await (await import("../_shared/fernet.ts")).fernetEncrypt(key, "acc");
  await d.db.drive_tokens.insertOne({ profile_id: "user_ada", refresh_token: enc, access_token: acc, access_expires_at: Date.now() / 1000 + 3600, email: "ada@example.com" });
  await d.db.expenses.insertOne({ id: "e", profile_id: "user_ada", date: "2026-11-01", amount: 9, category: "fuel", receipt_image: "aGVsbG8=" });
  const listed = await (await call(d, "/api/expenses", auth(token))).json();
  assertEquals(listed[0].has_receipt, true);
  assertEquals(listed[0].receipt_image, undefined);
  const one = await (await call(d, "/api/expenses/e", auth(token))).json();
  assertEquals(one.receipt_image, "aGVsbG8=");
  const run = await call(d, "/api/backups/google-drive", auth(token, { method: "POST" }));
  assertEquals(run.status, 200);
  await drainBackups();
  const st = await (await call(d, "/api/backups/status", auth(token))).json();
  assertEquals(st.backup_state, "done");
  assert(files.has("backup"));
});
