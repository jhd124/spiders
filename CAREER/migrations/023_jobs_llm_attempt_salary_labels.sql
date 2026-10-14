-- 023: JOBS fixes (expert 2026-10-14).
-- job_posting.llm_attempted_at: when the LLM fallback last ran on the posting. skills_extracted_at now only means
--   "term pass done"; postings with zero skills and llm_attempted_at NULL are (re)sent to the LLM under --llm.
-- salary_stat: city '全部' replaces '全国' (the sample is one campus job board, not national data);
--   + source_label ('来源：…，2024Q4–2026Q4，样本 N 条'), + low_sample (sample_size < JOBS_LOW_SAMPLE, default 100).
--   A 校招 row identical to its 全部 row (source is campus-only) is not stored; only 全部 is kept.
ALTER TABLE job_posting ADD COLUMN llm_attempted_at TEXT;
ALTER TABLE salary_stat ADD COLUMN source_label TEXT;
ALTER TABLE salary_stat ADD COLUMN low_sample INTEGER NOT NULL DEFAULT 0 CHECK (low_sample IN (0, 1));
UPDATE salary_stat SET city = '全部' WHERE city = '全国';

DROP VIEW IF EXISTS salary_overview;
CREATE VIEW salary_overview AS
SELECT s.occupation_code || ':' || s.education AS id, s.occupation_code, o.name AS occupation_name, s.education,
  s.quarter AS window, s.sample_size, s.p25_month, s.p50_month, s.p75_month, s.source_label,
  CASE WHEN s.low_sample = 1 THEN '样本较少，仅供参考' ELSE '' END AS sample_note, s.low_sample,
  s.method_note, s.computed_at
FROM salary_stat s LEFT JOIN occupation o ON o.code = s.occupation_code
WHERE s.city = '全部' AND s.channel = '全部' AND s.quarter LIKE '%-%';
