-- Shandong gaokao 投档表 (普通类常规批第1次志愿), raw rows. No MOE major mapping yet (expert later).
-- Source files: data/gaokao/sd-toudang/ (server: /opt/spiders/data/gaokao/sd-toudang/).

CREATE TABLE IF NOT EXISTS gaokao_toudang (
  id                INTEGER PRIMARY KEY,
  province          TEXT NOT NULL DEFAULT '山东',
  year              INTEGER NOT NULL,
  admission_type    TEXT NOT NULL DEFAULT '普通类常规批第1次志愿',
  -- 1 = ordinary 普通类 product row; 0 = special batch / flagged (专项、中外合作等) — keep but exclude from default product counts
  is_ordinary       INTEGER NOT NULL DEFAULT 1 CHECK (is_ordinary IN (0, 1)),
  school_code       TEXT NOT NULL,             -- e.g. A422
  school_name       TEXT NOT NULL,             -- e.g. 山东大学
  major_code_raw    TEXT NOT NULL,             -- provincial 专业代号 as printed
  major_name_raw    TEXT NOT NULL,             -- 专业（类）名 as printed — product key with school_name until MOE map lands
  subject_requirement TEXT,                    -- 选考科目要求 (2026+; NULL earlier)
  plan_count        INTEGER,                   -- 投档计划数 (2022–2025; NULL in 2026)
  min_rank          INTEGER NOT NULL,           -- 最低位次
  source_file       TEXT NOT NULL,
  source_url        TEXT,
  imported_at       TEXT NOT NULL,
  UNIQUE (province, year, admission_type, school_code, major_code_raw)
);
CREATE INDEX IF NOT EXISTS gaokao_toudang_school ON gaokao_toudang(year, school_code);
CREATE INDEX IF NOT EXISTS gaokao_toudang_name ON gaokao_toudang(year, school_name, major_name_raw);
CREATE INDEX IF NOT EXISTS gaokao_toudang_ordinary ON gaokao_toudang(year, is_ordinary, school_code);

-- Pilot schools (山东投档表院校代号). Seed only; ingest loads all schools.
CREATE TABLE IF NOT EXISTS gaokao_pilot_school (
  school_code   TEXT PRIMARY KEY,
  school_name   TEXT NOT NULL,
  note          TEXT
);
INSERT OR REPLACE INTO gaokao_pilot_school (school_code, school_name, note) VALUES
  ('A422', '山东大学', '济南/青岛校区；威海校区另有代号时仍按投档表原文'),
  ('A425', '中国石油大学(华东)', '投档表写法可能为 中国石油大学（华东）'),
  ('H213', '哈尔滨工业大学(威海)', '投档表写法可能为 哈尔滨工业大学（威海）');
