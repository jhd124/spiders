-- CAREER 019 (2026-10-13): expert-maintained skill aliases (admin page #/aliases) that drive deterministic tagging (no LLM).
--  Seed: CAREER/seeds/skill_aliases.csv (loaded at server start / ingest; insert-only, the DB holds the edits).
--  An alias deleted in the admin is remembered here so the seed does not bring it back.
CREATE TABLE IF NOT EXISTS skill_alias_deleted (
  alias       TEXT PRIMARY KEY,
  skill_id    TEXT NOT NULL,
  deleted_by  TEXT,
  deleted_at  TEXT NOT NULL
);
ALTER TABLE skill_alias ADD COLUMN created_by TEXT;
ALTER TABLE skill_alias ADD COLUMN created_at TEXT;
