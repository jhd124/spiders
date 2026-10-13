-- CAREER 010 (2026-10-13): expert adds level-2 skill network-sec.infosec-basics 信息安全基础 (专业知识).
-- The skill list is part of the tagger prompt, so this also invalidates cached tagging responses.
INSERT INTO skill (id, name, primary_domain_id, skill_type, source, reviewed) VALUES
  ('network-sec.infosec-basics', '信息安全基础', 'network-sec', '专业知识', 'expert 2026-10-13', 1)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, primary_domain_id = excluded.primary_domain_id, skill_type = excluded.skill_type, source = excluded.source;
