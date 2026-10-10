-- The legacy proctor_messages columns live has but no migration created;
-- 20261007100823_proctor_messages_columns alters them. Types match live.
alter table public.proctor_messages
  add column if not exists attempt_id uuid references public.attempts(id) on delete cascade,
  add column if not exists proctor_id uuid references auth.users(id),
  add column if not exists message_text text,
  add column if not exists message_type text default 'warning',
  add column if not exists read_at timestamp without time zone;
