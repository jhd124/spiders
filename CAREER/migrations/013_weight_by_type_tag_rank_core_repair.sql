-- CAREER 013 (2026-10-13)
--  (1) course_skill.weight = EVIDENCE_WEIGHT[evidence_type] exactly (原文明确 1.0, 核心课名 0.8, 课名推断 0.5): no rank multiplier.
--      The model's ordering moves to tag_rank (1 = first), used only for review sorting. Rank is recovered from the old
--      weight (= type weight x 1 / 0.75 / 0.5).
--  (2) major_course core facts on rows frozen by review (see load.ts upMc): nothing to do in SQL — the PDF facts live in the
--      cached extraction, and the next ingest now refreshes core_in_section / table_block / module / is_core on reviewed rows too.
ALTER TABLE course_skill ADD COLUMN tag_rank INTEGER;
UPDATE course_skill SET tag_rank = CAST(ROUND((1 - weight / (CASE evidence_type WHEN '原文明确' THEN 1.0 WHEN '核心课名' THEN 0.8 ELSE 0.5 END)) / 0.25) AS INTEGER) + 1
  WHERE evidence_type IS NOT NULL AND weight IS NOT NULL;
UPDATE course_skill SET weight = CASE evidence_type WHEN '原文明确' THEN 1.0 WHEN '核心课名' THEN 0.8 ELSE 0.5 END WHERE evidence_type IS NOT NULL;
