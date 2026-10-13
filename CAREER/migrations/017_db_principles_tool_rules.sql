-- CAREER 017 (2026-10-13), expert rulings; no LLM call; idempotent.
--  (1) new 专业知识 skill 数据库原理 (software). tag_batch 3: added skills never invalidate cached tagging results (tag.ts).
--      Core courses named 数据库原理/数据库系统/数据库技术/数据库系统概论… get it as 核心课名 0.8 via the general core-name rule
--      (coreNameMatches v2 + addCoreNameTags post-step), no special case.
--  (2) 数据库与SQL is a pure tool: only with an explicit "SQL" in the course name or the quote. The 数据库系统 -> 数据库与SQL whitelist is
--      withdrawn: such a tag on a core 数据库… course becomes 数据库原理 核心课名 (keeping its reviewed flag), the tool tag is removed.
--  (3) FPGA only with "FPGA"; Verilog/VHDL only with Verilog/VHDL/硬件描述语言 (no cross-triggering).
--  Tool tags without that evidence: unreviewed -> deleted (same as the tagger's rule); reviewed -> needs_review with a reason.
INSERT OR IGNORE INTO skill (id, name, primary_domain_id, secondary_domain_id, skill_type, source, reviewed, tag_batch)
  VALUES ('software.db-principles', '数据库原理', 'software', NULL, '专业知识', 'expert 2026-10-13', 1, 3);

CREATE TEMP TABLE m017 AS
  SELECT cs.rowid AS rid, cs.course_id, cs.skill_id, cs.reviewed, c.name,
    EXISTS (SELECT 1 FROM major_course mc WHERE mc.course_id = cs.course_id AND mc.is_core = 1) AS core
  FROM course_skill cs JOIN course c ON c.id = cs.course_id
  WHERE (cs.skill_id = 'software.db-sql' AND c.name NOT LIKE '%SQL%' AND COALESCE(cs.evidence_quote, '') NOT LIKE '%SQL%')
     OR (cs.skill_id = 'hardware.fpga' AND c.name NOT LIKE '%FPGA%' AND COALESCE(cs.evidence_quote, '') NOT LIKE '%FPGA%')
     OR (cs.skill_id = 'semiconductor.hdl' AND c.name NOT LIKE '%Verilog%' AND c.name NOT LIKE '%VHDL%' AND c.name NOT LIKE '%硬件描述语言%'
         AND COALESCE(cs.evidence_quote, '') NOT LIKE '%Verilog%' AND COALESCE(cs.evidence_quote, '') NOT LIKE '%VHDL%' AND COALESCE(cs.evidence_quote, '') NOT LIKE '%硬件描述语言%');

INSERT INTO course_skill (course_id, skill_id, weight, extraction_method, confidence, reviewed, rationale, source, model, tagged_at, evidence_quote, needs_review, review_reason, evidence_type, tag_rank)
  SELECT course_id, 'software.db-principles', 0.8, 'pdf_parse', NULL, reviewed, '正文核心课程，课程名即技能「数据库原理」（017：原 数据库系统→数据库与SQL 例外改挂）',
    'rule:core-name', NULL, '2026-10-13', name, 0, NULL, '核心课名', NULL
  FROM m017 WHERE skill_id = 'software.db-sql' AND core = 1 AND name LIKE '数据库%'
  ON CONFLICT (course_id, skill_id) DO NOTHING;
DELETE FROM course_skill WHERE rowid IN (SELECT rid FROM m017 WHERE reviewed = 0 OR (skill_id = 'software.db-sql' AND core = 1 AND name LIKE '数据库%'));
UPDATE course_skill SET needs_review = 1,
  review_reason = '017 工具规则：原文和课程名都没写出该工具（' || CASE skill_id WHEN 'software.db-sql' THEN 'SQL' WHEN 'hardware.fpga' THEN 'FPGA' ELSE 'Verilog/VHDL/硬件描述语言' END || '）'
  WHERE rowid IN (SELECT rid FROM m017 WHERE reviewed = 1);
DROP TABLE m017;
