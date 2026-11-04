-- Drivers Gig Tax: 14-day free trial + subscription enforcement.
-- The source of truth stays users.doc (jsonb); these STORED generated columns
-- expose the trial/subscription fields as typed, indexed columns for the
-- server, reporting and ops queries (e.g. "trials ending tomorrow").
-- See backend/subscription.py.

begin;

alter table public.users
  add column if not exists trial_started_at text generated always as (doc->>'trial_started_at') stored,
  add column if not exists trial_ends_at    text generated always as (doc->>'trial_ends_at') stored,
  add column if not exists sub_status       text generated always as (doc->>'sub_status') stored,
  add column if not exists sub_expires_at   text generated always as (doc->>'sub_expires_at') stored,
  add column if not exists sub_checked_at   text generated always as (doc->>'sub_checked_at') stored;

alter table public.users drop constraint if exists users_sub_status_check;
alter table public.users add constraint users_sub_status_check
  check (sub_status is null or sub_status in ('trial', 'active', 'grace', 'expired', 'demo'));

create index if not exists users_trial_ends_at_idx on public.users (trial_ends_at collate "C");
create index if not exists users_sub_status_idx on public.users (sub_status);

-- trial_claims: one free trial per identity. key = 'e:'||sha256(lower(email)) or
-- 'a:'||sha256(apple_sub). Kept after account deletion (no personal data beyond
-- the hash) so delete + re-sign-up resumes the original trial clock.
create table if not exists public.trial_claims (
  _pk bigint generated always as identity primary key,
  doc jsonb not null check (jsonb_typeof(doc) = 'object'),
  key text generated always as (doc->>'key') stored,
  trial_started_at text generated always as (doc->>'trial_started_at') stored
);
create unique index if not exists trial_claims_key_key on public.trial_claims (key);
alter table public.trial_claims enable row level security;
revoke all on public.trial_claims from anon, authenticated;

commit;
