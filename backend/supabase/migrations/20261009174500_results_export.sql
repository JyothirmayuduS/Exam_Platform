-- Results export for the university ERP.
--  * result_holds: an attempt a teacher withheld for malpractice review. The
--    export lists the student as withheld, without marks, until it is cleared.
--  * staff_admins: staff who may export any exam or programme. Rows are added
--    by a database administrator; nobody can add themselves from the app.

create table if not exists public.result_holds (
  attempt_id  uuid primary key references public.attempts(id) on delete cascade,
  exam_id     text not null references public.exams(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  reason      text,
  held_by     uuid not null,
  held_at     timestamptz not null default now()
);
create index if not exists result_holds_exam_idx on public.result_holds (exam_id);

create table if not exists public.staff_admins (
  auth_id   uuid primary key,
  added_at  timestamptz not null default now()
);

alter table public.result_holds enable row level security;
alter table public.staff_admins enable row level security;
revoke all on public.result_holds, public.staff_admins from anon, authenticated;

-- Staff see holds (evaluation screen); changes go through set_result_hold.
grant select on public.result_holds to authenticated;
drop policy if exists "result holds staff read" on public.result_holds;
create policy "result holds staff read" on public.result_holds
  for select to authenticated using ((select public.auth_is_staff()));

create or replace function public.auth_is_staff_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.auth_is_teacher()
     and exists (select 1 from public.staff_admins a where a.auth_id = auth.uid());
$$;
revoke all on function public.auth_is_staff_admin() from public, anon;
grant execute on function public.auth_is_staff_admin() to authenticated;

-- Withhold or release one attempt. Only the exam's teacher or an admin.
create or replace function public.set_result_hold(p_attempt uuid, p_hold boolean, p_reason text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
begin
  select id, exam_id, student_id, state into a from public.attempts where id = p_attempt;
  if not found then
    return 'not_found';
  end if;
  if not (public.owns_exam(a.exam_id) or public.auth_is_staff_admin()) then
    return 'forbidden';
  end if;
  if p_hold then
    insert into public.result_holds (attempt_id, exam_id, student_id, reason, held_by)
    values (a.id, a.exam_id, a.student_id, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
    on conflict (attempt_id) do update
      set reason = excluded.reason, held_by = excluded.held_by, held_at = now();
  else
    delete from public.result_holds where attempt_id = a.id;
    if not found then
      return 'ok';
    end if;
  end if;
  insert into public.audit_logs (actor_id, actor_role, action, target_type, target_id, meta)
  values (auth.uid(), 'teacher', case when p_hold then 'result.withheld' else 'result.released_from_hold' end,
          'attempt', a.id::text,
          jsonb_build_object('exam_id', a.exam_id, 'student_id', a.student_id, 'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  return 'ok';
end;
$$;
revoke all on function public.set_result_hold(uuid, boolean, text) from public, anon;
grant execute on function public.set_result_hold(uuid, boolean, text) to authenticated;
