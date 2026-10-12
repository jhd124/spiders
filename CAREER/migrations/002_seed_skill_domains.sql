-- CAREER 002: SEED — level-1 skill domains (能力域) only.
-- !! Starter list for the expert to review (source = 'seed: draft, pending expert review').
-- !! Level-2 skills are intentionally NOT seeded (to be derived from JD statistics + expert review).
INSERT INTO skill_domain (id, name, description, sort_order, source) VALUES
  ('software',      '软件开发',       '编程语言、软件工程、Web/移动/后端开发', 1,  'seed: draft, pending expert review'),
  ('data',          '数据分析',       '统计、数据处理、BI、机器学习应用',       2,  'seed: draft, pending expert review'),
  ('ai',            '人工智能',       '机器学习/深度学习模型研发与部署',        3,  'seed: draft, pending expert review'),
  ('network-sec',   '网络与信息安全', '网络工程、运维、安全攻防',               4,  'seed: draft, pending expert review'),
  ('hardware',      '电路与硬件',     '模拟/数字电路、PCB、嵌入式硬件',         5,  'seed: draft, pending expert review'),
  ('embedded',      '嵌入式与控制',   '嵌入式软件、PLC、自动控制',              6,  'seed: draft, pending expert review'),
  ('semiconductor', '集成电路与微电子','芯片设计、工艺、封测',                  7,  'seed: draft, pending expert review'),
  ('communication', '通信技术',       '无线/有线通信、射频、协议',              8,  'seed: draft, pending expert review'),
  ('electrical',    '电气与能源',     '电力系统、电机电控、新能源',             9,  'seed: draft, pending expert review'),
  ('mechanical',    '机械设计',       '机械设计、CAD/CAE、制造工艺',            10, 'seed: draft, pending expert review'),
  ('vehicle',       '车辆与交通',     '整车、动力系统、交通运输',               11, 'seed: draft, pending expert review'),
  ('materials',     '材料与化工',     '材料表征、化工工艺、环境工程',           12, 'seed: draft, pending expert review'),
  ('civil',         '土木与建筑',     '结构设计、施工、BIM',                    13, 'seed: draft, pending expert review'),
  ('aerospace',     '航空航天',       '飞行器设计、推进、适航',                 14, 'seed: draft, pending expert review'),
  ('testing',       '测试与质量',     '测试、计量、质量管理',                   15, 'seed: draft, pending expert review'),
  ('product-pm',    '产品与项目管理', '需求分析、项目管理、产品设计',           16, 'seed: draft, pending expert review'),
  ('general',       '通用职业能力',   '沟通、协作、英语、文档写作、学习能力',   17, 'seed: draft, pending expert review');
