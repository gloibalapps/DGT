-- API schema for the Supabase Edge Function port of the FastAPI backend.
--
-- Decision: supabase/migrations/0001_init.sql + 0002_trial_subscription.sql are
-- the schema this API needs (JSONB documents, own Bearer sessions, trips,
-- oauth_states, trial_claims). The live public tables (profiles, vehicles,
-- shifts, shift_points, incomes, expenses, receipt_backup_queue, sync_log)
-- are a different model: typed columns, user_id uuid referencing auth.users,
-- and no trips / sessions / oauth state. They are empty (0 rows) and the Expo
-- app does not query them. They are left untouched. This migration does not
-- DROP, rename, or ALTER any existing public table.
--
-- The function connects with SUPABASE_DB_URL (postgres role, bypasses RLS).
-- RLS is on and anon/authenticated have no grants, so the Data API cannot
-- read these rows with the publishable key.

create schema if not exists gigtax;

create table if not exists gigtax.users (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  user_id text generated always as (doc->>'user_id') stored,
  email text generated always as (doc->>'email') stored,
  apple_sub text generated always as (doc->>'apple_sub') stored,
  is_demo boolean generated always as ((doc->>'is_demo')::boolean) stored,
  created_at text generated always as ((doc->>'created_at')::text) stored,
  trial_started_at text generated always as (doc->>'trial_started_at') stored,
  trial_ends_at text generated always as (doc->>'trial_ends_at') stored,
  sub_status text generated always as (doc->>'sub_status') stored,
  sub_expires_at text generated always as (doc->>'sub_expires_at') stored,
  sub_checked_at text generated always as (doc->>'sub_checked_at') stored
);
create unique index if not exists users_user_id_key on gigtax.users (user_id);
create unique index if not exists users_email_key on gigtax.users (email);
create unique index if not exists users_apple_sub_key on gigtax.users (apple_sub);
create index if not exists users_trial_ends_at_idx on gigtax.users (trial_ends_at collate "C");
create index if not exists users_sub_status_idx on gigtax.users (sub_status);
do $$ begin
  alter table gigtax.users add constraint users_sub_status_check
    check (sub_status is null or sub_status in ('trial', 'active', 'grace', 'expired', 'demo'));
exception when duplicate_object then null;
end $$;

create table if not exists gigtax.user_sessions (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  session_token text generated always as (doc->>'session_token') stored,
  user_id text generated always as (doc->>'user_id') stored,
  expires_at text generated always as (doc->>'expires_at') stored
);
create unique index if not exists user_sessions_session_token_key on gigtax.user_sessions (session_token);
create index if not exists user_sessions_user_id_idx on gigtax.user_sessions (user_id);

create table if not exists gigtax.oauth_states (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  state text generated always as (doc->>'state') stored,
  created_at text generated always as (doc->>'created_at') stored
);
create unique index if not exists oauth_states_state_key on gigtax.oauth_states (state);
create index if not exists oauth_states_created_at_idx on gigtax.oauth_states (created_at collate "C");

create table if not exists gigtax.waitlist (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  email text generated always as (doc->>'email') stored
);
create unique index if not exists waitlist_email_key on gigtax.waitlist (email);

create table if not exists gigtax.profiles (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  profile_id text generated always as (doc->>'profile_id') stored
);
create unique index if not exists profiles_profile_id_key on gigtax.profiles (profile_id);

create table if not exists gigtax.vehicles (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  created_at text generated always as (doc->>'created_at') stored
);
create unique index if not exists vehicles_id_key on gigtax.vehicles (id);
create index if not exists vehicles_profile_id_created_at_idx on gigtax.vehicles (profile_id, created_at collate "C");

create table if not exists gigtax.trips (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored,
  vehicle_id text generated always as (doc->>'vehicle_id') stored,
  start_time text generated always as (doc->>'start_time') stored,
  end_time text generated always as (doc->>'end_time') stored
);
create unique index if not exists trips_id_key on gigtax.trips (id);
create index if not exists trips_profile_id_date_idx on gigtax.trips (profile_id, date collate "C");

create table if not exists gigtax.income (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored,
  platform text generated always as (doc->>'platform') stored
);
create unique index if not exists income_id_key on gigtax.income (id);

create table if not exists gigtax.expenses (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored,
  vehicle_id text generated always as (doc->>'vehicle_id') stored
);
create unique index if not exists expenses_id_key on gigtax.expenses (id);

create table if not exists gigtax.shifts (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored
);
create unique index if not exists shifts_id_key on gigtax.shifts (id);

create table if not exists gigtax.drive_tokens (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  profile_id text generated always as (doc->>'profile_id') stored
);
create unique index if not exists drive_tokens_profile_id_key on gigtax.drive_tokens (profile_id);

create table if not exists gigtax.ue_jobs (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  id text generated always as (doc->>'id') stored,
  profile_id text generated always as (doc->>'profile_id') stored,
  date text generated always as (doc->>'date') stored
);
create unique index if not exists ue_jobs_id_key on gigtax.ue_jobs (id);

create table if not exists gigtax.trial_claims (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  key text generated always as (doc->>'key') stored,
  trial_started_at text generated always as (doc->>'trial_started_at') stored
);
create unique index if not exists trial_claims_key_key on gigtax.trial_claims (key);

do $$
declare t text;
begin
  foreach t in array array[
    'users','user_sessions','oauth_states','waitlist','profiles','vehicles','trips',
    'income','expenses','shifts','drive_tokens','ue_jobs','trial_claims'
  ]
  loop
    execute format('alter table gigtax.%I enable row level security', t);
    execute format('revoke all on gigtax.%I from anon, authenticated', t);
  end loop;
end $$;

revoke all on schema gigtax from anon, authenticated;
grant usage on schema gigtax to postgres, service_role;
grant all on all tables in schema gigtax to postgres, service_role;
