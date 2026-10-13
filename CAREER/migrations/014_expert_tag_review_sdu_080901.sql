-- CAREER 014 (2026-10-13): expert review of 山东大学 080901 (2024级) tags. No LLM call; idempotent (safe on DBs lacking the rows).
--  (1) course_skill_rejected: expert-rejected (course, skill) pairs. The tagger never (re)inserts these, even from its per-course
--      cache (see tag.ts), so a re-tag cannot recreate them.
--  (2) 程序设计基础 / 高级语言程序设计 -> 数据结构与算法: rejected (quote only enumerated course names; 原文没写语言 -> 不挂, 同计算概论).
--  (3) 信息检索与数据挖掘: 数据清洗与处理 rejected, replaced by 机器学习 (课名推断, 0.5, expert-approved).
CREATE TABLE IF NOT EXISTS course_skill_rejected (
  course_id   TEXT NOT NULL REFERENCES course(id),
  skill_id    TEXT NOT NULL REFERENCES skill(id),
  reason      TEXT,
  rejected_by TEXT,
  rejected_at TEXT,
  PRIMARY KEY (course_id, skill_id)
);
CREATE TEMP TABLE m014 AS
  SELECT DISTINCT c.id AS course_id, c.name FROM course c JOIN school s ON s.id = c.school_id
  JOIN major_course mc ON mc.course_id = c.id AND mc.school_id = c.school_id
  WHERE s.name = '山东大学' AND mc.major_code = '080901' AND (mc.plan_year = 2024 OR mc.plan_year IS NULL)
    AND c.name IN ('程序设计基础', '高级语言程序设计', '信息检索与数据挖掘');
INSERT OR IGNORE INTO course_skill_rejected (course_id, skill_id, reason, rejected_by, rejected_at)
  SELECT course_id, 'software.dsa', '引用原文只是罗列课名，不能算原文明确；入门课原文未写语言，暂不挂', 'expert', '2026-10-13' FROM m014 WHERE name IN ('程序设计基础', '高级语言程序设计')
  UNION ALL
  SELECT course_id, 'data.cleaning', '数据挖掘主体是算法和模型，改挂机器学习', 'expert', '2026-10-13' FROM m014 WHERE name = '信息检索与数据挖掘';
DELETE FROM course_skill WHERE EXISTS (SELECT 1 FROM course_skill_rejected r WHERE r.course_id = course_skill.course_id AND r.skill_id = course_skill.skill_id);
INSERT INTO course_skill (course_id, skill_id, weight, extraction_method, confidence, reviewed, rationale, source, model, tagged_at, evidence_quote, needs_review, review_reason, evidence_type, tag_rank)
  SELECT course_id, 'ai.ml', 0.5, 'expert', NULL, 1, '数据挖掘的主体是算法和模型（专家审核 2026-10-13）', 'expert', NULL, '2026-10-13', NULL, 0, NULL, '课名推断', 1
  FROM m014 WHERE name = '信息检索与数据挖掘'
  ON CONFLICT (course_id, skill_id) DO UPDATE SET weight = 0.5, extraction_method = 'expert', reviewed = 1, rationale = excluded.rationale,
    source = 'expert', needs_review = 0, review_reason = NULL, evidence_type = '课名推断', tag_rank = 1;
DROP TABLE m014;
