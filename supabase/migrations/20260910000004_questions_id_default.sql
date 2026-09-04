-- The questions table on older projects stores TEXT ids in the app's own
-- format ("Q-EXAM-2026-064-1043"). The editor never supplies an id and
-- expects the database to generate one, but that legacy table has no default,
-- so every "write a question" save failed with
--   "null value in column id of relation questions violates not-null".
--
-- This migration is self-healing: on TEXT-id schemas it installs a BEFORE
-- INSERT trigger that fills a missing id as "Q-<exam>-<next>" (the key
-- format every answer / paper snapshot / flag references). UUID schemas
-- (built from schema.sql) are left untouched on their gen_random_uuid()
-- default.

-- 1) Generator: next numeric suffix for an exam, derived from ids that
--    already carry that exam's prefix. Falls back to the whole table so a
--    question without an exam still gets a unique key.
create or replace function public.next_question_id(exam_key text)
returns text
language sql
volatile
as $$
  select 'Q-' || coalesce(nullif(exam_key, ''), 'GEN') || '-' ||
         (coalesce(max(substring(id from '[0-9]+$')::int), 0) + 1)::text
  from public.questions
  where exam_key is null or exam_key = '' or id like 'Q-' || exam_key || '-%';
$$;

-- 2) Trigger (TEXT schemas only — see step 3): fill a missing id from the
--    row's own exam_id so every exam's keys stay unique and readable.
create or replace function public.questions_autoid()
returns trigger
language plpgsql
as $$
begin
  if new.id is null or new.id = '' then
    new.id := public.next_question_id(new.exam_id);
  end if;
  return new;
end;
$$;

drop trigger if exists questions_autoid_trigger on public.questions;
create trigger questions_autoid_trigger
  before insert on public.questions
  for each row execute function public.questions_autoid();

-- 3) UUID schemas (built from the current schema.sql) already auto-generate
--    ids — the trigger above would hand them text and break inserts, so it is
--    removed there and the uuid default is (re)asserted.
do $$
declare
  col_type text;
begin
  select data_type into col_type
  from information_schema.columns
  where table_schema = 'public' and table_name = 'questions' and column_name = 'id';

  if col_type is null then
    raise exception 'questions.id does not exist';
  end if;

  if col_type = 'uuid' then
    drop trigger if exists questions_autoid_trigger on public.questions;
    alter table public.questions alter column id set default gen_random_uuid();
    raise notice 'questions.id: uuid schema — kept gen_random_uuid default';
  else
    raise notice 'questions.id: text schema — auto Q-<exam>-<n> ids via trigger';
  end if;
end $$;

-- 4) Let PostgREST pick up the change immediately.
notify pgrst, 'reload schema';
