-- CAREER 027 (2026-10-14), expert:
--  1. skill_alias gets a match mode: 'contains' (default, the old behaviour) or 'exact' (whole course name, spaces/bracket width ignored),
--     and the key becomes (alias, skill_id) so one alias can map to several skills (电子技术 -> 模拟电路 + 数字逻辑).
--  2. practice courses (name ends in 课程设计/实验/实习/实训/实践, trailing bracket ignored) are skipped by alias matching; drop the existing
--     unreviewed alias-rule tags on them (LLM-sourced tags are left alone). Names with a trailing bracket are caught by the next alias pass.
CREATE TABLE skill_alias_new (
  alias       TEXT NOT NULL,
  skill_id    TEXT NOT NULL REFERENCES skill(id),
  source      TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT,
  match       TEXT NOT NULL DEFAULT 'contains' CHECK (match IN ('contains', 'exact')),
  PRIMARY KEY (alias, skill_id)
);
INSERT INTO skill_alias_new (alias, skill_id, source, created_by, created_at) SELECT alias, skill_id, source, created_by, created_at FROM skill_alias;
DROP TABLE skill_alias;
ALTER TABLE skill_alias_new RENAME TO skill_alias;
DELETE FROM course_skill WHERE source = 'rule:alias' AND reviewed = 0 AND course_id IN (SELECT id FROM course WHERE
  replace(name, ' ', '') LIKE '%课程设计' OR replace(name, ' ', '') LIKE '%实验' OR replace(name, ' ', '') LIKE '%实习'
  OR replace(name, ' ', '') LIKE '%实训' OR replace(name, ' ', '') LIKE '%实践');
