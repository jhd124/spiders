-- CAREER 020 (2026-10-14), expert: 4 new 专业知识 skills (software) to give 软件工程/云计算 occupations discriminating core skills.
--  tag_batch 4: added skills never invalidate cached tagging results (tag.ts). They are tagged deterministically via the expert
--  aliases in seeds/skill_aliases.csv (contains-match, applyAliasTags on ingest / career run); no LLM call. Idempotent.
INSERT OR IGNORE INTO skill (id, name, primary_domain_id, secondary_domain_id, skill_type, source, reviewed, tag_batch) VALUES
  ('software.testing', '软件测试', 'software', NULL, '专业知识', 'expert 2026-10-14', 1, 4),
  ('software.architecture', '软件体系结构与设计', 'software', NULL, '专业知识', 'expert 2026-10-14', 1, 4),
  ('software.distributed', '分布式系统', 'software', NULL, '专业知识', 'expert 2026-10-14', 1, 4),
  ('software.cloud', '云计算与虚拟化', 'software', NULL, '专业知识', 'expert 2026-10-14', 1, 4);
