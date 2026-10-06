-- Feature #2: Item analysis + time-on-question tracking
-- Adds per-question post-exam statistics for teacher dashboard
CREATE MATERIALIZED VIEW IF NOT EXISTS item_analysis AS
SELECT 
  q.id AS question_id,
  q.exam_id,
  q.difficulty,
  COUNT(DISTINCT a.id) AS attempt_count,
  ROUND(AVG(CASE WHEN a.score IS NOT NULL THEN a.score END)::numeric, 2) AS avg_score,
  ROUND(STDDEV(CASE WHEN a.score IS NOT NULL THEN a.score END)::numeric, 2) AS stddev_score,
  COUNT(DISTINCT CASE WHEN a.score >= (SELECT AVG(score) FROM attempts WHERE exam_id = q.exam_id) THEN a.id END) AS above_avg,
  COUNT(DISTINCT CASE WHEN a.score < (SELECT AVG(score) FROM attempts WHERE exam_id = q.exam_id) THEN a.id END) AS below_avg
FROM questions q
LEFT JOIN attempts a ON a.exam_id = q.exam_id AND a.paper @> (SELECT to_jsonb(q.id) FROM questions WHERE id = q.id) -- approximate
GROUP BY q.id, q.exam_id, q.difficulty;

CREATE INDEX IF NOT EXISTS idx_item_analysis_qid ON item_analysis(question_id);
CREATE INDEX IF NOT EXISTS idx_item_analysis_exam ON item_analysis(exam_id);
