-- CAREER 003 (2026-10-12):
--  (a) occupation provenance per field: name_source, digital_flag_source, green_flag_source
--      values: 'mirror:cccac' (分类体系表 mirror), '公示稿' (filled from the 2022-07 社会公示稿),
--              'mirror:cccac+公示稿' (both agree); later 'official'.
--  (b) occupation_draft_2022: 细类 as printed in the 公示稿 (loaded by ingest from seeds/occupation_draft_2022.csv)
--  (c) engineering = 学位授予门类 contains 工学 (was: 门类 08); category structure unchanged
--  (d) skill: exactly one primary domain + optional secondary domain (tables were empty -> recreated)
--  (e) expert-revised level-1 skill domains (replaces the 002 draft wording; 002 itself is not edited)

ALTER TABLE occupation ADD COLUMN name_source TEXT;
ALTER TABLE occupation ADD COLUMN digital_flag_source TEXT;
ALTER TABLE occupation ADD COLUMN green_flag_source TEXT;
UPDATE occupation SET name_source = 'mirror:cccac' WHERE name_source IS NULL;
UPDATE occupation SET digital_flag_source = 'mirror:cccac' WHERE is_digital = 1 AND digital_flag_source IS NULL;
UPDATE occupation SET green_flag_source = 'mirror:cccac' WHERE is_green = 1 AND green_flag_source IS NULL;

CREATE TABLE occupation_draft_2022 (
  code          TEXT PRIMARY KEY,           -- code as printed in the 公示稿 (may differ from the final edition)
  name          TEXT NOT NULL,
  flag          TEXT CHECK (flag IN ('', 'S', 'L', 'L/S')),
  source_url    TEXT NOT NULL,
  extraction_method TEXT NOT NULL DEFAULT 'pdf_parse',
  reviewed      INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1))
);

UPDATE major SET is_engineering = CASE WHEN ('|' || degree_categories || '|') LIKE '%|工学|%' THEN 1 ELSE 0 END;

DROP TABLE skill_alias;
DROP TABLE skill;
CREATE TABLE skill (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  primary_domain_id   TEXT NOT NULL REFERENCES skill_domain(id),
  secondary_domain_id TEXT REFERENCES skill_domain(id),
  skill_type          TEXT NOT NULL CHECK (skill_type IN ('专业知识', '工具与技术', '通用能力')),
  description         TEXT,
  source              TEXT NOT NULL,
  reviewed            INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  CHECK (secondary_domain_id IS NULL OR secondary_domain_id <> primary_domain_id)
);
CREATE TABLE skill_alias (
  alias         TEXT PRIMARY KEY,
  skill_id      TEXT NOT NULL REFERENCES skill(id),
  source        TEXT NOT NULL
);

ALTER TABLE skill_domain ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1));
INSERT INTO skill_domain (id, name, description, sort_order, source, reviewed) VALUES
  ('foundation',  '工程基础',     '高等数学、大学物理、理论力学、工程制图',             0,  'expert 2026-10-12', 1),
  ('software',    '软件开发',     '编程语言、软件工程、Web/移动/后端开发、嵌入式软件',  1,  'expert 2026-10-12', 1),
  ('hardware',    '电路与硬件',   '模拟/数字电路、PCB、嵌入式硬件',                     5,  'expert 2026-10-12', 1),
  ('embedded',    '自动化与控制', '控制理论、PLC、运动控制、机器人',                    6,  'expert 2026-10-12', 1),
  ('electrical',  '电气工程',     '电力系统、电机电控',                                 9,  'expert 2026-10-12', 1),
  ('energy',      '能源与动力',   '热工、发动机、新能源发电、储能',                     9,  'expert 2026-10-12', 1),
  ('materials',   '材料',         '材料制备与表征',                                     12, 'expert 2026-10-12', 1),
  ('chem-env',    '化工与环境',   '化工工艺、环境监测与治理',                           12, 'expert 2026-10-12', 1),
  ('vehicle',     '车辆工程',     '车辆工程',                                           11, 'expert 2026-10-12', 1),
  ('civil',       '土木与交通',   '结构设计、施工、BIM、交通规划',                      13, 'expert 2026-10-12', 1)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
  source = excluded.source, reviewed = excluded.reviewed;
-- domains not listed above keep their 002 wording and are marked expert-reviewed as well (expert revised the whole list)
UPDATE skill_domain SET source = 'expert 2026-10-12', reviewed = 1;
-- final ordering
UPDATE skill_domain SET sort_order = CASE id
  WHEN 'foundation' THEN 1 WHEN 'software' THEN 2 WHEN 'data' THEN 3 WHEN 'ai' THEN 4 WHEN 'network-sec' THEN 5
  WHEN 'hardware' THEN 6 WHEN 'semiconductor' THEN 7 WHEN 'communication' THEN 8 WHEN 'embedded' THEN 9
  WHEN 'electrical' THEN 10 WHEN 'energy' THEN 11 WHEN 'mechanical' THEN 12 WHEN 'vehicle' THEN 13
  WHEN 'aerospace' THEN 14 WHEN 'materials' THEN 15 WHEN 'chem-env' THEN 16 WHEN 'civil' THEN 17
  WHEN 'testing' THEN 18 WHEN 'product-pm' THEN 19 WHEN 'general' THEN 20 ELSE sort_order END;
