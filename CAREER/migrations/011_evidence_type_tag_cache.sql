-- CAREER 011 (2026-10-13): expert rules for course-name tagging + stable re-runs.
--  (1) course_skill.evidence_type: '原文明确' (the source text states it beyond the course name) | '课名推断' (only the course
--      name / its table row). 课名推断 is limited in code: knowledge (专业知识) skills only, at most 2 per course.
--      Recommendation weight per type: EVIDENCE_WEIGHT in CAREER/curriculum/skills.ts (原文明确 1.0, 课名推断 0.5).
--  (2) course_skill_tag_cache: the validated tagging result PER COURSE, keyed by
--      sha256(model + course name + the course's own source lines + TAG_PROMPT_VERSION + skill-table hash).
--      A course is re-sent to the model only when its key changes; unchanged courses are not rewritten at all.
ALTER TABLE course_skill ADD COLUMN evidence_type TEXT CHECK (evidence_type IS NULL OR evidence_type IN ('原文明确', '课名推断'));

CREATE TABLE IF NOT EXISTS course_skill_tag_cache (
  course_id   TEXT PRIMARY KEY,
  tag_key     TEXT NOT NULL,
  result_json TEXT NOT NULL,   -- {"tags":[...SkillTag], "untagged": {...} | null}
  model       TEXT,
  tagged_at   TEXT NOT NULL
);
