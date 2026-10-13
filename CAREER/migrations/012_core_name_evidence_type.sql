-- CAREER 012 (2026-10-13): course_skill.evidence_type gains '核心课名' (weight 0.8): a 正文-listed core course whose name is the
-- skill name. Assigned deterministically by classifyCoreNames (CAREER/curriculum/tag.ts) after tagging; no LLM call.
-- SQLite cannot alter a CHECK constraint, so course_skill is rebuilt with the same rows AND the same rowids.
CREATE TABLE course_skill_012 (
  course_id     TEXT NOT NULL REFERENCES course(id),
  skill_id      TEXT NOT NULL REFERENCES skill(id),
  weight        REAL,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('pdf_parse', 'llm', 'manual', 'expert')),
  confidence    REAL,
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  rationale TEXT, source TEXT, model TEXT, tagged_at TEXT, evidence_quote TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)), review_reason TEXT,
  evidence_type TEXT CHECK (evidence_type IS NULL OR evidence_type IN ('原文明确', '核心课名', '课名推断')),
  PRIMARY KEY (course_id, skill_id)
);
INSERT INTO course_skill_012 (rowid, course_id, skill_id, weight, extraction_method, confidence, reviewed, rationale, source, model, tagged_at, evidence_quote, needs_review, review_reason, evidence_type)
  SELECT rowid, course_id, skill_id, weight, extraction_method, confidence, reviewed, rationale, source, model, tagged_at, evidence_quote, needs_review, review_reason, evidence_type FROM course_skill;
DROP TABLE course_skill;
ALTER TABLE course_skill_012 RENAME TO course_skill;
