-- 022: JOBS expert rules (2026-10-14).
-- job_posting: + multi_role (title lists several roles: unclassified, never in salary stats, skills still extracted)
--              + classify_reason (rule / first_role / multi_role / generic / excluded_word / mgmt_trainee / design / not_tech / no_match).
-- salary_stat conventions (no key change):
--   * quarter = '2026Q3'         -> one quarter (only quarters inside the salary window are kept)
--   * quarter = '2024Q4-2026Q4'  -> the whole salary window (default 24 months); the default display level
--   * sample_size < min sample (default 30) -> row kept with count only, p25/p50/p75 NULL
-- Views for the admin console: salary_overview (window x 全国 x 全部渠道: occupation x education)
--   and job_skill_demand (all years, with the sample's published date range).
ALTER TABLE job_posting ADD COLUMN multi_role INTEGER NOT NULL DEFAULT 0 CHECK (multi_role IN (0, 1));
ALTER TABLE job_posting ADD COLUMN classify_reason TEXT;

CREATE VIEW salary_overview AS
SELECT s.occupation_code || ':' || s.education AS id, s.occupation_code, o.name AS occupation_name, s.education,
  s.quarter AS window, s.sample_size, s.p25_month, s.p50_month, s.p75_month, s.method_note, s.computed_at
FROM salary_stat s LEFT JOIN occupation o ON o.code = s.occupation_code
WHERE s.city = '全国' AND s.channel = '全部' AND s.quarter LIKE '%-%';

CREATE VIEW job_skill_demand AS
WITH base AS (
  SELECT p.id, p.occupation_code, coalesce(p.published_at, p.fetched_at) d FROM job_posting p WHERE p.occupation_code IS NOT NULL
), occ AS (
  SELECT occupation_code, count(*) n, min(d) d_min, max(d) d_max FROM base GROUP BY occupation_code
)
SELECT b.occupation_code || ':' || k.skill_id AS id, b.occupation_code, o.name AS occupation_name, k.skill_id, sk.name AS skill_name,
  count(DISTINCT b.id) AS postings, occ.n AS occupation_postings, round(100.0 * count(DISTINCT b.id) / occ.n, 1) AS share_pct,
  substr(occ.d_min, 1, 10) AS sample_from, substr(occ.d_max, 1, 10) AS sample_to
FROM base b JOIN job_posting_skill k ON k.posting_id = b.id JOIN occ ON occ.occupation_code = b.occupation_code
LEFT JOIN occupation o ON o.code = b.occupation_code LEFT JOIN skill sk ON sk.id = k.skill_id
GROUP BY b.occupation_code, k.skill_id;
