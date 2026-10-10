-- Exams carry a semester, an academic year (2026-27) and an attempt label
-- (Regular or Supplementary). A subject code or subject name may repeat in a
-- later semester or year, or as a supplementary attempt, but not within the
-- same academic type, semester, year and attempt.
-- The staff picker returns names and roles only; assignment emails look the
-- address up on the server. Proctors no longer see AI reports created before
-- 10 Oct 2026.

-- ── ai_reports ──────────────────────────────────────────────────────────────
drop policy if exists "ep aireports proctor read" on public.ai_reports;
create policy "ep aireports proctor read" on public.ai_reports
  for select to authenticated
  using (exam_id in (select public.proctor_exam_ids())
         and created_at >= timestamptz '2026-10-10 00:00:00+05:30'
         and not public.ai_report_has_marks(summary::jsonb));

-- ── Staff picker ────────────────────────────────────────────────────────────
drop function if exists public.list_assignable_staff();
create function public.list_assignable_staff()
returns table(id uuid, name text, role text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, coalesce(nullif(btrim(t.full_name), ''), nullif(btrim(t.name), ''), 'Staff') as name, t.role
  from public.teachers t
  where public.auth_is_teacher()
  order by 2;
$$;
revoke all on function public.list_assignable_staff() from public, anon;
grant execute on function public.list_assignable_staff() to authenticated, service_role;

-- A proctor assignment stores the assignee's own address, from their staff record.
create or replace function public.proctor_assignment_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assignee_id is not null then
    new.email := (select t.email from public.teachers t where t.id = new.assignee_id);
  end if;
  return new;
end;
$$;
drop trigger if exists proctor_assignment_contact on public.proctor_assignments;
create trigger proctor_assignment_contact before insert or update on public.proctor_assignments
  for each row execute function public.proctor_assignment_contact();

-- ── Exam term ───────────────────────────────────────────────────────────────
alter table public.exams add column if not exists semester smallint
  constraint exams_semester_range check (semester between 1 and 12);
alter table public.exams add column if not exists academic_year text
  constraint exams_academic_year_format check (
    academic_year ~ '^[0-9]{4}-[0-9]{2}$'
    and right(academic_year, 2)::int = (left(academic_year, 4)::int + 1) % 100);
alter table public.exams add column if not exists attempt_label text not null default 'Regular'
  constraint exams_attempt_label_valid check (attempt_label in ('Regular', 'Supplementary'));

-- Tidies the fields, requires all of them when an app user creates an exam or
-- changes how it is named, and names the exam after them.
create or replace function public.exams_naming()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_applies boolean;
begin
  new.academic_type := nullif(btrim(coalesce(new.academic_type, '')), '');
  new.subject_code := nullif(upper(regexp_replace(coalesce(new.subject_code, ''), '\s+', '', 'g')), '');
  new.subject_name := nullif(regexp_replace(btrim(coalesce(new.subject_name, '')), '\s+', ' ', 'g'), '');
  new.academic_year := nullif(btrim(coalesce(new.academic_year, '')), '');
  new.attempt_label := case lower(btrim(coalesce(new.attempt_label, '')))
                         when '' then 'Regular' when 'regular' then 'Regular' when 'supplementary' then 'Supplementary'
                         else new.attempt_label end;
  if coalesce(auth.role(), '') <> 'authenticated' then
    v_applies := false;
  elsif tg_op = 'INSERT' then
    -- An upsert of an existing exam fires this insert trigger too; its update trigger decides.
    v_applies := not exists (select 1 from public.exams x where x.id = new.id);
  else
    v_applies := new.subject_code is distinct from old.subject_code
      or new.subject_name is distinct from old.subject_name
      or new.semester is distinct from old.semester
      or new.academic_year is distinct from old.academic_year
      or new.attempt_label is distinct from old.attempt_label
      -- A renamed type cascades here after its old name is gone; that is not a change.
      or (new.academic_type is distinct from old.academic_type
          and (old.academic_type is null
               or exists (select 1 from public.academic_types t where t.name = old.academic_type)));
  end if;
  if v_applies then
    if new.academic_type is null or new.semester is null or new.academic_year is null
       or new.subject_code is null or new.subject_name is null then
      raise exception 'exam_naming_required: choose the academic type, semester and academic year, then enter the subject code and the subject name'
        using errcode = '23514';
    end if;
    if new.semester not between 1 and 12
       or new.academic_year !~ '^[0-9]{4}-[0-9]{2}$'
       or right(new.academic_year, 2)::int <> (left(new.academic_year, 4)::int + 1) % 100 then
      raise exception 'exam_term_invalid: choose a semester from 1 to 12 and an academic year like 2026-27'
        using errcode = '23514';
    end if;
    if length(new.subject_code) > 30 or length(new.subject_name) > 120 then
      raise exception 'exam_naming_too_long: keep the subject code to 30 characters and the subject name to 120'
        using errcode = '23514';
    end if;
    if not exists (select 1 from public.academic_types t where t.name = new.academic_type and t.active) then
      raise exception 'exam_type_inactive: that academic type is no longer offered' using errcode = '23514';
    end if;
  end if;
  if new.academic_type is not null and new.subject_code is not null and new.subject_name is not null
     and new.semester is not null and new.academic_year is not null then
    new.name := new.academic_type || ' · ' || new.subject_code || ' · ' || new.subject_name
      || ' · Sem ' || new.semester || ' · ' || new.academic_year
      || case when new.attempt_label = 'Supplementary' then ' · Supplementary' else '' end;
  end if;
  return new;
end;
$$;

drop index if exists public.exams_type_code_unique;
drop index if exists public.exams_type_subject_unique;
create unique index exams_type_code_unique on public.exams
  (lower(academic_type), coalesce(semester, 0), coalesce(academic_year, ''), attempt_label, upper(subject_code))
  where academic_type is not null and subject_code is not null;
create unique index exams_type_subject_unique on public.exams
  (lower(academic_type), coalesce(semester, 0), coalesce(academic_year, ''), attempt_label, lower(subject_name))
  where academic_type is not null and subject_name is not null;

-- For the create form: which field, if any, another exam of the same type,
-- semester, year and attempt already uses.
drop function if exists public.exam_naming_conflict(text, text, text, text);
create or replace function public.exam_naming_conflict(
  p_type text, p_semester integer, p_year text, p_attempt text, p_code text, p_name text, p_exclude text default null)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with same as (
    select e.subject_code, e.subject_name from public.exams e
    where public.auth_is_teacher()
      and lower(e.academic_type) = lower(btrim(p_type))
      and coalesce(e.semester, 0) = coalesce(p_semester, 0)
      and coalesce(e.academic_year, '') = coalesce(btrim(p_year), '')
      and e.attempt_label = coalesce(nullif(initcap(btrim(p_attempt)), ''), 'Regular')
      and e.id is distinct from p_exclude
  )
  select case
    when exists (select 1 from same where upper(subject_code) = upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'))) then 'subject_code'
    when exists (select 1 from same where lower(subject_name) = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))) then 'subject_name'
  end;
$$;
revoke all on function public.exam_naming_conflict(text, integer, text, text, text, text, text) from public, anon;
grant execute on function public.exam_naming_conflict(text, integer, text, text, text, text, text) to authenticated, service_role;

revoke all on function public.proctor_assignment_contact() from public, anon;

notify pgrst, 'reload schema';
