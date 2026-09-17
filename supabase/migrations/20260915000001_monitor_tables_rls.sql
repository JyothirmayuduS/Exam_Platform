-- Audit fix: two tables were created without Row Level Security.
--
--   exam_fingerprints — stores student IP addresses and geo-coordinates (PII).
--     Without RLS any authenticated client could read every student's IP/geo.
--   organizations — low sensitivity, but consistent with platform policy that
--     every table has RLS enabled with explicit grants.
--
-- Platform pattern (matches 20260910000006_auth_provision_and_production_rls.sql):
--   students see nothing here; staff sees everything; writes are service-role only.

ALTER TABLE public.exam_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- exam_fingerprints: staff-only read; no client write policies (service role bypasses RLS).
CREATE POLICY "Staff read exam fingerprints"
  ON public.exam_fingerprints
  FOR SELECT
  TO authenticated
  USING (public.auth_is_staff());

-- organizations: authenticated users may read the registry (needed for branding);
-- no client write policies.
CREATE POLICY "Authenticated read organizations"
  ON public.organizations
  FOR SELECT
  TO authenticated
  USING (true);
