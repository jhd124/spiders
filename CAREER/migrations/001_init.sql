-- CAREER 001: initial schema (志愿填报 / 职业规划).
-- Portable SQL: runs on SQLite (current) and is written to also run on PostgreSQL:
--   * only TEXT / INTEGER / REAL types; booleans are INTEGER 0/1 with CHECK; timestamps are ISO-8601 TEXT (UTC)
--   * no AUTOINCREMENT / SERIAL: natural keys (MOE code, 大典 code) or TEXT ids built by the loader
--   * no SQLite-only syntax (no WITHOUT ROWID, no INSERT OR REPLACE in migrations)
-- Provenance columns on every data table:
--   source_url (official document the row comes from), source_doc_id -> source_document,
--   fetched_at, extraction_method ('pdf_parse' | 'llm' | 'manual' | 'expert'), confidence (0..1), reviewed (0/1).

CREATE TABLE source_document (
  id            TEXT PRIMARY KEY,           -- e.g. 'moe-major-catalog-2026'
  title         TEXT NOT NULL,
  publisher     TEXT,
  edition       TEXT,
  url           TEXT NOT NULL,              -- canonical URL of the document
  fetched_url   TEXT,                       -- URL actually downloaded (mirror host), if different
  notice_url    TEXT,                       -- announcement page that links the document
  is_official   INTEGER NOT NULL DEFAULT 1 CHECK (is_official IN (0, 1)),
  sha256        TEXT,
  bytes         INTEGER,
  fetched_at    TEXT,
  note          TEXT
);

/* ------------------------------------------------------------------ 专业 (MOE 本科专业目录) */

CREATE TABLE major_category (               -- 学科门类, e.g. 08 工学
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  catalog_edition INTEGER NOT NULL,
  source_url    TEXT NOT NULL,
  source_doc_id TEXT REFERENCES source_document(id),
  fetched_at    TEXT,
  extraction_method TEXT NOT NULL DEFAULT 'pdf_parse',
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);

CREATE TABLE major_class (                  -- 专业类, e.g. 0809 计算机类 (山东常按专业类招生)
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category_code TEXT NOT NULL REFERENCES major_category(code),
  status        TEXT NOT NULL DEFAULT '在目录' CHECK (status IN ('在目录', '已移出目录')),
  catalog_edition INTEGER NOT NULL,
  source_url    TEXT NOT NULL,
  source_doc_id TEXT REFERENCES source_document(id),
  source_page   INTEGER,
  fetched_at    TEXT,
  extraction_method TEXT NOT NULL DEFAULT 'pdf_parse',
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);

CREATE TABLE major (                        -- 专业, PK = code exactly as printed (e.g. 080904K)
  code            TEXT PRIMARY KEY,
  base_code       TEXT NOT NULL,            -- code without T/K suffix
  name            TEXT NOT NULL,
  category_code   TEXT NOT NULL REFERENCES major_category(code),
  category_name   TEXT NOT NULL,
  class_code      TEXT REFERENCES major_class(code),   -- NULL for 14 交叉学科 (no 专业类 level)
  class_name      TEXT,
  is_special      INTEGER NOT NULL CHECK (is_special IN (0, 1)),     -- T 特设专业
  is_controlled   INTEGER NOT NULL CHECK (is_controlled IN (0, 1)),  -- K 国家控制布点专业
  is_engineering  INTEGER NOT NULL CHECK (is_engineering IN (0, 1)), -- 门类 08 工学
  degree_categories TEXT NOT NULL,          -- 学位授予门类, '|'-separated, e.g. '工学|理学'
  degree_note     TEXT,                     -- raw （注：…） text from the catalog
  former_code     TEXT,                     -- 原专业代码 (from the note), e.g. 083204TK
  duration_years  TEXT,                     -- 修业年限: not listed in the catalog since 2020 -> NULL (see README)
  added_year      INTEGER,                  -- 增设年份: NULL unless an official 备案和审批结果 says so
  first_catalog_edition INTEGER,            -- first loaded catalog edition that lists this code (derived by diff)
  status          TEXT NOT NULL DEFAULT '在目录' CHECK (status IN ('在目录', '已移出目录')),
  catalog_edition INTEGER NOT NULL,         -- latest catalog edition that lists it
  source_url      TEXT NOT NULL,
  source_doc_id   TEXT REFERENCES source_document(id),
  source_page     INTEGER,
  fetched_at      TEXT,
  extraction_method TEXT NOT NULL DEFAULT 'pdf_parse',
  confidence      REAL,
  reviewed        INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  updated_at      TEXT NOT NULL
);
CREATE INDEX major_class_idx ON major(class_code);
CREATE INDEX major_category_idx ON major(category_code);

CREATE TABLE pilot_major (                  -- 专家选定的 25 个试点专业
  major_code    TEXT PRIMARY KEY REFERENCES major(code),
  sort_order    INTEGER NOT NULL,
  expected_name TEXT NOT NULL,              -- name as given by the expert (checked against major.name)
  source        TEXT NOT NULL               -- 'expert decision 2026-10-12'
);

/* ------------------------------------------------------------------ 职业 (职业分类大典 2022) */

CREATE TABLE occupation (                   -- 大类/中类/小类/细类; 细类 (level 4) = job anchor
  code          TEXT PRIMARY KEY,           -- '2', '2-02', '2-02-10', '2-02-10-01'
  level         INTEGER NOT NULL CHECK (level IN (1, 2, 3, 4)),
  level_name    TEXT NOT NULL CHECK (level_name IN ('大类', '中类', '小类', '细类')),
  name          TEXT NOT NULL,
  parent_code   TEXT REFERENCES occupation(code),
  gbm_code      TEXT,                       -- GB/T 6565 GBM code printed for levels 1-3, e.g. GBM20210
  is_digital    INTEGER NOT NULL DEFAULT 0 CHECK (is_digital IN (0, 1)),  -- S 数字职业
  is_green      INTEGER NOT NULL DEFAULT 0 CHECK (is_green IN (0, 1)),    -- L 绿色职业
  edition       TEXT NOT NULL,              -- '2022'
  source_batch  TEXT NOT NULL,              -- '大典2022' or e.g. '人社部新职业 2024-07'
  status        TEXT NOT NULL DEFAULT '有效' CHECK (status IN ('有效', '已取消')),
  source_url    TEXT NOT NULL,
  source_doc_id TEXT REFERENCES source_document(id),
  source_page   INTEGER,
  fetched_at    TEXT,
  extraction_method TEXT NOT NULL DEFAULT 'pdf_parse',
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  updated_at    TEXT NOT NULL
);
CREATE INDEX occupation_parent_idx ON occupation(parent_code);
CREATE INDEX occupation_level_idx ON occupation(level);

/* ------------------------------------------------------------------ 技能 (schema only; L1 seed in 002) */

CREATE TABLE skill_domain (                 -- 一级: 能力域 (~15-20)
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  sort_order    INTEGER,
  source        TEXT NOT NULL
);

CREATE TABLE skill (                        -- 二级: JD 粒度的具体技能 (target 300-500, no versions)
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,       -- canonical name, e.g. 'SolidWorks'
  domain_id     TEXT NOT NULL REFERENCES skill_domain(id),
  skill_type    TEXT NOT NULL CHECK (skill_type IN ('专业知识', '工具与技术', '通用能力')),
  description   TEXT,
  source        TEXT NOT NULL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);

CREATE TABLE skill_alias (                  -- 'SW', 'Solidworks' -> SolidWorks
  alias         TEXT PRIMARY KEY,           -- stored normalized (trimmed, lower-case)
  skill_id      TEXT NOT NULL REFERENCES skill(id),
  source        TEXT NOT NULL
);

/* ------------------------------------------------------------------ 院校 / 课程 (schema only) */

CREATE TABLE school (
  id            TEXT PRIMARY KEY,           -- MOE 学校标识码 when known, else 'name:<校名>'
  name          TEXT NOT NULL UNIQUE,
  moe_code      TEXT,                       -- 10-digit 学校标识码 (to be filled from MOE list)
  province      TEXT,
  pilot_tier    TEXT CHECK (pilot_tier IN ('省内', '省外头部', '省外中上', '省外行业特色校')),
  source        TEXT NOT NULL
);

CREATE TABLE course (
  id            TEXT PRIMARY KEY,           -- '<school_id>:<course code or name>'
  school_id     TEXT NOT NULL REFERENCES school(id),
  name          TEXT NOT NULL,
  course_code   TEXT,
  credits       REAL,
  hours         INTEGER,
  course_type   TEXT,                       -- 必修/选修/实践…
  description   TEXT,
  source_url    TEXT NOT NULL,
  fetched_at    TEXT,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);

CREATE TABLE major_course (                 -- 培养方案: school x major -> course
  school_id     TEXT NOT NULL REFERENCES school(id),
  major_code    TEXT NOT NULL REFERENCES major(code),
  course_id     TEXT NOT NULL REFERENCES course(id),
  plan_year     INTEGER,                    -- 培养方案版本年
  semester      TEXT,
  is_core       INTEGER CHECK (is_core IN (0, 1)),
  source_url    TEXT NOT NULL,
  fetched_at    TEXT,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  PRIMARY KEY (school_id, major_code, course_id)
);

CREATE TABLE course_skill (
  course_id     TEXT NOT NULL REFERENCES course(id),
  skill_id      TEXT NOT NULL REFERENCES skill(id),
  weight        REAL,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  PRIMARY KEY (course_id, skill_id)
);

CREATE TABLE major_skill (                  -- aggregated / expert-curated major -> skill
  major_code    TEXT NOT NULL REFERENCES major(code),
  skill_id      TEXT NOT NULL REFERENCES skill(id),
  weight        REAL,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  PRIMARY KEY (major_code, skill_id)
);

CREATE TABLE occupation_skill (             -- from JD statistics or expert
  occupation_code TEXT NOT NULL REFERENCES occupation(code),
  skill_id      TEXT NOT NULL REFERENCES skill(id),
  weight        REAL,                       -- e.g. share of postings mentioning the skill
  sample_size   INTEGER,
  period        TEXT,                       -- e.g. '2026Q3'
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  PRIMARY KEY (occupation_code, skill_id)
);

/* ------------------------------------------------------------------ 就业市场 (schema only) */

CREATE TABLE job_posting (                  -- public posting info only, no personal data
  id            TEXT PRIMARY KEY,           -- '<site>:<site posting id>'
  site          TEXT NOT NULL,              -- zhaopin / 51job / yingjiesheng / shixiseng / iguopin …
  channel       TEXT CHECK (channel IN ('社招', '校招', '实习')),
  title_raw     TEXT NOT NULL,
  company_raw   TEXT,
  city_raw      TEXT,
  salary_raw    TEXT,
  salary_min_month REAL,                    -- CNY / month, normalized
  salary_max_month REAL,
  salary_months REAL,                       -- e.g. 13 (13薪)
  education_raw TEXT,
  experience_raw TEXT,
  industry_raw  TEXT,
  jd_text       TEXT,
  occupation_code TEXT REFERENCES occupation(code),   -- normalized 细类
  occupation_confidence REAL,
  published_at  TEXT,
  source_url    TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);
CREATE INDEX job_posting_occ_idx ON job_posting(occupation_code);

CREATE TABLE salary_stat (                  -- quarterly aggregate per occupation x city
  occupation_code TEXT NOT NULL REFERENCES occupation(code),
  city          TEXT NOT NULL,              -- '全国' for national
  quarter       TEXT NOT NULL,              -- '2026Q3'
  channel       TEXT NOT NULL DEFAULT '全部',
  sample_size   INTEGER NOT NULL,
  p25_month     REAL,
  p50_month     REAL,
  p75_month     REAL,
  method_note   TEXT,
  computed_at   TEXT NOT NULL,
  PRIMARY KEY (occupation_code, city, quarter, channel)
);

CREATE TABLE employment_report (            -- 高校毕业生就业质量年度报告, per school x year (x college/major when given)
  id            TEXT PRIMARY KEY,           -- '<school_id>:<year>:<college>:<major or *>'
  school_id     TEXT NOT NULL REFERENCES school(id),
  year          INTEGER NOT NULL,           -- graduation year
  degree_level  TEXT NOT NULL DEFAULT '本科',
  college       TEXT,                       -- 所属学院 (NULL = whole school)
  major_code    TEXT REFERENCES major(code),
  major_name_raw TEXT,
  stat_scope    TEXT,                       -- 统计口径: 按学院/按专业; 是否含升学; 统计截止日期 …
  graduates     INTEGER,
  employment_rate REAL,                     -- as defined by stat_scope
  further_study_rate REAL,
  abroad_rate   REAL,
  avg_salary_month REAL,
  top_industries TEXT,                      -- JSON array
  top_employers TEXT,                       -- JSON array
  top_cities    TEXT,                       -- JSON array
  report_pdf_url TEXT NOT NULL,
  source_page   INTEGER,
  fetched_at    TEXT,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);

CREATE TABLE admission_rank (               -- 投档线, school x 专业(类) x year x province
  id            TEXT PRIMARY KEY,           -- '<province>:<year>:<school_id>:<group code>'
  province      TEXT NOT NULL,              -- '山东' first, then '浙江'
  year          INTEGER NOT NULL,
  batch         TEXT,                       -- 普通类一段 / 二段 …
  school_id     TEXT NOT NULL REFERENCES school(id),
  school_name_raw TEXT NOT NULL,
  major_code    TEXT REFERENCES major(code),          -- when the 志愿 maps to one 专业
  major_class_code TEXT REFERENCES major_class(code), -- when enrolled by 专业类 (e.g. 计算机类)
  program_name_raw TEXT NOT NULL,           -- 专业(类)名称 as published, incl. remarks
  subject_req   TEXT,                       -- 选科要求
  plan_count    INTEGER,
  min_score     INTEGER,
  min_rank      INTEGER,                    -- 最低位次 (from 一分一段表)
  source_url    TEXT NOT NULL,
  fetched_at    TEXT,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);
CREATE INDEX admission_rank_lookup ON admission_rank(province, year, major_code);
