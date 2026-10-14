/** 培养方案 batch 2 (EE / automation, 2026-10-14): parser fixtures are short excerpts of the real PDFs' text layer. No LLM. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SPIDERS_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'career-b2-'));
const { parseCodeTable, sduBlockName } = await import('../codetable.js');
const { findCoreSection } = await import('../tables.js');
const { coreSectionNames, extractCourses, isNumberedPart } = await import('../extract.js');
const { MemoryCache } = await import('../cache.js');
const { MockProvider } = await import('../../../lib/llm.js');

// 15 filler rows so the layout is detected (detectLayout needs >= 15 coded rows)
const hitFill = Array.from({ length: 15 }, (_, i) => `22WHMX110${String(i).padStart(2, '0')} | 思政课${i} | 1.0 | 16 | 1秋`).join('\n');

// 哈工大（威海） SIEE 2025 (自动化 / 电子信息工程): headings without " | ", module lines, split semester "3 | 秋", weeks, wrapped semester
const HIT_EE = `四、专业基础课程和专业核心课程
专业核心课程：自动控制理论、自动控制实践、最优控制基础
五、修业年限
六、课程体系及学分分布
（一）公共基础课程
1.思想政治课程
课程代码 | 课程名称 | 学分 | 学时 | 备注
${hitFill}
（二）大类平台课程
1.专业集群基础课程（含实习实训课程）
22WHIE22019 | 电路C | 2.5 | 40
2秋
22WHIE22501 | 通信电子线路 | B | 2.5 | 40 | 3 | 秋
2.大类专业基础课程（含实习实训课程）
2.1大类专业基础必修课程
22WHOE22602 | 工程训练（制造工艺实习）B | 2.0 | 2 | 周 | 3 | 秋
2.2大类专业基础限选课程(按模块选修)
课程代码 | 课程名称 | 学分 | 学时 | 备注
电气模块
22WHRE22041 | 电磁场 | 3.0 | 48 | 2春
自动化模块
22WHIE22102 | 单片机控制 | 2.5 | 40 | 2春
（三）专业方向课程
1.专业方向核心课程（含实习实训课程）
22WHIE31102 | 自动控制理论(1) | 5.0 | 80 | 3秋
22WHIE31103 | 自动控制理论(2) | 3.5 | 56 | 3春
22WHIE31105 | 最优控制基础 | 2.0 | 32 | 3春
22WHIE31104 | 自动控制实践(1) | 4.0 | 64 | 3秋
2.专业方向选修课程（含研究生课程）
本科阶段专业方向选修课程至少选修4.5学分，建议在3春选2门，4秋选1门。
表1 | 专业方向选修课程
22WHIE32103 | 过程控制 | 1.5 | 24 | 4秋
自动控制专业教学进程计划方案
22WHIE32103过程控制 | 1.5 | 24 | 考查`;

test('HIT-WH 2025 SIEE layout: pipe-less headings, 模块 lines, split semester/weeks; 限选 / 任选 blocks', () => {
  const t = parseCodeTable([{ page: 5, text: HIT_EE }])!;
  assert.equal(t.layout, 'hitwh');
  const by = new Map(t.courses.map((c) => [c.name, c]));
  assert.equal(t.courses.length, 15 + 10, 'the 教学进程计划 repeat is not parsed');
  assert.deepEqual([by.get('电路C')!.semester, by.get('电路C')!.hours], ['2秋', 40], 'semester wrapped to the next line');
  assert.equal(by.get('通信电子线路B')!.semester, '3秋');
  assert.equal(by.get('通信电子线路B')!.credits, 2.5);
  assert.equal(by.get('工程训练（制造工艺实习）B')!.hours, null, '2 周 is weeks, not hours');
  assert.equal(by.get('工程训练（制造工艺实习）B')!.semester, '3秋');
  assert.equal(by.get('电磁场')!.block, '大类专业基础限选课程(按模块选修)');
  assert.equal(by.get('电磁场')!.course_type, '限选');
  assert.equal(by.get('电磁场')!.module, '电气模块');
  assert.equal(by.get('单片机控制')!.module, '自动化模块');
  assert.equal(by.get('自动控制理论(1)')!.course_type, '必修');
  assert.equal(by.get('自动控制理论(1)')!.module, null);
  assert.equal(by.get('过程控制')!.block, '专业方向选修课程（含研究生课程）');
  assert.equal(by.get('过程控制')!.course_type, '任选');
  assert.equal(by.get('电路C')!.block, '专业集群基础课程（含实习实训课程）');
});

test('a 表二 任选 list stays 任选 (HIT-WH 080902 "2.2表二：专业方向任选课程列表")', () => {
  const t = parseCodeTable([{ page: 1, text: `六、课程体系\n${hitFill}\n2.1表一：专业方向限选课程列表\n22WHSE32202 | 数据挖掘 | 2.0 | 32 | 3春\n2.2表二：专业方向任选课程列表\n22WHSE32301 | Java程序设计 | 2.0 | 32 | 2秋` }])!;
  const by = new Map(t.courses.map((c) => [c.name, c]));
  assert.equal(by.get('数据挖掘')!.course_type, '限选');
  assert.equal(by.get('Java程序设计')!.course_type, '任选');
});

test('core names of a numbered sequence mark every part (自动控制理论 -> (1)/(2); 专业设计 -> -A…-D); no model needed', async () => {
  assert.ok(isNumberedPart('自动控制理论(1)', '自动控制理论'));
  assert.ok(isNumberedPart('电路（II）', '电路'));
  assert.ok(isNumberedPart('专业设计-A', '专业设计'));
  assert.ok(!isNumberedPart('电路分析', '电路'));
  assert.ok(!isNumberedPart('自动控制理论实验', '自动控制理论'));
  const r = await extractCourses([{ page: 5, text: HIT_EE }], { school: '哈尔滨工业大学（威海）', majorCode: '080801', majorName: '自动化' }, new MockProvider(() => '{"courses":[]}'), new MemoryCache());
  const core = r.courses.filter((c) => c.core_in_section).map((c) => c.name).sort();
  assert.deepEqual(core, ['最优控制基础', '自动控制实践(1)', '自动控制理论(1)', '自动控制理论(2)'].sort());
});

test('core section: UPC page furniture dropped; SDU "…等核心必修课。" tail removed', () => {
  const upc = findCoreSection([{ page: 4, text: '三、主干学科、专业核心课程\n专业核心课程：过程控制工程，现代控制理论，自动\n控制原理，传感器与检测基础\n· 547 ·\n中国石油大学（华东）2025培养方案\n四、毕业要求' }])!;
  assert.deepEqual(coreSectionNames(upc.text), ['过程控制工程', '现代控制理论', '自动控制原理', '传感器与检测基础']);
  const sdu = findCoreSection([{ page: 4, text: '四、核心课程设置\n电路、电磁场、电力市场原理（双语）、\n专业设计、毕业论文(设计)等核心必修课。\n五、主要实践性教学环节' }])!;
  assert.deepEqual(coreSectionNames(sdu.text), ['电路', '电磁场', '电力市场原理', '专业设计', '毕业论文']);
});

// 山东大学 2024 PDF (电气工程及其自动化): sd course numbers, vertical 类别 labels, 方向 modules, split long names
const sdFill = Array.from({ length: 13 }, (_, i) => `sd0281${String(i).padStart(4, '0')} | 形势与政策（${i}） | 0.5 | 8 | 8 | 考试 | 1`).join('\n');
const SDU_EE = `十、电气工程及其自动化专业课程设置及学时分配表
（一）专业培养计划--通识教育课程
课程类别 | 课程号/组 | 课程名称 | 分 | 学 | 备注
数 | 时 | 理论 | 实验 | 实践 | 实践
sd02810740 | 习近平新时代中国特色社会主义思想概论 | 3 | 48 | 48 | 考试 | 6
毛泽东思想和中国特色社会主义理论体系概
sd02810870 | 3 | 56 | 40 | 16 | 考试 | 6 | 0.5实践学分
论
通识
教育 | 00070 | 大学英语课程组 | 8 | 256 | 128 | 64 | 考试 | 1-4 | 课外64学时
必修
${sdFill}
课程
应修小计 | 34 | 816 | 464 | 288
应修说明
00100 | 科技素养 | 2 | 32 | 32 | 考查 | 1-8 | 任选2学分
通识
教育 | 00120 | 艺术审美 | 2 | 32 | 32 | 考查 | 1-8 | 任选2学分
核心
课程
应修小计 | 8 | 128 | 128
（二）专业培养计划--专业教育课程
课程类别 | 课程号 | 课程名称 | 分 | 学 | 备注
数 | 时 | 理论 | 实验 | 实践 | 实践
sd01932730 | 电路（I） | 3.5 | 64 | 48 | 16 | 考试 | 2
专业
sd01932900 | 电气工程基础 | 7 | 128 | 96 | 32 | 考试 | 5
核心
课程 | sd01932940 | 电气工程基础课程设计 | 1 | 32 | 32 | 1 | 考查 | 5
应修小计 | 49 | 1164 | 404 | 280 | 480 | 17周
应修说明
A方向（电气设备与控制）
sd01930230 | 电机设计 | 2 | 32 | 32 | 其它 | 6
sd01932910 | 专业设计-A | 2 | 64 | 64 | 2 | 考查 | 6
模块应修小计 | 10.5 | 208 | 128 | 16 | 64 | 2周
模块应修说明
专业
D方向（新型电力系统运行与控制）
限选
课程 | sd01930440 | 电力系统分析 | 2 | 34 | 30 | 4 | 其它 | 6
应修小计 | 10.5
应修说明 | 任选其中一个方向模块修读10.5学分。
sd01930770 | 供配电工程 | 2 | 32 | 32 | 考查 | 7
专业
任选 | sd01930500 | 电力系统继电保护 | 2 | 32 | 32 | 考查 | 7 | D方向不选
课程
应修小计 | 6 | 96
十一、课程（项目）与毕业要求对应关系`;

test('SDU PDF layout: blocks from vertical labels, split names, 方向 modules, choice blocks 任选', () => {
  assert.equal(sduBlockName('论通识教育必修课程通识教育课程'), '通识教育必修课程');
  assert.equal(sduBlockName('创新齐鲁创业创业计划'), '创新创业计划');
  assert.equal(sduBlockName('模块应修小计模块应修说明专业限选课程模块应修小计'), '专业限选课程');
  const t = parseCodeTable([{ page: 6, text: SDU_EE }])!;
  assert.equal(t.layout, 'sdu');
  assert.deepEqual(t.warnings, []);
  const by = new Map(t.courses.map((c) => [c.name, c]));
  assert.equal(by.get('毛泽东思想和中国特色社会主义理论体系概论')!.credits, 3, 'name split around the code row is joined');
  assert.equal(by.get('大学英语课程组')!.block, '通识教育必修课程');
  assert.equal(by.get('科技素养')!.block, '通识教育核心课程');
  assert.equal(by.get('科技素养')!.course_type, '任选');
  assert.equal(by.get('电气工程基础')!.block, '专业核心课程');
  assert.deepEqual([by.get('电气工程基础')!.credits, by.get('电气工程基础')!.hours, by.get('电气工程基础')!.semester], [7, 128, '5']);
  assert.equal(by.get('电机设计')!.block, '专业限选课程');
  assert.equal(by.get('电机设计')!.module, 'A方向（电气设备与控制）', 'a 方向 line trailing the previous block still applies');
  assert.equal(by.get('电力系统分析')!.module, 'D方向（新型电力系统运行与控制）');
  assert.equal(by.get('电力系统继电保护')!.block, '专业任选课程');
  assert.equal(by.get('供配电工程')!.module, null);
  assert.ok(!t.courses.some((c) => /应修|合计/.test(c.name)));
});

test('glued course names (server run 2026-10-14): English tail with bracket / lower case, 模块 fragments, SDU HTML label cells', async () => {
  const { splitEnglish } = await import('../codetable.js');
  assert.deepEqual(splitEnglish('程序设计（C）Programming（C）'), { han: '程序设计（C）', en: 'Programming（C）' });
  assert.deepEqual(splitEnglish('深度学习 deep Learning'), { han: '深度学习', en: 'deep Learning' });
  assert.deepEqual(splitEnglish('面向对象程序设计（Java）'), { han: '面向对象程序设计（Java）', en: '' });
  assert.deepEqual(splitEnglish('嵌入式Linux应用开发'), { han: '嵌入式Linux应用开发', en: '' });
  // UPC 080601 / 080801 excerpts (real text layer)
  const fill = Array.from({ length: 14 }, (_, i) => `体育（4-${i}）\nUPE11011410${i % 10} | 1 | 32 | 0 | 0 | 0 | 32 | 0 | 1\nPhysical Education`).join('\n');
  const upc = `六、课程设置\n${fill}\nCST110211026 | 程序设计（C）Programming（C） | 2 | 36 | 24 | 12 | 24 | 1\n军事理论与国家安全\nMRX610111021 | 3 | 52 | 40 | 12 | 40 | 1\nMilitary Theory and National Security
工程电磁场 | 学科\nCNE322721031 | 2.5 | 42 | 36 | 6 | 36 | 4\nEngineering Electromagnetic Fields | 基础\n电气控制及可编程控制技术\n电力\nCNE321921026 | Electrical Control and Programmable | 2 | 36 | 24 | 12 | 24 | 5\n拖动\nControl Technology
微特电机 | 电力\nCNE323421020 | 2 | 36 | 24 | 12 | 24 | 6\nMicro&Special Motors | 拖动
CTL111721020 | 深度学习 deep Learning | 2 | 34 | 28 | 6 | 28 | 6\n数字图像处理\nCTL111321020 | 2 | 34 | 28 | 6 | 28 | 6\nDigital Image Processing\n七、毕业要求`;
  const u = parseCodeTable([{ page: 6, text: upc }])!;
  assert.deepEqual(u.courses.map((c) => c.name).filter((x) => !x.startsWith('体育')),
    ['程序设计（C）', '军事理论与国家安全', '工程电磁场', '电气控制及可编程控制技术', '微特电机', '深度学习', '数字图像处理']);
  // SDU 080902 HTML rows: a leading empty cell, a spaced vertical label and the name printed twice
  const rows = Array.from({ length: 15 }, (_, i) => `sd0721010${i % 10} | 课程${i} | 2 | 32 | 32 | | | | 考查 | 1 |`).join('\n');
  const html = `九、课程设置及学时分配表\n通识教育选修课程 | 00090 | 通识教育选修课程组 | 2 | 32 | 32 | | | | 考查 | 1-8 | 任选2学分\n| 通选类国际化课程 | 2 | 32 | 32 | | | | | |\n应修小计 | 4 | 64 | 64 | | | | | |\n${rows}\n应修小计 | 12 | 384 | 104 | | 280 | | | |\n创新 创业 计划 | 稷下创新 | 稷下创新 | 2 | 32 | 32 | | | | | |\n齐鲁创业 | 齐鲁创业 | 2 | 32 | 32 | | | | | |\n应修小计 | 4 | 64 | 64 | | | | | |`;
  const s = parseCodeTable([{ page: 1, text: html }])!;
  assert.equal(s.layout, 'sdu');
  const names = s.courses.map((c) => c.name);
  for (const nm of ['通选类国际化课程', '稷下创新', '齐鲁创业']) assert.ok(names.includes(nm), `${nm} in ${names.join(',')}`);
  assert.ok(!names.some((x) => /\||\s|(.{3,})\1/.test(x)), names.join(','));
});
