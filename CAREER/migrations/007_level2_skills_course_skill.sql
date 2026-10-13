-- CAREER 007 (2026-10-13): first batch of level-2 skills (expert, 6 computing domains) + course -> skill tagging.
--  (a) seed 36 level-2 skills exactly as named by the expert (names reviewed=1; skill_type assigned by dev, see README)
--  (b) course_skill gets rationale / source / model / tagged_at (one-line reason, 'llm:<model>' | 'manual' | 'expert')
--  (c) course_skill_untagged: courses that fit none of the skills (never force-tagged; expert decides on new skills)
INSERT INTO skill (id, name, primary_domain_id, skill_type, source, reviewed) VALUES
  ('foundation.calculus',        '高等数学',               'foundation',  '专业知识',   'expert 2026-10-13', 1),
  ('foundation.linear-algebra',  '线性代数',               'foundation',  '专业知识',   'expert 2026-10-13', 1),
  ('foundation.prob-stats',      '概率与统计',             'foundation',  '专业知识',   'expert 2026-10-13', 1),
  ('foundation.discrete-math',   '离散数学',               'foundation',  '专业知识',   'expert 2026-10-13', 1),
  ('foundation.physics',         '大学物理',               'foundation',  '专业知识',   'expert 2026-10-13', 1),
  ('foundation.drafting',        '工程制图',               'foundation',  '工具与技术', 'expert 2026-10-13', 1),
  ('software.c-cpp',             'C/C++',                  'software',    '工具与技术', 'expert 2026-10-13', 1),
  ('software.java',              'Java',                   'software',    '工具与技术', 'expert 2026-10-13', 1),
  ('software.python',            'Python',                 'software',    '工具与技术', 'expert 2026-10-13', 1),
  ('software.dsa',               '数据结构与算法',         'software',    '专业知识',   'expert 2026-10-13', 1),
  ('software.os',                '操作系统原理',           'software',    '专业知识',   'expert 2026-10-13', 1),
  ('software.compilers',         '编译原理',               'software',    '专业知识',   'expert 2026-10-13', 1),
  ('software.se-methods',        '软件工程方法',           'software',    '专业知识',   'expert 2026-10-13', 1),
  ('software.db-sql',            '数据库与SQL',            'software',    '工具与技术', 'expert 2026-10-13', 1),
  ('software.web-frontend',      'Web前端',                'software',    '工具与技术', 'expert 2026-10-13', 1),
  ('software.backend',           '后端开发',               'software',    '工具与技术', 'expert 2026-10-13', 1),
  ('software.linux',             'Linux使用',              'software',    '工具与技术', 'expert 2026-10-13', 1),
  ('data.cleaning',              '数据清洗与处理',         'data',        '工具与技术', 'expert 2026-10-13', 1),
  ('data.visualization',         '数据可视化',             'data',        '工具与技术', 'expert 2026-10-13', 1),
  ('data.bigdata-platform',      '大数据平台（Hadoop/Spark）', 'data',    '工具与技术', 'expert 2026-10-13', 1),
  ('data.bi-tools',              '商业智能工具',           'data',        '工具与技术', 'expert 2026-10-13', 1),
  ('ai.ml',                      '机器学习',               'ai',          '专业知识',   'expert 2026-10-13', 1),
  ('ai.dl',                      '深度学习',               'ai',          '专业知识',   'expert 2026-10-13', 1),
  ('ai.cv',                      '计算机视觉',             'ai',          '专业知识',   'expert 2026-10-13', 1),
  ('ai.nlp',                     '自然语言处理',           'ai',          '专业知识',   'expert 2026-10-13', 1),
  ('ai.llm-apps',                '大模型应用',             'ai',          '工具与技术', 'expert 2026-10-13', 1),
  ('network-sec.protocols',      '计算机网络协议',         'network-sec', '专业知识',   'expert 2026-10-13', 1),
  ('network-sec.net-eng',        '网络工程与配置',         'network-sec', '工具与技术', 'expert 2026-10-13', 1),
  ('network-sec.crypto',         '密码学',                 'network-sec', '专业知识',   'expert 2026-10-13', 1),
  ('network-sec.pentest',        '渗透测试',               'network-sec', '工具与技术', 'expert 2026-10-13', 1),
  ('network-sec.secops',         '安全运维',               'network-sec', '工具与技术', 'expert 2026-10-13', 1),
  ('hardware.digital-logic',     '数字逻辑',               'hardware',    '专业知识',   'expert 2026-10-13', 1),
  ('hardware.comp-arch',         '计算机组成与体系结构',   'hardware',    '专业知识',   'expert 2026-10-13', 1),
  ('hardware.analog',            '模拟电路',               'hardware',    '专业知识',   'expert 2026-10-13', 1),
  ('hardware.embedded',          '嵌入式硬件',             'hardware',    '工具与技术', 'expert 2026-10-13', 1),
  ('hardware.fpga',              'FPGA',                   'hardware',    '工具与技术', 'expert 2026-10-13', 1)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, primary_domain_id = excluded.primary_domain_id, source = excluded.source;

ALTER TABLE course_skill ADD COLUMN rationale TEXT;
ALTER TABLE course_skill ADD COLUMN source TEXT;
ALTER TABLE course_skill ADD COLUMN model TEXT;
ALTER TABLE course_skill ADD COLUMN tagged_at TEXT;

CREATE TABLE IF NOT EXISTS course_skill_untagged (
  course_id     TEXT PRIMARY KEY REFERENCES course(id),
  is_core       INTEGER NOT NULL DEFAULT 0 CHECK (is_core IN (0, 1)),
  reason        TEXT,
  model         TEXT,
  tagged_at     TEXT NOT NULL
);
