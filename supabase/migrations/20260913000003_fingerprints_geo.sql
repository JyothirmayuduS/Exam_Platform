CREATE TABLE IF NOT EXISTS exam_fingerprints (
  exam_id uuid REFERENCES examinations(id) ON DELETE CASCADE,
  student_id uuid REFERENCES students(id) ON DELETE CASCADE,
  fingerprint_hash text,
  ip_address inet,
  geo_country text,
  geo_city text,
  geo_lat numeric,
  geo_lng numeric,
  timezone text,
  captured_at timestamptz DEFAULT now(),
  PRIMARY KEY (exam_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_geo ON exam_fingerprints(geo_country);
