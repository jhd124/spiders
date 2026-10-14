-- CAREER 025 (2026-10-14), expert 第二批 (EE / automation): 3 new 专业知识 skills. Domains 'embedded' (自动化与控制) and
--  'electrical' (电气工程) already exist (003/016). tag_batch 5: tagged deterministically via seeds/skill_aliases.csv
--  (applyAliasTags on ingest / career run), no LLM; cached LLM tagging results stay valid. Idempotent.
INSERT OR IGNORE INTO skill (id, name, primary_domain_id, secondary_domain_id, skill_type, source, reviewed, tag_batch) VALUES
  ('embedded.process-control', '过程控制', 'embedded', NULL, '专业知识', 'expert 2026-10-14 第二批', 1, 5),
  ('embedded.control-simulation', '控制系统建模与仿真', 'embedded', NULL, '专业知识', 'expert 2026-10-14 第二批', 1, 5),
  ('electrical.power-distribution', '供配电技术', 'electrical', NULL, '专业知识', 'expert 2026-10-14 第二批', 1, 5);
