-- CAREER 005 (2026-10-12): 培养方案 -> 专业核心课/主干课 pipeline.
--  curriculum_source: one row per 培养方案 document listed in seeds/curriculum_sources.csv (synced by ingest)
--  llm_cache:         LLM responses keyed by sha256(model + prompt version + chunk text) -> never pay twice
--  course / major_course: extra provenance (model, page, verbatim snippet) + review state for the console
--  skill_tag_run:     bookkeeping for the (stubbed) course -> skill tagging stage

CREATE TABLE curriculum_source (
  id            TEXT PRIMARY KEY,           -- sha256(url) prefix
  school_name   TEXT NOT NULL,
  school_id     TEXT REFERENCES school(id),
  major_code    TEXT NOT NULL REFERENCES major(code),
  grade_year    TEXT,                       -- 年级 / 培养方案版本, e.g. '2024'
  url           TEXT NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('pdf', 'html', 'docx', 'doc')),
  verified_by   TEXT,                       -- who verified the link (expert)
  notes         TEXT,
  source_doc_id TEXT REFERENCES source_document(id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fetched', 'extracted', 'error')),
  error         TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE llm_cache (
  cache_key     TEXT PRIMARY KEY,
  model         TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  response      TEXT NOT NULL,              -- raw JSON text returned by the model
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at    TEXT NOT NULL
);

ALTER TABLE course ADD COLUMN model TEXT;
ALTER TABLE course ADD COLUMN source_doc_id TEXT REFERENCES source_document(id);

ALTER TABLE major_course ADD COLUMN course_type TEXT CHECK (course_type IN ('核心', '主干'));
ALTER TABLE major_course ADD COLUMN credits REAL;
ALTER TABLE major_course ADD COLUMN hours INTEGER;
ALTER TABLE major_course ADD COLUMN curriculum_source_id TEXT REFERENCES curriculum_source(id);
ALTER TABLE major_course ADD COLUMN source_doc_id TEXT REFERENCES source_document(id);
ALTER TABLE major_course ADD COLUMN source_page INTEGER;
ALTER TABLE major_course ADD COLUMN snippet TEXT;          -- verbatim text the course was read from
ALTER TABLE major_course ADD COLUMN model TEXT;
ALTER TABLE major_course ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (review_status IN ('pending', 'approved', 'rejected', 'edited'));
ALTER TABLE major_course ADD COLUMN reviewer TEXT;
ALTER TABLE major_course ADD COLUMN reviewed_at TEXT;
ALTER TABLE major_course ADD COLUMN review_note TEXT;

CREATE TABLE skill_tag_run (
  id            TEXT PRIMARY KEY,
  tagger        TEXT NOT NULL,              -- e.g. 'none', 'llm:<model>'
  skill_version TEXT,                       -- version of the level-2 skill list used
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  tagged        INTEGER NOT NULL DEFAULT 0
);
