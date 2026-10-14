-- CAREER 028 (2026-10-14): student-facing occupation names (seeds/occupation_display_names.csv, loaded idempotently at start / ingest).
--  official_name is the 大典 name as given in the seed (checked against occupation.name; mismatches are logged, not fatal).
--  search_aliases: '|'-separated extra search terms.
CREATE TABLE IF NOT EXISTS occupation_display (
  code           TEXT PRIMARY KEY,
  official_name  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  search_aliases TEXT NOT NULL DEFAULT '',
  updated_at     TEXT NOT NULL
);
