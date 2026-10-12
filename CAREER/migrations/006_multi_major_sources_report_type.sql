-- CAREER 006 (2026-10-12):
--  (a) curriculum_source may cover several majors (a school's 培养方案 汇编): major_code becomes nullable and
--      major_codes keeps the manifest value ('080901', '080901|080902' or '*'). Rebuilt with SQLite's documented
--      create-copy-drop-rename procedure (the runner applies migrations with foreign keys off).
--      curriculum_source_major: the major sections found in a document (page range, class variants such as 菁英班).
--  (b) employment_report: report_type ('就业质量报告' | '本科教学质量报告') and the 本科教学质量报告 metrics;
--      report_source: report links synced from seeds/report_sources.csv (schema only, no extraction yet).

CREATE TABLE curriculum_source_v6 (
  id            TEXT PRIMARY KEY,
  school_name   TEXT NOT NULL,
  school_id     TEXT REFERENCES school(id),
  major_code    TEXT REFERENCES major(code),  -- single-major documents only; NULL for multi-major
  major_codes   TEXT NOT NULL,                -- manifest value: code, 'a|b' list, or '*' (all pilot majors found)
  grade_year    TEXT,
  url           TEXT NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('pdf', 'html', 'docx', 'doc')),
  verified_by   TEXT,
  notes         TEXT,
  source_doc_id TEXT REFERENCES source_document(id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fetched', 'extracted', 'error')),
  error         TEXT,
  sections_note TEXT,                         -- e.g. '080901 p2-6 ✓抽取; 080901（菁英班） p7-11 班级变体，仅记录; 120801 p12-17 非试点'
  updated_at    TEXT NOT NULL
);
INSERT INTO curriculum_source_v6 (id, school_name, school_id, major_code, major_codes, grade_year, url, format, verified_by, notes, source_doc_id, status, error, updated_at)
  SELECT id, school_name, school_id, major_code, major_code, grade_year, url, format, verified_by, notes, source_doc_id, status, error, updated_at FROM curriculum_source;
DROP TABLE curriculum_source;
ALTER TABLE curriculum_source_v6 RENAME TO curriculum_source;

CREATE TABLE curriculum_source_major (
  source_id     TEXT NOT NULL REFERENCES curriculum_source(id),
  major_code    TEXT NOT NULL,                -- as printed in the heading (may be a non-pilot major)
  variant       TEXT NOT NULL DEFAULT '',     -- '' = the major itself; e.g. '菁英班' (class variant, not a MOE major)
  title         TEXT NOT NULL,                -- heading as printed
  page_start    INTEGER NOT NULL,
  page_end      INTEGER NOT NULL,
  printed_pages TEXT,                         -- printed page labels, e.g. '129-133'
  is_pilot      INTEGER NOT NULL CHECK (is_pilot IN (0, 1)),
  extracted     INTEGER NOT NULL CHECK (extracted IN (0, 1)),
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (source_id, major_code, variant)
);

ALTER TABLE employment_report ADD COLUMN report_type TEXT NOT NULL DEFAULT '就业质量报告'
  CHECK (report_type IN ('就业质量报告', '本科教学质量报告'));
ALTER TABLE employment_report ADD COLUMN graduation_rate REAL;     -- 本科毕业率
ALTER TABLE employment_report ADD COLUMN placement_rate REAL;      -- 毕业去向落实率
ALTER TABLE employment_report ADD COLUMN degree_rate REAL;         -- 学位授予率 (often reported alongside)
ALTER TABLE employment_report ADD COLUMN report_source_id TEXT REFERENCES report_source(id);
-- further_study_rate (升学率) and abroad_rate (出国(境)率) already exist since 001.

CREATE TABLE report_source (
  id            TEXT PRIMARY KEY,             -- 'rep-' + sha256(url) prefix
  school_name   TEXT NOT NULL,
  school_id     TEXT REFERENCES school(id),
  report_type   TEXT NOT NULL CHECK (report_type IN ('就业质量报告', '本科教学质量报告')),
  year          TEXT NOT NULL,                -- 届 (就业质量报告) or 学年 (本科教学质量报告), as printed, e.g. '2021届' / '2023-2024学年'
  url           TEXT NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('pdf', 'html', 'docx', 'doc')),
  verified_by   TEXT,
  notes         TEXT,
  source_doc_id TEXT REFERENCES source_document(id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fetched', 'extracted', 'error')),
  updated_at    TEXT NOT NULL
);
