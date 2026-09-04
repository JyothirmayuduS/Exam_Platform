-- Per-student paper snapshots + evaluator allocation.
--
-- 1. attempts.paper: the exact question set a student received (ordered
--    question ids, plus the shuffled option order when option shuffle is on).
--    Answers are keyed by DB question id, so grading reads the student's own
--    paper instead of the full pool.
-- 2. grading_delegations: exam-level columns so the Examiner dashboard can show
--    allocation status (evaluators, due date, report counts) per exam.

alter table public.attempts
  add column if not exists paper jsonb not null default '[]'::jsonb;

alter table public.grading_delegations
  add column if not exists exam_id      text references public.exams(id) on delete cascade,
  add column if not exists delegate_id  uuid,
  add column if not exists due_date     timestamptz,
  add column if not exists report_count int not null default 0;

create index if not exists grading_delegations_exam_idx
  on public.grading_delegations (exam_id);