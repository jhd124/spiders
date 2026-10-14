-- 024: JOBS expert rules (2026-10-14, batch 3).
-- job_posting.jd_too_short: 1 when the cleaned JD (whitespace removed) is shorter than JOBS_MIN_JD_CHARS (default 50).
--   Set by jobs:ingest / jobs:reclassify. Such postings are left out of skill-demand statistics (job_skill_demand view and
--   the occupation-skill comparison, jobs:compare) but still count in salary_stat.
ALTER TABLE job_posting ADD COLUMN jd_too_short INTEGER NOT NULL DEFAULT 0 CHECK (jd_too_short IN (0, 1));
UPDATE job_posting SET jd_too_short = CASE WHEN length(replace(replace(replace(replace(coalesce(jd_text, ''), ' ', ''), char(10), ''), char(13), ''), char(9), '')) < 50 THEN 1 ELSE 0 END;

DROP VIEW IF EXISTS job_skill_demand;
CREATE VIEW job_skill_demand AS
WITH base AS (
  SELECT p.id, p.occupation_code, coalesce(p.published_at, p.fetched_at) d FROM job_posting p
  WHERE p.occupation_code IS NOT NULL AND p.jd_too_short = 0
), occ AS (
  SELECT occupation_code, count(*) n, min(d) d_min, max(d) d_max FROM base GROUP BY occupation_code
)
SELECT b.occupation_code || ':' || k.skill_id AS id, b.occupation_code, o.name AS occupation_name, k.skill_id, sk.name AS skill_name,
  count(DISTINCT b.id) AS postings, occ.n AS occupation_postings, round(100.0 * count(DISTINCT b.id) / occ.n, 1) AS share_pct,
  substr(occ.d_min, 1, 10) AS sample_from, substr(occ.d_max, 1, 10) AS sample_to
FROM base b JOIN job_posting_skill k ON k.posting_id = b.id JOIN occ ON occ.occupation_code = b.occupation_code
LEFT JOIN occupation o ON o.code = b.occupation_code LEFT JOIN skill sk ON sk.id = k.skill_id
GROUP BY b.occupation_code, k.skill_id;
