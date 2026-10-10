-- The last access gaps after exam roles, and exams named by academic type,
-- subject code and subject name.
--
-- ai_reports: written only by the server; full-access staff read them, an
-- assigned proctor reads a report only when it holds no marks or answers.
-- students: staff read the students of exams they can access, admins read all;
-- only admins and the owner of an exam a student is enrolled in edit them.
-- Teachers find students to enroll through search_student_directory, which
-- returns no contact details.
-- teachers: staff read their own row and the staff on their exams; owners pick
-- assignees through list_assignable_staff.
-- Evidence: a student writes only under an exam they are enrolled in and have
-- an attempt for (student_evidence_folder_ok).

-- ── ai_reports ──────────────────────────────────────────────────────────────
-- True when any key anywhere in the report is a mark or an answer.
create or replace function public.ai_report_has_marks(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with recursive walk(v) as (
    select p
    union all
    select c.v from walk w
    cross join lateral (
      select e.value as v from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) e
      union all
      select a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) a
    ) c
  )
  select exists (
    select 1 from walk w
    cross join lateral jsonb_object_keys(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) k
    where lower(k) ~ '^(score|scores|percentage|percent|passed|rank|marks?|grade|grades|total_marks|answers?|answer_key|correct_answers?|key)$'
  );
$$;

drop policy if exists "ep aireports exam staff" on public.ai_reports;
drop policy if exists "ep aireports exam staff read" on public.ai_reports;
create policy "ep aireports exam staff read" on public.ai_reports
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or exam_id in (select public.staff_exam_ids()));
drop policy if exists "ep aireports proctor read" on public.ai_reports;
create policy "ep aireports proctor read" on public.ai_reports
  for select to authenticated
  using (exam_id in (select public.proctor_exam_ids()) and not public.ai_report_has_marks(summary::jsonb));
revoke insert, update, delete on public.ai_reports from anon, authenticated;

-- ── students ────────────────────────────────────────────────────────────────
create or replace function public.staff_student_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select en.student_id from public.enrollments en where en.exam_id in (select public.invigilated_exam_ids())
  union
  select a.student_id from public.attempts a where a.exam_id in (select public.invigilated_exam_ids());
$$;

create or replace function public.can_edit_student(p_student uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_student is not null and (public.auth_is_staff_admin() or (public.auth_is_teacher() and exists (
    select 1 from public.enrollments en join public.exams e on e.id = en.exam_id
    where en.student_id = p_student and e.created_by = auth.uid())));
$$;

drop policy if exists "ep students staff read" on public.students;
drop policy if exists "ep students teacher write" on public.students;
drop policy if exists "ep students exam staff read" on public.students;
create policy "ep students exam staff read" on public.students
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or id in (select public.staff_student_ids()));
drop policy if exists "ep students owner update" on public.students;
create policy "ep students owner update" on public.students
  for update to authenticated
  using (public.can_edit_student(id)) with check (public.can_edit_student(id));
drop policy if exists "ep students owner delete" on public.students;
create policy "ep students owner delete" on public.students
  for delete to authenticated
  using (public.can_edit_student(id));
drop policy if exists "ep students admin insert" on public.students;
create policy "ep students admin insert" on public.students
  for insert to authenticated
  with check ((select public.auth_is_staff_admin()));
-- Editing a record never relinks it to another login.
revoke update on public.students from authenticated;
grant update (roll, full_name, email, branch, section, phone, batch) on public.students to authenticated;

-- Enrolling: roll, name and class only, for teachers and admins.
create or replace function public.search_student_directory(p_batch text default null, p_branch text default null, p_section text default null)
returns table(id uuid, roll text, full_name text, branch text, section text, batch text, has_email boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.roll, s.full_name, s.branch, s.section, s.batch, coalesce(btrim(s.email), '') <> ''
  from public.students s
  where public.auth_is_teacher()
    and (nullif(btrim(p_batch), '') is null or s.batch = p_batch)
    and (nullif(btrim(p_branch), '') is null or btrim(s.branch) = btrim(p_branch))
    and (nullif(btrim(p_section), '') is null or btrim(s.section) = btrim(p_section))
  order by s.roll;
$$;

create or replace function public.student_directory_filters()
returns table(kind text, value text, students bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select 'branch', btrim(s.branch), count(*) from public.students s
  where public.auth_is_teacher() and coalesce(btrim(s.branch), '') <> '' group by btrim(s.branch)
  union all
  select 'section', btrim(s.section), count(*) from public.students s
  where public.auth_is_teacher() and coalesce(btrim(s.section), '') <> '' group by btrim(s.section)
  union all
  select 'batch', s.batch, count(*) from public.students s
  where public.auth_is_teacher() and coalesce(btrim(s.batch), '') <> '' group by s.batch;
$$;

-- Adds new students and enrolls them in the exam. Existing students are only
-- updated when the caller may edit them; they are enrolled either way.
create or replace function public.import_students(p_exam text, p_rows jsonb)
returns table(roll text, student_id uuid, created boolean, updated boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r jsonb;
  v_roll text;
  v_id uuid;
  v_new boolean;
  v_upd boolean;
begin
  if p_exam is null then
    if not public.auth_is_staff_admin() then
      raise exception 'forbidden: choose one of your exams to import students into' using errcode = '42501';
    end if;
  elsif not (public.auth_is_staff_admin() or public.owns_exam(p_exam)) then
    raise exception 'forbidden: only the exam''s owner or an admin can enroll students' using errcode = '42501';
  end if;
  for r in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_roll := btrim(coalesce(r ->> 'roll', ''));
    continue when v_roll = '';
    select s.id into v_id from public.students s where s.roll = v_roll or s.roll = upper(v_roll) order by (s.roll = v_roll) desc limit 1;
    v_new := v_id is null;
    v_upd := false;
    if v_new then
      insert into public.students (roll, full_name, email, branch, section, phone)
      values (v_roll, nullif(btrim(r ->> 'full_name'), ''), nullif(btrim(r ->> 'email'), ''), nullif(btrim(r ->> 'branch'), ''),
              nullif(btrim(r ->> 'section'), ''), nullif(btrim(r ->> 'phone'), ''))
      returning id into v_id;
    elsif public.can_edit_student(v_id) then
      update public.students s set
        full_name = coalesce(nullif(btrim(r ->> 'full_name'), ''), s.full_name),
        email = coalesce(nullif(btrim(r ->> 'email'), ''), s.email),
        branch = coalesce(nullif(btrim(r ->> 'branch'), ''), s.branch),
        section = coalesce(nullif(btrim(r ->> 'section'), ''), s.section),
        phone = coalesce(nullif(btrim(r ->> 'phone'), ''), s.phone)
      where s.id = v_id;
      v_upd := true;
    end if;
    if p_exam is not null then
      insert into public.enrollments (exam_id, student_id) values (p_exam, v_id) on conflict do nothing;
    end if;
    roll := v_roll; student_id := v_id; created := v_new; updated := v_upd;
    return next;
  end loop;
end;
$$;

-- ── teachers ────────────────────────────────────────────────────────────────
-- Staff the caller works with: the owners of exams they invigilate, and
-- everyone assigned or delegated to exams they have full access to.
create or replace function public.visible_teacher_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from public.teachers t
  join public.exams e on e.created_by = t.auth_id
  where e.id in (select public.invigilated_exam_ids())
  union
  select pa.assignee_id from public.proctor_assignments pa
  where pa.assignee_id is not null and pa.exam_id in (select public.staff_exam_ids())
  union
  select g.delegate_id from public.grading_delegations g
  left join public.attempts a on a.id = g.attempt_id
  where g.delegate_id is not null and coalesce(g.exam_id, a.exam_id) in (select public.staff_exam_ids());
$$;

drop policy if exists "ep teachers staff read" on public.teachers;
drop policy if exists "ep teachers exam staff read" on public.teachers;
create policy "ep teachers exam staff read" on public.teachers
  for select to authenticated
  using ((select public.auth_is_staff_admin()) or id in (select public.visible_teacher_ids()));

-- The assign-staff and delegate pickers: names and roles, teachers and admins only.
create or replace function public.list_assignable_staff()
returns table(id uuid, full_name text, name text, role text, department text, email text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.full_name, t.name, t.role, t.department, t.email
  from public.teachers t
  where public.auth_is_teacher()
  order by coalesce(t.full_name, t.name, t.email);
$$;

-- ── Academic types ──────────────────────────────────────────────────────────
create table if not exists public.academic_types (
  name text primary key check (btrim(name) <> '' and name = btrim(name) and length(name) <= 60),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists academic_types_name_ci on public.academic_types (lower(name));
alter table public.academic_types enable row level security;
drop policy if exists "academic types read" on public.academic_types;
create policy "academic types read" on public.academic_types
  for select to authenticated using (true);
drop policy if exists "academic types admin write" on public.academic_types;
create policy "academic types admin write" on public.academic_types
  for all to authenticated
  using ((select public.auth_is_staff_admin())) with check ((select public.auth_is_staff_admin()));
revoke all on public.academic_types from anon;
grant select, insert, update, delete on public.academic_types to authenticated;
grant all on public.academic_types to service_role;
insert into public.academic_types (name, sort_order) values ('Sem Exam', 10), ('Mid Term', 20), ('Test Exam', 30)
on conflict do nothing;

-- ── Exam naming ─────────────────────────────────────────────────────────────
alter table public.exams add column if not exists academic_type text
  references public.academic_types (name) on update cascade on delete restrict;
alter table public.exams add column if not exists subject_code text;
alter table public.exams add column if not exists subject_name text;
-- The name an exam had before this migration: old kiosks named evidence
-- folders after it.
alter table public.exams add column if not exists legacy_name text;
update public.exams set legacy_name = name where legacy_name is null and coalesce(name, '') <> '';

drop index if exists public.exams_name_unique;
drop index if exists public.exams_folder_slug_unique;

-- Tidies the three fields, requires all three when an app user creates an exam
-- or changes its subject, and names the exam after them.
create or replace function public.exams_naming()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.academic_type := nullif(btrim(coalesce(new.academic_type, '')), '');
  new.subject_code := nullif(upper(regexp_replace(coalesce(new.subject_code, ''), '\s+', '', 'g')), '');
  new.subject_name := nullif(regexp_replace(btrim(coalesce(new.subject_name, '')), '\s+', ' ', 'g'), '');
  if coalesce(auth.role(), '') = 'authenticated'
     -- An upsert of an existing exam fires this insert trigger too; its update trigger decides.
     and ((tg_op = 'INSERT' and not exists (select 1 from public.exams x where x.id = new.id))
          or new.subject_code is distinct from old.subject_code
          or new.subject_name is distinct from old.subject_name
          -- A renamed type cascades here after its old name is gone; that is not a change.
          or (new.academic_type is distinct from old.academic_type
              and (old.academic_type is null
                   or exists (select 1 from public.academic_types t where t.name = old.academic_type)))) then
    if new.academic_type is null or new.subject_code is null or new.subject_name is null then
      raise exception 'exam_naming_required: choose the academic type, then enter the subject code and the subject name'
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
  if new.academic_type is not null and new.subject_code is not null and new.subject_name is not null then
    new.name := new.academic_type || ' · ' || new.subject_code || ' · ' || new.subject_name;
  end if;
  return new;
end;
$$;

-- Existing exams: take what the name gives, and leave a field empty rather
-- than collide with an earlier exam. Names are left as they are.
drop trigger if exists exams_naming on public.exams;
with parsed as (
  select e.id, e.created_at, e.name,
         case when e.name ~* '\mmid' then 'Mid Term'
              when e.name ~* '\m(sem|semester)\M' then 'Sem Exam'
              when e.name ~* '\m(test|quiz)' then 'Test Exam' end as t,
         upper(substring(e.name from '\m([A-Za-z]{2,6}[0-9]{2,4}[A-Za-z]?)\M')) as c
  from public.exams e
  where e.academic_type is null and e.subject_code is null and e.subject_name is null and coalesce(btrim(e.name), '') <> ''
), named as (
  select p.*, nullif(regexp_replace(regexp_replace(regexp_replace(
           case when p.c is null then p.name else regexp_replace(p.name, p.c, ' ', 'i') end,
           '\s*([·:|-]\s*)+', ' - ', 'g'), '\s+', ' ', 'g'), '^[\s·:|-]+|[\s·:|-]+$', '', 'g'), '') as n
  from parsed p
), ranked as (
  select n.*,
         row_number() over (partition by lower(n.t), n.c order by n.created_at nulls last, n.id) as code_rank,
         row_number() over (partition by lower(n.t), lower(n.n) order by n.created_at nulls last, n.id) as name_rank
  from named n
)
update public.exams e
   set academic_type = r.t,
       subject_code = case when r.t is null then r.c
                           when r.code_rank = 1 and not exists (select 1 from public.exams x
                             where lower(x.academic_type) = lower(r.t) and upper(x.subject_code) = r.c) then r.c end,
       subject_name = case when r.t is null then r.n
                           when r.name_rank = 1 and not exists (select 1 from public.exams x
                             where lower(x.academic_type) = lower(r.t) and lower(x.subject_name) = lower(r.n)) then r.n end
  from ranked r
 where e.id = r.id;

create trigger exams_naming before insert or update on public.exams
  for each row execute function public.exams_naming();

create unique index if not exists exams_type_code_unique on public.exams (lower(academic_type), upper(subject_code))
  where academic_type is not null and subject_code is not null;
create unique index if not exists exams_type_subject_unique on public.exams (lower(academic_type), lower(subject_name))
  where academic_type is not null and subject_name is not null;

-- For the create form: which field, if any, another exam of that type already uses.
create or replace function public.exam_naming_conflict(p_type text, p_code text, p_name text, p_exclude text default null)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not public.auth_is_teacher() then null
    when exists (select 1 from public.exams e where lower(e.academic_type) = lower(btrim(p_type))
                   and upper(e.subject_code) = upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'))
                   and e.id is distinct from p_exclude) then 'subject_code'
    when exists (select 1 from public.exams e where lower(e.academic_type) = lower(btrim(p_type))
                   and lower(e.subject_name) = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'))
                   and e.id is distinct from p_exclude) then 'subject_name'
  end;
$$;

-- ── Evidence folders ────────────────────────────────────────────────────────
-- Folders old kiosks may have used for an exam: its name and former name, raw
-- and slugged. A folder shared by two exams, or equal to an exam id, belongs
-- to no exam.
create or replace function public.legacy_folder_exams()
returns table(folder text, exam_id text)
language sql
stable
security definer
set search_path = ''
as $$
  with candidates as (
    select distinct v.f as folder, e.id as exam_id
    from public.exams e
    cross join lateral (values (e.name), (public.exam_folder_slug(e.name)), (e.legacy_name), (public.exam_folder_slug(e.legacy_name))) v(f)
    where coalesce(v.f, '') <> ''
  )
  select c.folder, min(c.exam_id) from candidates c
  where not exists (select 1 from public.exams x where x.id = c.folder)
  group by c.folder
  having count(*) = 1;
$$;

create or replace function public.owner_legacy_folders()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select l.folder from public.legacy_folder_exams() l
  join public.exams e on e.id = l.exam_id
  where e.created_by = auth.uid() and public.auth_is_teacher();
$$;

-- A student may write under an exam's id, or its old name folder, only when
-- enrolled in that exam with an attempt for it.
create or replace function public.student_evidence_folder_ok(p_folder text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with target as (
    select coalesce((select e.id from public.exams e where e.id = p_folder),
                    (select l.exam_id from public.legacy_folder_exams() l where l.folder = p_folder)) as exam_id
  )
  select coalesce((
    select exists (select 1 from public.enrollments en where en.exam_id = t.exam_id and en.student_id = public.current_student_id())
       and exists (select 1 from public.attempts a where a.exam_id = t.exam_id and a.student_id = public.current_student_id())
    from target t where t.exam_id is not null), false);
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
revoke all on function public.ai_report_has_marks(jsonb) from public, anon;
revoke all on function public.staff_student_ids() from public, anon;
revoke all on function public.can_edit_student(uuid) from public, anon;
revoke all on function public.search_student_directory(text, text, text) from public, anon;
revoke all on function public.student_directory_filters() from public, anon;
revoke all on function public.import_students(text, jsonb) from public, anon;
revoke all on function public.visible_teacher_ids() from public, anon;
revoke all on function public.list_assignable_staff() from public, anon;
revoke all on function public.exam_naming_conflict(text, text, text, text) from public, anon;
revoke all on function public.legacy_folder_exams() from public, anon;
revoke all on function public.owner_legacy_folders() from public, anon;
revoke all on function public.student_evidence_folder_ok(text) from public, anon;
grant execute on function public.ai_report_has_marks(jsonb) to authenticated, service_role;
grant execute on function public.staff_student_ids() to authenticated, service_role;
grant execute on function public.can_edit_student(uuid) to authenticated, service_role;
grant execute on function public.search_student_directory(text, text, text) to authenticated, service_role;
grant execute on function public.student_directory_filters() to authenticated, service_role;
grant execute on function public.import_students(text, jsonb) to authenticated, service_role;
grant execute on function public.visible_teacher_ids() to authenticated, service_role;
grant execute on function public.list_assignable_staff() to authenticated, service_role;
grant execute on function public.exam_naming_conflict(text, text, text, text) to authenticated, service_role;
grant execute on function public.legacy_folder_exams() to authenticated, service_role;
grant execute on function public.owner_legacy_folders() to authenticated, service_role;
grant execute on function public.student_evidence_folder_ok(text) to authenticated, service_role;

notify pgrst, 'reload schema';
