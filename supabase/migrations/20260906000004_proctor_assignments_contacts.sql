-- Proctor selection gets real:
--   • proctor_assignments now carries assignee_id (teachers.id) + email so the
--     teacher can email assigned proctors and a proctor can find "my exams".
--   • A proctor (teacher row with role 'proctor') that is assigned to an exam
--     gains RLS read access to that exam, its attempts, violation events, and
--     messages/broadcasts so the proctor console is fully DB-backed.
--   • violation_events.source learns 'teacher' (teacher console actions).

-- ─────────────────────────────────────────────────────────────────────────────
-- Columns
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.proctor_assignments
  add column if not exists assignee_id uuid references public.teachers(id) on delete set null,
  add column if not exists email text;

create index if not exists proctor_assignments_assignee_idx
  on public.proctor_assignments (assignee_id, exam_id);

-- The `violation_events` table may predate this project's schema (legacy shape:
-- no `source`/`offset_seconds`/`snapshot_key`, severity default 'medium').
-- Teaching `source` the value 'teacher' is done idempotently by migration
-- 20260906000007_violation_events_normalize.sql, which runs right after this
-- one — keep that concern in a single place.

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: an assigned proctor can read what they need and act on it.
-- Subquery helper repeated inline (Postgres policies can't call functions that
-- query the same table safely) — this mirrors the "teachers own" style.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists "proctors read own assignments"      on public.proctor_assignments;
drop policy if exists "proctors read assigned exams"       on public.exams;
drop policy if exists "proctors read assigned attempts"    on public.attempts;
drop policy if exists "proctors manage assigned violations" on public.violation_events;
drop policy if exists "proctors manage assigned messages"  on public.proctor_messages;

create policy "proctors read own assignments" on public.proctor_assignments
  for select using (
    assignee_id in (select id from public.teachers where auth_id = auth.uid())
  );

create policy "proctors read assigned exams" on public.exams
  for select using (
    id in (select exam_id from public.proctor_assignments
           where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  );

create policy "proctors read assigned attempts" on public.attempts
  for select using (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  );

create policy "proctors manage assigned violations" on public.violation_events
  for all using (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  ) with check (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  );

create policy "proctors manage assigned messages" on public.proctor_messages
  for all using (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  ) with check (
    exam_id in (select exam_id from public.proctor_assignments
                where assignee_id in (select id from public.teachers where auth_id = auth.uid()))
  );
