CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  branding_json jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);
-- Try both possible table names for exam records
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'examinations') THEN
    ALTER TABLE examinations ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE SET NULL;
  ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'exams') THEN
    ALTER TABLE exams ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE SET NULL;
  ELSE
    -- Create exam table if truly missing (initial setup missing)
    CREATE TABLE exams (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text,
      org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
      created_at timestamptz DEFAULT now()
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_exams_org ON exams(org_id);
