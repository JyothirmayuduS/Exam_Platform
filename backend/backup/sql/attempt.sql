-- One attempt's result as JSON: score, answers and violations, with digests so
-- the restore check compares content, not just counts.
-- psql -Atq -v attempt_id=<uuid> -f attempt.sql
set timezone = 'UTC';

select jsonb_build_object(
         'id', a.id,
         'exam_id', a.exam_id,
         'roll', s.roll,
         'state', a.state,
         'status', a.status,
         'score', a.score,
         'percentage', a.percentage,
         'submitted_at', a.submitted_at,
         'answers', case jsonb_typeof(a.answers)
                      when 'object' then (select count(*) from jsonb_object_keys(a.answers))
                      when 'array' then jsonb_array_length(a.answers)
                      else 0 end,
         'answers_md5', md5(coalesce(a.answers::text, '')),
         'violations', (select count(*) from public.violation_events v where v.attempt_id::text = a.id::text),
         'violations_md5', (select md5(coalesce(string_agg(v.id::text || ':' || v.violation_type, ',' order by v.id::text), ''))
                              from public.violation_events v where v.attempt_id::text = a.id::text))
  from public.attempts a
  left join public.students s on s.id = a.student_id
 where a.id::text = :'attempt_id';
