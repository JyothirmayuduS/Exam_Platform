-- Vignan OS — Repair raw-inserted auth.users rows for GoTrue compatibility
-- ─────────────────────────────────────────────────────────────────────────────
-- GoTrue returns "500: Database error querying schema" when manual SQL inserts
-- leave varchar/text columns NULL where the Auth service expects '' (empty
-- string). The exact column set varies by Supabase Auth version, so this walks
-- the live information_schema and resets every nullable, default-less string
-- column on auth.users from NULL to '' (never touching values that already
-- exist). Safe to run repeatedly; does not touch passwords, identities, email,
-- phone or linked profiles.

do $$
declare
  c record;
begin
  for c in
    select column_name
    from information_schema.columns
    where table_schema = 'auth'
      and table_name = 'users'
      and data_type in ('character varying', 'text')
      and is_nullable = 'YES'
      and column_default is null
    order by ordinal_position
  loop
    execute format(
      'update auth.users set %I = '''' where %I is null',
      c.column_name, c.column_name
    );
  end loop;
end $$;
