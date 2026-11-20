-- Receipt duplicate lookup.
-- Amount is the normalised amount in cents (doc.amount_cents), so the same
-- dollar total matches exactly. profile_id and date already exist as generated
-- columns (0001). Safe to run once; IF NOT EXISTS keeps a second apply a no-op.
--
-- The live Edge Function (PR #2) stores rows in gigtax.expenses, not public.
-- Apply the same statement there with gigtax.expenses when that schema exists.
-- This file does not touch gigtax and does not need a new secret.

begin;

alter table public.expenses
  add column if not exists amount_cents integer
  generated always as (
    case
      when coalesce(doc->>'amount_cents', '') ~ '^-?[0-9]+$'
        then (doc->>'amount_cents')::integer
      else null
    end
  ) stored;

create index if not exists expenses_profile_date_amount_idx
  on public.expenses (profile_id, date collate "C", amount_cents);

commit;
