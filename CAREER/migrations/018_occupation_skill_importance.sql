-- CAREER 018 (2026-10-13): occupation -> skill requirements for the 职业→技能→专业/课程→学校 query (no LLM).
--  importance: core (weight 2) | general (weight 1). source: who said so ('example' = placeholder, NOT expert data).
--  verified_by: expert name; empty = unverified. Rows are loaded from CAREER/seeds/occupation_skills.csv at ingest.
ALTER TABLE occupation_skill ADD COLUMN importance TEXT NOT NULL DEFAULT 'general' CHECK (importance IN ('core', 'general'));
ALTER TABLE occupation_skill ADD COLUMN source TEXT;
ALTER TABLE occupation_skill ADD COLUMN verified_by TEXT;
ALTER TABLE occupation_skill ADD COLUMN note TEXT;
ALTER TABLE occupation_skill ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS occupation_skill_skill_idx ON occupation_skill(skill_id);
