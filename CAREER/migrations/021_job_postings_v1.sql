-- 021: job postings v1 (JOBS group, public sources only).
-- job_posting: + normalized city / education / experience, salary method note, search keyword, dedupe key, raw record,
--   last_seen_at, skills_extracted_at; extraction_method also allows 'api' / 'html_parse' (structured public listings).
-- job_posting_skill: JD -> skill tags (alias/term match first, LLM fallback only on the server).
-- salary_stat: + education dimension ('全部' = all) in the primary key.
-- Both tables were empty before 021; rows are copied anyway so the rebuild is safe on any DB.
CREATE TABLE job_posting_new (                -- public posting info only, no personal data
  id            TEXT PRIMARY KEY,           -- '<site>:<site posting id>'
  site          TEXT NOT NULL,
  channel       TEXT CHECK (channel IN ('社招', '校招', '实习')),
  title_raw     TEXT NOT NULL,
  company_raw   TEXT,
  city_raw      TEXT,
  city          TEXT,                       -- normalized city, e.g. '青岛' (直辖市 '北京')
  salary_raw    TEXT,
  salary_min_month REAL,                    -- CNY / month, normalized (base monthly, before 13薪 etc.)
  salary_max_month REAL,
  salary_months REAL,                       -- e.g. 13 (13薪); NULL = 12
  salary_note   TEXT,                       -- how salary_raw was normalized
  education_raw TEXT,
  education     TEXT CHECK (education IN ('不限', '大专', '本科', '硕士', '博士')),  -- minimum accepted
  experience_raw TEXT,
  experience_min_years REAL,                -- 0 = 应届/不限
  industry_raw  TEXT,
  jd_text       TEXT,
  occupation_code TEXT REFERENCES occupation(code),   -- normalized 细类
  occupation_confidence REAL,
  search_keyword TEXT,                      -- crawl keyword that found it
  dedupe_key    TEXT,                       -- sha1(company|title|city|salary) to collapse reposts across keywords/sites
  raw_json      TEXT,                       -- the public record as fetched
  published_at  TEXT,
  source_url    TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  skills_extracted_at TEXT,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert', 'api', 'html_parse')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);
INSERT INTO job_posting_new (id, site, channel, title_raw, company_raw, city_raw, salary_raw, salary_min_month, salary_max_month, salary_months,
  education_raw, experience_raw, industry_raw, jd_text, occupation_code, occupation_confidence, published_at, source_url, fetched_at,
  extraction_method, confidence, reviewed)
SELECT id, site, channel, title_raw, company_raw, city_raw, salary_raw, salary_min_month, salary_max_month, salary_months,
  education_raw, experience_raw, industry_raw, jd_text, occupation_code, occupation_confidence, published_at, source_url, fetched_at,
  extraction_method, confidence, reviewed FROM job_posting;
DROP TABLE job_posting;
ALTER TABLE job_posting_new RENAME TO job_posting;
CREATE INDEX job_posting_occ_idx ON job_posting(occupation_code);
CREATE INDEX job_posting_dedupe_idx ON job_posting(dedupe_key);
CREATE INDEX job_posting_city_idx ON job_posting(city);

CREATE TABLE job_posting_skill (
  posting_id    TEXT NOT NULL REFERENCES job_posting(id) ON DELETE CASCADE,
  skill_id      TEXT NOT NULL REFERENCES skill(id),
  method        TEXT NOT NULL CHECK (method IN ('alias', 'llm')),
  matched_text  TEXT,                       -- the term found in the JD (alias) or the model's quote (llm)
  confidence    REAL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (posting_id, skill_id)
);
CREATE INDEX job_posting_skill_skill_idx ON job_posting_skill(skill_id);

CREATE TABLE salary_stat_new (               -- quarterly aggregate per occupation x city (x channel x education)
  occupation_code TEXT NOT NULL REFERENCES occupation(code),
  city          TEXT NOT NULL,              -- '全国' for national
  quarter       TEXT NOT NULL,              -- '2026Q3'
  channel       TEXT NOT NULL DEFAULT '全部',
  education     TEXT NOT NULL DEFAULT '全部',
  sample_size   INTEGER NOT NULL,
  p25_month     REAL,
  p50_month     REAL,
  p75_month     REAL,
  method_note   TEXT,
  computed_at   TEXT NOT NULL,
  PRIMARY KEY (occupation_code, city, quarter, channel, education)
);
INSERT INTO salary_stat_new (occupation_code, city, quarter, channel, sample_size, p25_month, p50_month, p75_month, method_note, computed_at)
SELECT occupation_code, city, quarter, channel, sample_size, p25_month, p50_month, p75_month, method_note, computed_at FROM salary_stat;
DROP TABLE salary_stat;
ALTER TABLE salary_stat_new RENAME TO salary_stat;
