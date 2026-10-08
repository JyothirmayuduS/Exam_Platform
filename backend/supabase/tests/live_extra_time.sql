-- Live extra time: the owning teacher can add minutes to an in-progress
-- attempt, a proctor (or a teacher who does not own the exam) cannot, and the
-- student's server-side time left grows by exactly the minutes added.
--
-- Run against a database with the seeded accounts (SQL editor or psql as the
-- postgres role). Everything happens in one transaction and is rolled back;
-- a failed check raises an exception naming it.
begin;

do $$
declare
  c_teacher constant uuid := '95ad7d05-b7ad-4cec-a526-0cc5607efa90';
  c_proctor constant uuid := '00c7e015-117a-440a-aacb-23f3d2737ba4';
  c_student_auth constant uuid := 'e689f72b-118f-4621-a86f-9cfc7b0dbaf7';
  c_student constant uuid := '65b6af64-9c0f-4dca-9476-cf4bdb9ead0e';
  v_exam text := 'TEST-LIVE-EXTRA-' || substr(md5(random()::text), 1, 8);
  v_other_exam text := v_exam || '-OTHER';
  v_att uuid;
  v_other_att uuid;
  v_before integer;
  v_after integer;
  v_extra integer;
  v_denied boolean;
  v_logs integer;
begin
  -- Setup as postgres: an exam owned by the teacher, one owned by someone
  -- else, and a live attempt on each (started 10 minutes ago, 60-minute exam).
  insert into public.exams (id, name, batch, status, duration_minutes, created_by)
  values (v_exam, 'Live extra time test', 'TEST-NO-STUDENTS', 'published', 60, c_teacher),
         (v_other_exam, 'Not owned by the teacher', 'TEST-NO-STUDENTS', 'published', 60, c_proctor);
  insert into public.attempts (exam_id, student_id, state, started_at, total, answers)
  values (v_exam, c_student, 'in_progress', now() - interval '10 minutes', 1, '{}')
  returning id into v_att;
  insert into public.attempts (exam_id, student_id, state, started_at, total, answers)
  values (v_other_exam, c_student, 'in_progress', now() - interval '10 minutes', 1, '{}')
  returning id into v_other_att;

  -- Student: time left before.
  perform set_config('request.jwt.claims', json_build_object('sub', c_student_auth, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_before := public.attempt_time_left(v_exam);
  execute 'reset role';
  if v_before is null or v_before <> 50 * 60 then
    raise exception 'FAIL setup: expected 3000 s left, got %', v_before;
  end if;

  -- Proctor: the function refuses, and a direct update does not stick.
  perform set_config('request.jwt.claims', json_build_object('sub', c_proctor, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_denied := false;
  begin
    perform public.add_attempt_extra_minutes(v_att, 7);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  update public.attempts set extra_minutes = 99 where id = v_att;
  execute 'reset role';
  if not v_denied then
    raise exception 'FAIL: proctor was allowed to add extra minutes';
  end if;
  if (select extra_minutes from public.attempts where id = v_att) <> 0 then
    raise exception 'FAIL: proctor changed extra_minutes with a direct update';
  end if;

  -- Teacher who does not own the exam: refused.
  perform set_config('request.jwt.claims', json_build_object('sub', c_teacher, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_denied := false;
  begin
    perform public.add_attempt_extra_minutes(v_other_att, 7);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  -- Owning teacher: a direct update does not stick either; the function works.
  update public.attempts set extra_minutes = 99 where id = v_att;
  select r.extra_minutes into v_extra from public.add_attempt_extra_minutes(v_att, 7) r;
  execute 'reset role';
  if not v_denied then
    raise exception 'FAIL: a teacher who does not own the exam added extra minutes';
  end if;
  if v_extra <> 7 then
    raise exception 'FAIL: expected 7 extra minutes, got %', v_extra;
  end if;

  -- Student: time left grew by exactly 7 minutes (now() is fixed in a transaction).
  perform set_config('request.jwt.claims', json_build_object('sub', c_student_auth, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_after := public.attempt_time_left(v_exam);
  execute 'reset role';
  if v_after - v_before <> 7 * 60 then
    raise exception 'FAIL: time left grew by % s, expected 420 s', v_after - v_before;
  end if;

  -- Audit: who, how many, when.
  select count(*) into v_logs from public.audit_logs
  where action = 'attempt.time_extended' and target_id = v_att::text
    and actor_id = c_teacher and actor_role = 'teacher'
    and (meta->>'minutes')::int = 7 and created_at = now();
  if v_logs <> 1 then
    raise exception 'FAIL: expected one audit row for the teacher adding 7 minutes, found %', v_logs;
  end if;

  raise notice 'PASS live extra time: owner +7 min -> % s to % s; proctor and non-owner refused', v_before, v_after;
end;
$$;

rollback;
