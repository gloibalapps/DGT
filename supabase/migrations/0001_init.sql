-- Drivers Gig Tax: initial Supabase schema (migrated from MongoDB).
-- Design: one table per former Mongo collection. The full document is kept in
-- `doc jsonb` (so API payloads stay byte-identical) and every field the backend
-- filters/sorts/joins on is a STORED generated column with an index. Typed
-- normalisation can follow later without touching the API.
-- Access: the FastAPI backend connects as the `postgres` role (bypasses RLS).
-- RLS is ENABLED on every table with NO policies for anon/authenticated, so the
-- public PostgREST API (anon key) can read/write nothing. See policy notes at end.

begin;

-- users: Accounts. Fields: user_id, email, name, picture, apple_sub, is_demo, created_at
create table if not exists public.users (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  user_id text generated always as (doc->>'user_id') stored,
  email text generated always as (doc->>'email') stored,
  apple_sub text generated always as (doc->>'apple_sub') stored,
  is_demo boolean generated always as ((doc->>'is_demo')::boolean) stored,
  created_at text generated always as ((doc->>'created_at')::text) stored
);
create unique index if not exists users_user_id_key on public.users (user_id);
create unique index if not exists users_email_key on public.users (email);
create unique index if not exists users_apple_sub_key on public.users (apple_sub);
create index if not exists users_created_at_idx on public.users (created_at collate "C");
alter table public.users enable row level security;
revoke all on public.users from anon, authenticated;

-- user_sessions: Bearer sessions. Fields: session_token, user_id, is_demo, created_at, expires_at
create table if not exists public.user_sessions (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  session_token text generated always as (doc->>'session_token') stored,
  user_id text generated always as (doc->>'user_id') stored,
  expires_at text generated always as (doc->>'expires_at') stored
);
create unique index if not exists user_sessions_session_token_key on public.user_sessions (session_token);
create index if not exists user_sessions_user_id_idx on public.user_sessions (user_id);
create index if not exists user_sessions_expires_at_idx on public.user_sessions (expires_at collate "C");
alter table public.user_sessions enable row level security;
revoke all on public.user_sessions from anon, authenticated;

-- oauth_states: Google OAuth state (10 min TTL). Fields: state, app_redirect, backup, profile_id, created_at, session_token, ready_at
create table if not exists public.oauth_states (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  state text generated always as (doc->>'state') stored,
  created_at text generated always as (doc->>'created_at') stored
);
create unique index if not exists oauth_states_state_key on public.oauth_states (state);
create index if not exists oauth_states_created_at_idx on public.oauth_states (created_at collate "C");
alter table public.oauth_states enable row level security;
revoke all on public.oauth_states from anon, authenticated;

-- waitlist: Marketing waitlist. Fields: email, created_at
create table if not exists public.waitlist (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  email text generated always as (doc->>'email') stored
);
create unique index if not exists waitlist_email_key on public.waitlist (email);
alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;

-- profiles: Driver profile (see Profile model). Fields: profile_id, country, region, driver_name, work_type, platforms[], vehicle_ownership, acquisition_date, recurring_payment{}, vehicle{} (legacy), legal_name, accounting_method, tax_id_on_file, registration_status, registration_date, reporting_frequency, business_use_fallback, weekly_goal, week_start, tax_set_aside, vehicle_method, vehicle_first_business_year, theme, onboarded, ue_vehicle_type, created_at, updated_at
create table if not exists public.profiles (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  profile_id text generated always as (doc->>'profile_id') stored
);
create unique index if not exists profiles_profile_id_key on public.profiles (profile_id);
alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;

-- vehicles: Vehicle model. Fields: id, profile_id, name, registration, make_model, year, purchase_price, fuel_type, business_use_start, ownership, recurring_payment{amount,frequency,anchor_type,anchor_date}, opening_odometer(_date), closing_odometer(_date), gps_calibration_pct, disposal_date, is_active, created_at
create table if not exists public.vehicles (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  created_at text generated always as (doc->>'created_at') stored
);
create unique index if not exists vehicles_id_key on public.vehicles (id);
create index if not exists vehicles_profile_id_created_at_idx on public.vehicles (profile_id, created_at collate "C");
alter table public.vehicles enable row level security;
revoke all on public.vehicles from anon, authenticated;

-- trips: Trip model. Fields: id, profile_id, date, distance_km, duration_min, type, business_pct, purpose, vehicle_id, from_label, to_label, odo_start, odo_end, note, start_time, end_time, source, created_at
create table if not exists public.trips (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored,
  vehicle_id text generated always as (doc->>'vehicle_id') stored,
  start_time text generated always as (doc->>'start_time') stored,
  end_time text generated always as (doc->>'end_time') stored
);
create unique index if not exists trips_id_key on public.trips (id);
create index if not exists trips_profile_id_date_idx on public.trips (profile_id, date collate "C");
create index if not exists trips_profile_id_start_time_idx on public.trips (profile_id, start_time collate "C");
alter table public.trips enable row level security;
revoke all on public.trips from anon, authenticated;

-- income: Income model. Fields: id, profile_id, date, amount, platform, tax_treatment, note, created_at
create table if not exists public.income (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored,
  platform text generated always as (doc->>'platform') stored
);
create unique index if not exists income_id_key on public.income (id);
create index if not exists income_profile_id_date_idx on public.income (profile_id, date collate "C");
alter table public.income enable row level security;
revoke all on public.income from anon, authenticated;

-- expenses: Expense model. Fields: id, profile_id, date, amount, category, merchant, vehicle_id, tax_treatment, note, liters, gst, receipt_image (base64), created_at
create table if not exists public.expenses (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored,
  vehicle_id text generated always as (doc->>'vehicle_id') stored
);
create unique index if not exists expenses_id_key on public.expenses (id);
create index if not exists expenses_profile_id_date_idx on public.expenses (profile_id, date collate "C");
alter table public.expenses enable row level security;
revoke all on public.expenses from anon, authenticated;

-- shifts: Shift model. Fields: id, profile_id, date, hours, active_hours, active_by_platform{}, start_time, end_time, platform, vehicle_id, note, created_at
create table if not exists public.shifts (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored
);
create unique index if not exists shifts_id_key on public.shifts (id);
create index if not exists shifts_profile_id_date_idx on public.shifts (profile_id, date collate "C");
alter table public.shifts enable row level security;
revoke all on public.shifts from anon, authenticated;

-- drive_tokens: Google Drive backup tokens (Fernet-encrypted). Fields: profile_id, email, access_token, refresh_token, access_expires_at, scopes[], needs_reauth, updated_at, uploaded_receipts[], last_backup_at, last_backup_count, backup_state, backup_started_at, last_error
create table if not exists public.drive_tokens (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  profile_id text generated always as (doc->>'profile_id') stored
);
create unique index if not exists drive_tokens_profile_id_key on public.drive_tokens (profile_id);
alter table public.drive_tokens enable row level security;
revoke all on public.drive_tokens from anon, authenticated;

-- ue_jobs: Uber Eats guarantee jobs (UEJob). Fields: id, profile_id, date, start_time, type, duration_sec, amount, km, platform, created_at
create table if not exists public.ue_jobs (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored
);
create unique index if not exists ue_jobs_id_key on public.ue_jobs (id);
create index if not exists ue_jobs_profile_id_date_idx on public.ue_jobs (profile_id, date collate "C");
alter table public.ue_jobs enable row level security;
revoke all on public.ue_jobs from anon, authenticated;

-- Housekeeping replacing Mongo TTL indexes (user_sessions.expires_at, oauth_states 600s).
create or replace function public.purge_expired() returns void language sql security definer set search_path = public as $$
  delete from public.user_sessions where expires_at collate "C" < to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS');
  delete from public.oauth_states where created_at collate "C" < to_char((now() - interval '10 minutes') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS');
$$;
revoke all on function public.purge_expired() from public, anon, authenticated;
-- Schedule with pg_cron (enable the extension in Dashboard > Database > Extensions):
--   select cron.schedule('dgt-purge-expired', '*/10 * * * *', 'select public.purge_expired()');

commit;

-- Future (if the app moves to Supabase Auth and talks to PostgREST directly):
--   add users.auth_uid uuid, then per table e.g.
--   create policy own_rows on public.trips for all to authenticated
--     using (profile_id = (select user_id from public.users where auth_uid = auth.uid()))
--     with check (profile_id = (select user_id from public.users where auth_uid = auth.uid()));
