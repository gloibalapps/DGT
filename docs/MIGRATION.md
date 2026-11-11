# Migrating Drivers Gig Tax off Emergent

Branch: `migrate-off-emergent` (local). Nothing here has been deployed or run against real data.

## Architecture after migration
| Piece | Before (Emergent) | After |
|---|---|---|
| Database | MongoDB (Motor) | Supabase Postgres (Pro), `supabase/migrations/0001_init.sql` |
| Data access | Motor | `backend/pgdb.py`: small Motor-compatible adapter on **asyncpg** |
| API | FastAPI on Emergent k8s | Same FastAPI, routes unchanged, on **Fly.io `syd`** (`fly.toml`, `backend/Dockerfile`) |
| AI | `emergentintegrations` LlmChat (gpt-4o vision, Claude Sonnet) | Official `anthropic` SDK; both receipt scan (vision) and /api/ask use `claude-sonnet-4-6` |
| Auth | Emergent session + own Google OAuth + Apple | Own Google OAuth + Apple (unchanged), sessions in Postgres. Emergent `/api/auth/session` removed |
| Marketing site | `/api/site` on backend | Netlify, `netlify.toml`, publish `website/` |

## Decisions
* **asyncpg + JSONB tables instead of supabase-py.** supabase-py talks to PostgREST over HTTP, has no transactions, and would mean rewriting ~150 Motor calls by hand. Each table keeps the whole document in `doc jsonb`, and the fields the code filters, sorts or keys on are generated columns with indexes. `pgdb.py` handles the Motor subset the code uses. API payloads stay byte-identical, ids stay the same, and the data copy is 1:1. Typed columns can be added later without changing the API.
* **Auth: keep the current Google OAuth + Apple flow (lower risk).** Supabase Auth would change every user id and the token format, and would need frontend rewrites and a user re-link migration. All of that would land while the APK is being tested. The current flow already shows the app's own Google consent screen and verifies Apple tokens on the server. You can move to Supabase Auth (Google + Apple providers) later as a separate project: add `users.auth_uid`, then the RLS policies sketched at the end of 0001_init.sql.
* **Host: Fly.io, Sydney.** It sits next to a Supabase ap-southeast-2 project, gives a long-running process (Drive backups run as in-process background tasks), and deploys from a Dockerfile. Render and Railway would also work but have no Sydney region (nearest is Singapore, roughly 90 ms per DB round trip). Supabase Edge Functions are Deno/TypeScript, so they would mean rewriting about 3,000 lines of Python tax logic.
* **RLS:** enabled on every table with no policies, and access revoked from `anon`/`authenticated`, so the public Supabase REST API exposes nothing. The backend connects as `postgres` (bypasses RLS). The service role key is only used by the one-off migration script.

## Schema (one table per old collection)
`users`, `user_sessions`, `oauth_states`, `waitlist`, `profiles`, `vehicles`, `trips`, `income`, `expenses`, `shifts`, `drive_tokens`, `ue_jobs`. The field inventory is in the comments of 0001_init.sql. Mongo TTL indexes are replaced by inline cleanup in the code plus `public.purge_expired()` (schedule it with pg_cron).

## Free trial: 14 days (server-enforced)
Implemented in `backend/subscription.py`, schema in `supabase/migrations/0002_trial_subscription.sql` (apply after 0001).

**Storage.** Trial and subscription state live on the `users` row (`doc` jsonb, exposed as STORED generated, indexed columns): `trial_started_at`, `trial_ends_at` (= start + `TRIAL_DAYS`, exactly 14×24 h), `sub_status` (`trial|active|grace|expired`, check constraint), `sub_expires_at`, `sub_checked_at`. `trial_started_at` is set at account creation (Google, Apple, demo). `trial_claims` keeps an unsalted sha256 of email / Apple `sub` with the original start so delete-and-re-sign-up resumes the old clock (one trial per identity; holds no other personal data, mention it in the privacy policy).

**Day 14.** State is `trial` while `now < trial_ends_at`; `days_left = ceil(remaining / 24 h)` (14 on day 0, 1 on day 13). From the exact moment `trial_ends_at` passes: `expired` unless entitled.

**Entitlement.** RevenueCat is the only source of truth: `GET https://api.revenuecat.com/v1/subscribers/{user_id}` with `REVENUECAT_SECRET_API_KEY`, entitlement `RC_ENTITLEMENT_ID` (default `pro`) active if `expires_date` is null or in the future. The result is cached on the row for `RC_CACHE_TTL_SECONDS` (300). `POST /api/subscription/webhook` (Authorization must equal `REVENUECAT_WEBHOOK_AUTH`) updates the cache immediately: purchase/renewal/uncancel/product change → active with expiry; EXPIRATION → expired; anything else (CANCELLATION, BILLING_ISSUE, TRANSFER…) clears the cache so the next request re-verifies. If RevenueCat is unreachable, a previously active user gets `grace` for `RC_GRACE_HOURS` (24); a never-paid user stays expired. Because RevenueCat entitlements are store-agnostic, App Store, Google Play and any future web purchase unify into the same check.

**Enforcement.** `require_entitled` (wraps `require_owner`) returns **402** `{"detail":{"code":"subscription_required","message":...,"trial_ends_at":...}}` when expired and `PAYWALL_ENFORCED=true`. Gated: create/update/delete of trips, income, expenses, shifts, vehicles (incl. activate), `PUT /profile`, UE jobs, receipt scan, Ask AI. **Never gated** (trial or expired): every GET/report/dashboard, CSV/XLSX exports (`/export`, `/export-mileage`, `/ue/export`, download tickets), Google Drive backup status/run/restore/disconnect and Drive connect, `/auth/*` (incl. claim), `DELETE /account`, privacy/terms, `GET /api/subscription/status`. No data is ever deleted on expiry. There are **no** trial limits on data entry: trial = full access.

**Backups.** Both methods stay available to trial and expired users: CSV/XLSX export (instant, offline-friendly, satisfies data-portability requests) and the existing Google Drive backup (automatic, restorable into the app). Restore is allowed after expiry because it only recovers the user's own data.

**Other decisions.** Demo accounts are not entitled unless `DEMO_ENTITLED=true`, and `POST /api/auth/demo` is off unless `DEMO_ENABLED=true` plus `DEMO_REVIEW_SECRET`. Demo accounts cannot call `/api/ask` or `/api/receipts/scan`. They still get trial fields. Pre-existing accounts (no `trial_started_at`) start at `max(created_at, TRIAL_EXISTING_USERS_START)`; empty = when the server first sees them after deploy (everyone migrated gets a fresh 14 days from cutover). Enforcement ships dark (`PAYWALL_ENFORCED=false`); status is still computed and returned with `"enforced": false`.

**Store intro offer vs server trial (no double trial).** The server trial runs from sign-up, so the store products should have **no** introductory free trial; otherwise a driver gets 14 days from sign-up and then another 14 at purchase. The paywall CTA reads "Subscribe" (fallback plans `trial:false`); if an intro offer is ever re-enabled, `Plan.trial` still drives the "Start 14-day free trial" copy, but only outside the server trial.

**Products to create later (none created yet).** RevenueCat project with entitlement `pro`, offering `default` with packages `$rc_monthly` and `$rc_annual`. App Store Connect and Play Console: auto-renewing subscriptions monthly **A$19.99** and yearly **A$199.99** in one subscription group, no intro offer (see above). Then: RevenueCat secret key → `REVENUECAT_SECRET_API_KEY`; webhook to `https://<backend>/api/subscription/webhook` with an Authorization value → `REVENUECAT_WEBHOOK_AUTH`; public SDK keys → `EXPO_PUBLIC_RC_IOS_KEY` / `EXPO_PUBLIC_RC_ANDROID_KEY`; flip `RC_ENABLED` in `src/subscription.tsx`; finally `PAYWALL_ENFORCED=true`.

**Web billing: deferred.** Digital subscriptions sold inside the iOS/Android apps must use Apple/Google IAP (wired via RevenueCat). The app has no web client for the data today, so RevenueCat Web Billing / Stripe adds work without customers. If it's added later, use RevenueCat Web Billing (or Stripe connected to RevenueCat) so purchases grant the same `pro` entitlement and the server check needs no change. No Stripe code or keys are in this branch.

**Frontend.** `api.ts` turns any 402 `subscription_required` into a `PaywallError` and notifies `SubscriptionProvider`, which refreshes `GET /subscription/status?refresh=true` and re-opens the paywall. `src/subscription.tsx` exposes `server`, `expired`, `refreshServer`; status refreshes on login, after purchase, restore, paywall and Customer Center. `app/_layout.tsx` shows `PaywallScreen` when expired, with "Continue read-only (view, export, back up)". `src/TrialBanner.tsx` shows days left (last 7 days) / "Trial ended — read-only" above the tabs. Settings shows days left. Entitlement id is now `pro` (`EXPO_PUBLIC_RC_ENTITLEMENT_ID`), replacing `drivers_gig_tax_unlimited`. The RevenueCat SDK pause switch (`RC_ENABLED=false`) is unchanged: with it off the server status and gating still work, and Subscribe shows "activates once published".

### Trial env vars (backend)
| Var | Default | |
|---|---|---|
| `PAYWALL_ENFORCED` | `false` | 402 on gated routes when expired |
| `TRIAL_DAYS` | `14` | |
| `TRIAL_EXISTING_USERS_START` | empty | ISO date; empty = first seen after deploy |
| `DEMO_ENTITLED` | `false` | set true only to skip the paywall for demo accounts |
| `DEMO_ENABLED` | `false` | `POST /api/auth/demo` |
| `DEMO_REVIEW_SECRET` | empty | SECRET; header `X-Demo-Review-Secret` |
| `OAUTH_REDIRECT_ORIGINS` | empty | https origins allowed to receive the Google return, besides `driversgigtax://` |
| `REVENUECAT_SECRET_API_KEY` | empty | SECRET |
| `RC_ENTITLEMENT_ID` | `pro` | |
| `RC_CACHE_TTL_SECONDS` | `300` | |
| `RC_GRACE_HOURS` | `24` | |
| `REVENUECAT_WEBHOOK_AUTH` | empty | SECRET; webhook returns 503 until set |

## API auth & data scoping
Every data route requires `Authorization: Bearer <session_token>` (a `user_sessions` row that hasn't expired; demo sessions included) through the `require_owner` FastAPI dependency in `server.py`. The caller's profile is `profile_id == user_id`: sign-in sets the app's profile id to the user_id, and `/auth/claim` re-keys pre-login device data onto it. Each account owns exactly that one profile.
* A `profile_id` in the query or body is optional. If it isn't the caller's own, the request is refused with 403. Records are always written with the session's profile_id, and an update can't move a record to another profile.
* Get, update, and delete of a single record filter by `id` and owner `profile_id`. A record that isn't yours returns 404.
* Anonymous device profiles (random UUIDs from before login) are no longer readable directly. They can only be moved onto the signed-in account, once, through `/auth/claim`. The account must have no data yet, and the source can't be a real account id (`user_*`/`demo_*`, or any `users.user_id`). Demo accounts never claim.
* URLs opened in a browser (CSV/XLSX exports and the Drive-connect `auth/google/start?backup=1`) can't send the header. They use `?ticket=` from `POST /api/auth/ticket` instead: random, single-use, valid for 5 minutes, and stored in `oauth_states` with `kind=ticket`.
* `DELETE /api/account` deletes the authenticated user's data, user row, all of their sessions, oauth_states, and drive_tokens. It also revokes the Google Drive token on a best-effort basis.
* Paywall: `/api/subscription/webhook` is public but requires `REVENUECAT_WEBHOOK_AUTH`.
* Public routes: `/health`, `/api/`, `/api/site`, `/api/privacy`, `/api/terms`, `/api/waitlist`, `/api/auth/{google/start (non-backup), google/callback, google/poll, apple, me, logout}`. `POST /api/auth/demo` is off unless `DEMO_ENABLED` and `DEMO_REVIEW_SECRET`. `POST /api/auth/google/start` returns JSON (`auth_url`, `state`, `poll_secret`) and rejects any `app_redirect` that is not `driversgigtax://` or an origin in `OAUTH_REDIRECT_ORIGINS`. The session token is returned only from `POST /api/auth/google/poll` with that poll secret.
