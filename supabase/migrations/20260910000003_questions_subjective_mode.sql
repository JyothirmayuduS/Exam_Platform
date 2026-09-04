-- The question editor saves subjective_mode ('both' | 'qr' | 'textbox') on
-- subjective questions, but the column was never added to questions on
-- projects created from older schemas — so every save failed with
-- 'Could not find the subjective_mode column of questions in the schema cache'.
alter table public.questions add column if not exists subjective_mode text;

-- Backfill existing subjective rows to the default mode.
update public.questions
set subjective_mode = 'both'
where subjective_mode is null
  and lower(type) in ('subjective', 'descriptive');

-- Make PostgREST see the new column immediately.
notify pgrst, 'reload schema';
