-- Reconcile the students table with the schema the app expects, then seed
-- enough demo students across every batch that exams reference.
--
-- Problem found on this project: the students table predates the current
-- schema — it has branch/section (all null) but NO `batch` column, while
-- exams store a `batch` string like 'CSE — Sem IV' and every roster/email
-- flow filters students by that exact string (listStudentsByBatch). Result:
-- no exam ever had test-takers, "Enroll entire batch" showed zero students,
-- and publish-email counts were always 0.
--
-- This migration is safe to re-run (guarded adds + on-conflict no-op) and
-- never deletes data.

-- 1. The missing column.
alter table public.students add column if not exists batch text;

-- 2. Backfill the original seed students (supabase/seed.sql) to the batch all
--    of their exams use. Custom/unknown rows stay null and are untouched.
update public.students
set batch = 'CSE — Sem III · Sec A/B'
where roll in ('21VGN0142','21VGN0163','21VGN0221','21VGN0158','21VGN0171','21VGN0191');

-- 3. Demo students for every batch referenced by exams on this project.
insert into public.students (roll, full_name, email, batch) values
  ('21VGN0301', 'R. Vishnu Vardhan',  'vishnu.vardhan@vignan.edu',  'CSE — Sem IV'),
  ('21VGN0302', 'P. Ananya',          'ananya.p@vignan.edu',       'CSE — Sem IV'),
  ('21VGN0303', 'S. Karthik Reddy',   'karthik.reddy@vignan.edu',  'CSE — Sem IV'),
  ('21VGN0304', 'T. Meghana',         'meghana.t@vignan.edu',      'CSE — Sem IV'),
  ('21VGN0305', 'A. Siddharth',       'siddharth.a@vignan.edu',    'CSE — Sem V'),
  ('21VGN0306', 'K. Lakshmi Prasanna','lakshmi.prasanna@vignan.edu','CSE — Sem V'),
  ('21VGN0307', 'V. Harsha Vardhan',  'harsha.vardhan@vignan.edu', 'CSE — Sem V'),
  ('21VGN0308', 'M. Chandra Sekhar',  'chandra.sekhar@vignan.edu', 'ECE · Sem III'),
  ('21VGN0309', 'G. Navya Sri',       'navya.sri@vignan.edu',      'ECE · Sem III'),
  ('21VGN0310', 'D. Sravani',         'sravani.d@vignan.edu',      'CSE — Sem II'),
  ('21VGN0311', 'N. Pavan Kumar',     'pavan.kumar@vignan.edu',    'CSE — Sem II'),
  ('21VGN0312', 'B. Keerthana',       'keerthana.b@vignan.edu',    'CSE-SEM-III'),
  ('21VGN0313', 'J. Rakesh',          'rakesh.j@vignan.edu',       'CSE-SEM-III'),
  ('21VGN0314', 'S. Manasa',          'manasa.s@vignan.edu',       'CSE — Sec A'),
  ('21VGN0315', 'Ch. Vineeth',        'vineeth.ch@vignan.edu',     'CSE — Sec A'),
  ('21VGN0316', 'Y. Shravani',        'shravani.y@vignan.edu',     'CSE — Sec A'),
  ('21VGN0317', 'K. Venkata Rao',     'venkata.rao@vignan.edu',    'CSE — Sec A')
on conflict (roll) do nothing;

-- 4. Canonicalize seeded question rows: the old seed used lowercase
--    type/difficulty ('mcq' / 'medium'); the app and paper builder match the
--    capitalized forms ('MCQ' / 'Medium').
update public.questions
set type = case type
      when 'mcq'        then 'MCQ'
      when 'msq'        then 'MSQ'
      when 'subjective' then 'Subjective'
      when 'numerical'  then 'Numerical'
      when 'true/false' then 'True / False'
      when 'coding'     then 'Coding'
      else type
    end
where lower(type) in ('mcq','msq','subjective','numerical','true/false','coding');

update public.questions
set difficulty = initcap(difficulty)
where lower(difficulty) in ('easy','medium','hard');

-- 5. Enroll every student into each non-draft exam that targets their batch,
--    so scheduled/published tests have real test-takers immediately.
insert into public.enrollments (exam_id, student_id)
select distinct e.id, s.id
from public.exams e
join public.students s on s.batch = e.batch
where e.status <> 'draft'
  and s.batch is not null
on conflict (exam_id, student_id) do nothing;
