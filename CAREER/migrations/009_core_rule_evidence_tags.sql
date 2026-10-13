-- CAREER 009 (2026-10-13): expert rules.
--  (1) core: is_core = 1 ONLY when listed in the 正文「核心课程」section (core_in_section = 1). A course that is only in the
--      course table's 专业核心课程 block is 专业必修 (course_type 必修, is_core = 0); table_block is kept as the source fact.
--  (2) new level-2 skill software.graphics 计算机图形学 (专业知识).
--  (3) skill_type fixed by the expert: 工具与技术 = C/C++, Java, Python, 数据库与SQL, Linux使用, Web前端, 后端开发,
--      大数据平台（Hadoop/Spark）, 商业智能工具, FPGA, 大模型应用; everything else 专业知识.
--  (4) course_skill.evidence_quote (verbatim source text the tagger cites) + needs_review / review_reason.
UPDATE major_course SET is_core = CASE WHEN core_in_section = 1 THEN 1 ELSE 0 END WHERE extraction_method = 'llm';

INSERT INTO skill (id, name, primary_domain_id, skill_type, source, reviewed) VALUES
  ('software.graphics', '计算机图形学', 'software', '专业知识', 'expert 2026-10-13', 1)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, primary_domain_id = excluded.primary_domain_id, skill_type = excluded.skill_type, source = excluded.source;

UPDATE skill SET skill_type = CASE WHEN id IN ('software.c-cpp', 'software.java', 'software.python', 'software.db-sql', 'software.linux',
  'software.web-frontend', 'software.backend', 'data.bigdata-platform', 'data.bi-tools', 'hardware.fpga', 'ai.llm-apps') THEN '工具与技术' ELSE '专业知识' END
WHERE source = 'expert 2026-10-13';

ALTER TABLE course_skill ADD COLUMN evidence_quote TEXT;
ALTER TABLE course_skill ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1));
ALTER TABLE course_skill ADD COLUMN review_reason TEXT;
-- tags written before 009 carry no evidence: never treat them as accepted
UPDATE course_skill SET needs_review = 1, review_reason = '009 之前的标签，没有原文依据' WHERE extraction_method = 'llm' AND reviewed = 0;
