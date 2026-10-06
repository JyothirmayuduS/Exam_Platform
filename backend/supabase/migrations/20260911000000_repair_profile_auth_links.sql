-- Repair student auth links: the pre-auth seed stored placeholder UUIDs
-- (11111111-…, 22222222-…, …) in students.auth_id. When real Supabase Auth
-- accounts were provisioned (0006) the link step guarded on "auth_id is null",
-- so placeholder links were never replaced and role-scoped RLS resolved those
-- students to nothing. This rewrites auth_id to the real account whose email is
-- <roll>@student.vignan.ac.in, for any row whose current auth_id is missing,
-- placeholder-shaped, or dangling (points at no auth.users row).

update public.students s
set auth_id = u.id
from auth.users u
where u.email = lower(btrim(s.roll)) || '@student.vignan.ac.in'
  and (
    s.auth_id is null
    or not exists (select 1 from auth.users au where au.id = s.auth_id)
    or s.auth_id::text like '00000000-0000-0000-0000-00000000000%'
  );

-- Same repair for teachers/proctors whose auth_id is placeholder-shaped.
update public.teachers t
set auth_id = u.id
from auth.users u
where u.email = lower(btrim(t.email))
  and (
    t.auth_id is null
    or not exists (select 1 from auth.users au where au.id = t.auth_id)
    or t.auth_id::text like '00000000-0000-0000-0000-00000000000%'
  );
