-- GWY: civil-service exam (公务员考试) notices, positions (职位表) and position -> MOE major mapping.
CREATE TABLE IF NOT EXISTS gwy_notice (
  id            TEXT PRIMARY KEY,              -- e.g. gk2027 (国考 2027年度), sd2027 (山东省考)
  year          INTEGER NOT NULL,              -- 年度 as printed (国考 2027年度 is held in 2026)
  exam_type     TEXT NOT NULL CHECK (exam_type IN ('国考', '省考')),
  province      TEXT,                          -- NULL for 国考
  title         TEXT NOT NULL,
  url           TEXT NOT NULL,                 -- official page
  text_source_url TEXT,                        -- where the notice text was read (official or official repost)
  age_text      TEXT,                          -- age clause verbatim
  age_min       INTEGER,
  age_max       INTEGER,
  age_max_relaxed INTEGER,                     -- e.g. 应届硕士/博士 43
  age_relaxed_for TEXT,
  published     TEXT,                          -- YYYY-MM-DD
  positions_file TEXT,                         -- imported 职位表 file name
  positions_sha256 TEXT,
  imported_at   TEXT
);

CREATE TABLE IF NOT EXISTS gwy_position (
  notice_id     TEXT NOT NULL REFERENCES gwy_notice(id),
  dept_code     TEXT NOT NULL,                 -- 部门代码
  position_code TEXT NOT NULL,                 -- 职位代码
  sheet         TEXT NOT NULL,                 -- sheet name (e.g. 中央国家行政机关省级以下直属机构)
  row_no        INTEGER NOT NULL,              -- 1-based row in the sheet
  dept_name     TEXT, bureau TEXT, org_nature TEXT, position_name TEXT, position_attr TEXT, position_dist TEXT,
  position_desc TEXT, org_level TEXT, exam_category TEXT,
  hires         INTEGER,                       -- 招考人数 (parsed)
  major_text    TEXT,                          -- 专业 verbatim
  education TEXT, degree TEXT, political TEXT, grassroots_years TEXT, grassroots_project TEXT,
  skill_test TEXT, interview_ratio TEXT, work_place TEXT, hukou_place TEXT, remarks TEXT, website TEXT,
  phone1 TEXT, phone2 TEXT, phone3 TEXT,
  raw_json      TEXT NOT NULL,                 -- {header: cell} for every column, verbatim
  PRIMARY KEY (notice_id, dept_code, position_code)
);
CREATE INDEX IF NOT EXISTS gwy_position_major_text ON gwy_position(major_text);

CREATE TABLE IF NOT EXISTS gwy_position_major (
  notice_id     TEXT NOT NULL,
  dept_code     TEXT NOT NULL,
  position_code TEXT NOT NULL,
  seq           INTEGER NOT NULL,              -- order of the phrase within 专业
  level         TEXT NOT NULL CHECK (level IN ('any', 'undergrad', 'grad')),
  phrase        TEXT NOT NULL,                 -- one item of 专业 as printed (after splitting)
  catalog       TEXT CHECK (catalog IN ('undergrad', 'grad')),
  major_code    TEXT,                          -- major.code / major_class.code / gwy_grad_discipline.code; NULL if unlimited/unresolved
  match_type    TEXT NOT NULL CHECK (match_type IN ('exact', 'category', 'unlimited', 'related', 'unresolved')),
  rule_id       INTEGER REFERENCES gwy_major_rule(id),
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  PRIMARY KEY (notice_id, dept_code, position_code, seq)
);
CREATE INDEX IF NOT EXISTS gwy_position_major_type ON gwy_position_major(match_type);

-- expert rules, maintained in GWY/rules/major_rules.csv and loaded on every ingest (replaces the table)
CREATE TABLE IF NOT EXISTS gwy_major_rule (
  id            INTEGER PRIMARY KEY,
  phrase        TEXT NOT NULL,
  level         TEXT NOT NULL DEFAULT 'any' CHECK (level IN ('any', 'undergrad', 'grad')),
  catalog       TEXT CHECK (catalog IN ('undergrad', 'grad')),
  major_code    TEXT,                          -- may be several, '|'-separated
  match_type    TEXT NOT NULL CHECK (match_type IN ('exact', 'category', 'unlimited', 'related', 'unresolved')),
  note          TEXT,
  reviewer      TEXT,
  UNIQUE (phrase, level)
);

-- 研究生教育学科专业目录 (学科门类 / 一级学科 / 专业学位类别), from the official MOE PDF
CREATE TABLE IF NOT EXISTS gwy_grad_discipline (
  code          TEXT PRIMARY KEY,              -- 2-digit 门类 or 4-digit 一级学科/专业学位类别
  name          TEXT NOT NULL,                 -- without the trailing * and （可授…） note
  kind          TEXT NOT NULL CHECK (kind IN ('category', 'academic', 'professional')),
  category_code TEXT,
  master_only   INTEGER NOT NULL DEFAULT 0,    -- name had *
  note          TEXT,                          -- e.g. 可授教育学、理学学位
  edition       TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  fetched_at    TEXT
);
