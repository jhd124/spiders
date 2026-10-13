-- CAREER 008 (2026-10-13): all courses of the 培养方案 table, not only core courses.
--  major_course.course_type now means 必修 / 限选 / 任选 (NULL = not stated). The old 005 column ('核心'|'主干')
--  is kept as core_type_legacy (history; no longer written).
--  Core is recorded as two separate facts so the expert's rule can be applied later:
--    core_in_section  1 = listed in the "核心课程设置" paragraph (四)
--    table_block      课程类别 block in the course table, e.g. 学科平台基础课程 / 专业核心课程
--  is_core: 1 = core_in_section, 0 = neither fact, NULL = only the table block says 专业核心 (undecided).
ALTER TABLE major_course RENAME COLUMN course_type TO core_type_legacy;
ALTER TABLE major_course ADD COLUMN course_type TEXT CHECK (course_type IN ('必修', '限选', '任选'));
ALTER TABLE major_course ADD COLUMN core_in_section INTEGER NOT NULL DEFAULT 0 CHECK (core_in_section IN (0, 1));
ALTER TABLE major_course ADD COLUMN table_block TEXT;
ALTER TABLE major_course ADD COLUMN module TEXT;
-- rows extracted before 008 came from the core-only prompt; they are re-extracted on the next run
UPDATE major_course SET is_core = NULL WHERE extraction_method = 'llm' AND review_status = 'pending';
