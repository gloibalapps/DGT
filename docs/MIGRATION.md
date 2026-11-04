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

## Free trial: 14 days
The trial length is **not** set in code. It comes from the intro offer on the store products: App Store Connect > Subscriptions > Introductory Offer = Free, 2 weeks, and Play Console > Subscriptions > base plan > Offer = free trial, 14 days. RevenueCat just reads it. The copy says 14 days in: `frontend/src/PaywallScreen.tsx` (CTA and fine print), `frontend/app/(tabs)/settings.tsx`, `frontend/app/manual.tsx`, `website/index.html`, `website/terms.html`, and `landing/index.html` (fixed from 7 days). No backend trial logic exists. RevenueCat is still paused (`RC_ENABLED=false` in `src/subscription.tsx`), and entitlement id `drivers_gig_tax_unlimited` must match the dashboard.

See the report for the env var table and manual steps.

## API auth & data scoping
Every data route requires `Authorization: Bearer <session_token>` (a `user_sessions` row that hasn't expired; demo sessions included) through the `require_owner` FastAPI dependency in `server.py`. The caller's profile is `profile_id == user_id`: sign-in sets the app's profile id to the user_id, and `/auth/claim` re-keys pre-login device data onto it. Each account owns exactly that one profile.
* A `profile_id` in the query or body is optional. If it isn't the caller's own, the request is refused with 403. Records are always written with the session's profile_id, and an update can't move a record to another profile.
* Get, update, and delete of a single record filter by `id` and owner `profile_id`. A record that isn't yours returns 404.
* Anonymous device profiles (random UUIDs from before login) are no longer readable directly. They can only be moved onto the signed-in account, once, through `/auth/claim`. The account must have no data yet, and the source can't be a real account id (`user_*`/`demo_*`, or any `users.user_id`). Demo accounts never claim.
* URLs opened in a browser (CSV/XLSX exports and the Drive-connect `auth/google/start?backup=1`) can't send the header. They use `?ticket=` from `POST /api/auth/ticket` instead: random, single-use, valid for 5 minutes, and stored in `oauth_states` with `kind=ticket`.
* `DELETE /api/account` deletes the authenticated user's data, user row, all of their sessions, oauth_states, and drive_tokens. It also revokes the Google Drive token on a best-effort basis.
* Public routes: `/health`, `/api/`, `/api/site`, `/api/privacy`, `/api/terms`, `/api/waitlist`, `/api/auth/{google/start (non-backup), google/callback, google/poll, apple, demo, me, logout}`.
