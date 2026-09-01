-- Vignan OS — demo seed data.
-- Run AFTER schema.sql. Safe to re-run (upserts / on-conflict do-nothing/update).
--
-- This gives you the core flow: teacher-published exams that enrolled students
-- can see, each with a full question set. RLS ties visibility to auth.uid();
-- for a quick demo with no auth yet, see the "DEMO MODE" note at the bottom to
-- temporarily open the read policies.

-- ── Students ─────────────────────────────────────────────────────────────────
insert into public.students (id, roll, full_name, email, batch) values
  ('11111111-1111-1111-1111-111111111111', '21VGN0142', 'B. Priya Nikitha', 'priya.nikitha@vignan.edu', 'CSE — Sem III · Sec A/B'),
  ('22222222-2222-2222-2222-222222222222', '21VGN0163', 'M. Sai Charan',    'sai.charan@vignan.edu',   'CSE — Sem III · Sec A/B'),
  ('33333333-3333-3333-3333-333333333333', '21VGN0221', 'L. Sneha',         'sneha.l@vignan.edu',      'CSE — Sem III · Sec A/B'),
  ('44444444-4444-4444-4444-444444444444', '21VGN0158', 'K. Rohan Teja',    'rohan.teja@vignan.edu',   'CSE — Sem III · Sec A/B'),
  ('55555555-5555-5555-5555-555555555555', '21VGN0171', 'A. Deepika Reddy', 'deepika.reddy@vignan.edu','CSE — Sem III · Sec A/B'),
  ('66666666-6666-6666-6666-666666666666', '21VGN0191', 'N. Harika Sree',   'harika.sree@vignan.edu',  'CSE — Sem III · Sec A/B')
on conflict (roll) do nothing;

-- ── Exams ────────────────────────────────────────────────────────────────────
-- EXAM-2026-014 is the live/published demo exam every other screen references.
insert into public.exams
  (id, name, batch, mode, status, duration_minutes, per_student, pool_count, total_marks, scheduled_at, join_link)
values
  ('EXAM-2026-014', 'Data Structures & Algorithms', 'CSE — Sem III · Sec A/B', 'lockdown', 'published', 45, 7, 20, 70,
     now() + interval '1 hour',  '/student/exam'),
  ('EXAM-2026-017', 'Operating Systems',            'CSE — Sem IV',            'lockdown', 'published', 60, 6, 18, 60,
     now() + interval '2 hours', '/student/exam'),
  ('EXAM-2026-018', 'Computer Networks',            'CSE — Sem V',             'lockdown', 'scheduled', 60, 5, 15, 50,
     now() + interval '3 days',  '/student/exam'),
  ('EXAM-2026-021', 'Digital Electronics',          'ECE · Sem III',           'lockdown', 'draft',     60, 5, 15, 50,
     now() + interval '5 days',  null),
  ('EXAM-2026-019', 'Discrete Mathematics',         'CSE — Sem II',            'practice', 'draft',     45, 5, 12, 40,
     null, null)
on conflict (id) do update
  set status = excluded.status, name = excluded.name, batch = excluded.batch,
      duration_minutes = excluded.duration_minutes, per_student = excluded.per_student,
      pool_count = excluded.pool_count, total_marks = excluded.total_marks,
      scheduled_at = excluded.scheduled_at, join_link = excluded.join_link;

-- ── Questions: Data Structures & Algorithms (EXAM-2026-014) ──────────────────
insert into public.questions (id, exam_id, title, type, unit, difficulty, marks, options, answer) values
  ('Q-1042', 'EXAM-2026-014', 'What is the average-case time complexity of a balanced BST search?',
     'mcq', 'Trees', 'medium', 10, '["O(1)","O(log n)","O(n)","O(n log n)"]'::jsonb, 'O(log n)'),
  ('Q-1043', 'EXAM-2026-014', 'Which data structure uses FIFO ordering?',
     'mcq', 'Linear', 'easy', 10, '["Stack","Queue","Tree","Graph"]'::jsonb, 'Queue'),
  ('Q-1044', 'EXAM-2026-014', 'Explain how a hash collision is resolved with chaining.',
     'subjective', 'Hashing', 'hard', 20, null, null),
  ('Q-1047', 'EXAM-2026-014', 'What is the worst-case time complexity of quicksort?',
     'mcq', 'Sorting', 'medium', 10, '["O(n)","O(n log n)","O(n^2)","O(log n)"]'::jsonb, 'O(n^2)'),
  ('Q-1048', 'EXAM-2026-014', 'A complete binary tree of height h has at most how many nodes?',
     'numerical', 'Trees', 'hard', 10, null, '2^(h+1) - 1'),
  ('Q-1050', 'EXAM-2026-014', 'Which traversal visits the root between the left and right subtrees?',
     'mcq', 'Trees', 'easy', 10, '["Preorder","Inorder","Postorder","Level order"]'::jsonb, 'Inorder')
on conflict (id) do update
  set title = excluded.title, type = excluded.type, unit = excluded.unit,
      difficulty = excluded.difficulty, marks = excluded.marks,
      options = excluded.options, answer = excluded.answer;

-- ── Questions: Operating Systems (EXAM-2026-017) ─────────────────────────────
insert into public.questions (id, exam_id, title, type, unit, difficulty, marks, options, answer) values
  ('Q-2001', 'EXAM-2026-017', 'Which scheduling algorithm can cause starvation of low-priority processes?',
     'mcq', 'Scheduling', 'medium', 10, '["Round Robin","FCFS","Priority","Shortest Job First"]'::jsonb, 'Priority'),
  ('Q-2002', 'EXAM-2026-017', 'A page fault occurs when the requested page is not present in ___.',
     'mcq', 'Memory', 'easy', 10, '["Cache","Main memory","Disk","Register"]'::jsonb, 'Main memory'),
  ('Q-2003', 'EXAM-2026-017', 'Compute the average waiting time for the given round-robin schedule (quantum = 4).',
     'numerical', 'Scheduling', 'hard', 20, null, null),
  ('Q-2004', 'EXAM-2026-017', 'Describe the four Coffman conditions required for deadlock.',
     'subjective', 'Concurrency', 'hard', 20, null, null)
on conflict (id) do update
  set title = excluded.title, type = excluded.type, unit = excluded.unit,
      difficulty = excluded.difficulty, marks = excluded.marks,
      options = excluded.options, answer = excluded.answer;

-- ── Enrollments (who each published exam is assigned to) ─────────────────────
insert into public.enrollments (exam_id, student_id) values
  ('EXAM-2026-014', '11111111-1111-1111-1111-111111111111'),
  ('EXAM-2026-014', '22222222-2222-2222-2222-222222222222'),
  ('EXAM-2026-014', '33333333-3333-3333-3333-333333333333'),
  ('EXAM-2026-014', '44444444-4444-4444-4444-444444444444'),
  ('EXAM-2026-014', '55555555-5555-5555-5555-555555555555'),
  ('EXAM-2026-014', '66666666-6666-6666-6666-666666666666'),
  ('EXAM-2026-017', '11111111-1111-1111-1111-111111111111'),
  ('EXAM-2026-017', '22222222-2222-2222-2222-222222222222')
on conflict do nothing;

-- ── DEMO MODE (no auth wired yet) ────────────────────────────────────────────
-- The default policy only shows exams to signed-in students of the matching
-- batch. Until you set up auth + link students.auth_id, run this ONCE so the
-- published exams are visible with just the anon key:
--
--   drop policy if exists "read live exams" on public.exams;
--   create policy "read live exams (demo)" on public.exams
--     for select using (status <> 'draft');
--
--   drop policy if exists "students read self" on public.students;
--   create policy "students read (demo)" on public.students for select using (true);
--
-- Revert to the auth-scoped policies in schema.sql before going to production.
