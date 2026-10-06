-- audit_logs.actor_role defaulted to 'staff' but the check constraint only
-- allowed teacher/proctor/system — any insert without an explicit role failed.
-- Align the default with the constraint by accepting the generic role too.
alter table public.audit_logs
  drop constraint if exists audit_logs_actor_role_check;

alter table public.audit_logs
  add constraint audit_logs_actor_role_check
  check (actor_role in ('teacher', 'proctor', 'system', 'staff'));
