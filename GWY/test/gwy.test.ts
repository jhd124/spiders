/** GWY: age clause, 专业 splitting/matching, grad catalog parsing, 职位表 zip/xlsx parsing, ingest end-to-end. No network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

const TMP = mkdtempSync(join(tmpdir(), 'gwy-'));
process.env.SPIDERS_DATA_DIR = TMP;
process.env.CAREER_DB = join(TMP, 'career.db');

const { parseAge, remarksList, splitMajors, splitCodes, needsGrad, segmentFor, matchPhrase, matchMajors, parseGradCatalog, workbooksFrom, positionRows, parseCsv } = await import('../parse.js');
const { GK2027 } = await import('../sources.js');
type Catalogs = import('../parse.js').Catalogs;

const cat: Catalogs = {
  majors: new Map([['080901', '计算机科学与技术'], ['080902', '软件工程'], ['080910T', '数据科学与大数据技术'], ['120402', '行政管理'], ['030101K', '法学'], ['082701', '食品科学与工程']]),
  classes: new Map([['0809', '计算机类'], ['0301', '法学类']]),
  ugCategories: new Map([['08', '工学']]),
  grad: new Map([['08', '工学'], ['0812', '计算机科学与技术'], ['0835', '软件工程'], ['0351', '法律'], ['0301', '法学'], ['0832', '食品科学与工程'], ['1004', '公共卫生与预防医学']]),
};

test('age rule from the 2027 国考 notice', () => {
  assert.deepEqual(parseAge(GK2027.age_text), { age_min: 18, age_max: 38, age_max_relaxed: 43, age_relaxed_for: '2027年应届硕士、博士研究生' });
  assert.deepEqual(parseAge('18周岁以上、35周岁以下（1990年10月至2008年10月期间出生），对于2026年应届硕士研究生和博士研究生（非在职人员）报考的，年龄可放宽到40周岁以下'),
    { age_min: 18, age_max: 35, age_max_relaxed: 40, age_relaxed_for: '2026年应届硕士研究生和博士研究生' });
  assert.deepEqual(parseAge('无年龄说明'), { age_min: null, age_max: null, age_max_relaxed: null, age_relaxed_for: null });
});

test('专业 splitting: levels, separators, brackets kept together', () => {
  assert.deepEqual(splitMajors('本科：0809计算机类、法学类；研究生：0812计算机科学与技术'),
    [{ level: 'undergrad', phrase: '0809计算机类' }, { level: 'undergrad', phrase: '法学类' }, { level: 'grad', phrase: '0812计算机科学与技术' }]);
  assert.deepEqual(splitMajors('经济学（含金融、财政）、不限'), [{ level: 'any', phrase: '经济学（含金融、财政）' }, { level: 'any', phrase: '不限' }]);
});

const m = (p: string, l: 'any' | 'undergrad' | 'grad' = 'any', seg: 'any' | 'undergrad' | 'grad' = l, rules: Parameters<typeof matchPhrase>[3] = []) => {
  const r = matchPhrase(p, l, cat, rules, seg); return [r.catalog, r.major_code, r.match_type, r.code_doubtful];
};

test('verbatim matches; 不限 / 相关专业 / unknown names are not guessed', () => {
  assert.deepEqual(m('080901计算机科学与技术'), ['undergrad', '080901', 'exact', 0]);
  assert.deepEqual(m('080910数据科学与大数据技术'), ['undergrad', '080910T', 'exact', 0], 'T suffix omitted, name agrees');
  assert.deepEqual(m('法律', 'grad'), ['grad', '0351', 'exact', 0]);
  assert.deepEqual(m('软件工程', 'undergrad'), ['undergrad', '080902', 'exact', 0]);
  assert.deepEqual(m('软件工程'), [null, 'undergrad:080902|grad:0835', 'exact', 0], 'segment unknown: both catalogs kept');
  assert.deepEqual(m('工学', 'undergrad'), ['undergrad', '08', 'category', 0]);
  assert.deepEqual(m('不限'), [null, null, 'unlimited', 0]);
  assert.deepEqual(m('计算机相关专业'), [null, null, 'related', 0]);
  assert.deepEqual(m('人工智能工程'), [null, null, 'unresolved', 0]);
  assert.equal(matchMajors('', cat)[0]!.match_type, 'unresolved');
});

test('ruling 1: code and name disagree → the name wins, code_doubtful', () => {
  assert.deepEqual(m('120401行政管理'), ['undergrad', '120402', 'exact', 1]);
  assert.deepEqual(m('0812计算机科学与技术', 'undergrad'), ['undergrad', '080901', 'exact', 1], '本科 segment: name is a 本科 major');
  // a 硕士 position printing a 本科-only name: still matched by name (flagged), but never counted for 本科
  const r = matchPhrase('120401行政管理', 'any', cat, [], 'grad');
  assert.deepEqual([r.catalog, r.major_code, r.code_doubtful, r.undergrad_majors], ['undergrad', '120402', 1, []]);
});

test('ruling 2: 4-digit codes by segment; 专业类 expands; several codes with one name', () => {
  const ug = matchPhrase('0809计算机类', 'undergrad', cat);
  assert.deepEqual([ug.catalog, ug.major_code, ug.match_type, ug.undergrad_majors], ['undergrad', '0809', 'category', ['080901', '080902', '080910T']]);
  assert.deepEqual(m('0809计算机', 'undergrad'), ['undergrad', '0809', 'category', 0], '本科 4-digit code = 专业类 even without 类');
  assert.deepEqual(m('0812计算机科学与技术', 'grad'), ['grad', '0812', 'exact', 0], '研究生 4-digit code = 一级学科');
  assert.deepEqual(matchPhrase('0812计算机科学与技术', 'grad', cat).undergrad_majors, []);
  assert.deepEqual(m('（0832、0972）食品科学与工程'), ['grad', '0832', 'exact', 1], '0832 agrees (picks 研究生 over 本科 082701), 0972 not in catalog → flagged');
  assert.deepEqual(m('（0832、082701）食品科学与工程'), [null, 'undergrad:082701|grad:0832', 'exact', 0], 'both codes agree → both count');
  assert.deepEqual(m('（0779、1004 ）公共卫生与预防医学'), ['grad', '1004', 'exact', 1]);
  assert.deepEqual(splitCodes('计算机类（0809）'), { codes: ['0809'], name: '计算机类' });
});

test('ruling 3: segment from 学历; 硕士+ positions are 需读研后报考', () => {
  assert.equal(needsGrad('硕士研究生及以上'), true); assert.equal(needsGrad('仅限博士研究生'), true); assert.equal(needsGrad('研究生'), true);
  assert.equal(needsGrad('本科及以上'), false); assert.equal(needsGrad('本科或硕士研究生'), false); assert.equal(needsGrad('仅限本科'), false);
  assert.equal(segmentFor('仅限硕士研究生'), 'grad'); assert.equal(segmentFor('仅限本科'), 'undergrad'); assert.equal(segmentFor('本科及以上'), 'any');
  const g = matchMajors('软件工程', cat, [], '硕士研究生及以上')[0]!;
  assert.deepEqual([g.segment, g.major_code, g.undergrad_majors], ['grad', '0835', []]);
  const u = matchMajors('本科：软件工程；研究生：软件工程', cat, [], '本科及以上');
  assert.deepEqual(u.map((x) => [x.segment, x.major_code, x.undergrad_majors]), [['undergrad', '080902', ['080902']], ['grad', '0835', []]]);
});

test('rules: a 国考 custom category name maps to a list of MOE codes (majors and 专业类, expanded)', () => {
  const rules = [{ id: 3, phrase: '计算机法学类', level: 'any' as const, catalog: 'undergrad' as const, major_code: '0809|030101', match_type: 'category' as const }];
  const r = matchPhrase('计算机法学类', 'any', cat, rules, 'any');
  assert.deepEqual([r.rule_id, r.match_type, r.major_code, r.undergrad_majors], [3, 'category', '0809|030101K', ['030101K', '080901', '080902', '080910T']]);
  assert.deepEqual(matchPhrase('计算机法学类', 'any', cat, rules, 'grad').undergrad_majors, [], 'never counted for 本科 in the 研究生 segment');
  const g = matchPhrase('X类', 'any', cat, [{ id: 4, phrase: 'X类', level: 'any', catalog: null, major_code: 'grad:0812|undergrad:080902', match_type: 'category' }]);
  assert.deepEqual([g.major_code, g.undergrad_majors], ['grad:0812|undergrad:080902', ['080902']]);
});

test('grad catalog lines (official PDF text)', () => {
  const g = parseGradCatalog(['说明', '01哲学', '0101哲学', '0151应用伦理*', '08 工学', '0812计算机科学与技术（可授工学、理学学位）', '0854   电子信息', '— 1 —', '0999不属于门类']);
  assert.deepEqual(g.map((x) => [x.code, x.name, x.kind, x.master_only, x.note]), [
    ['01', '哲学', 'category', 0, null], ['0101', '哲学', 'academic', 0, null], ['0151', '应用伦理', 'professional', 1, null],
    ['08', '工学', 'category', 0, null], ['0812', '计算机科学与技术', 'academic', 0, '可授工学、理学学位'], ['0854', '电子信息', 'professional', 0, null]]);
});

const HEADER = ['部门代码', '部门名称', '用人司局', '机构性质', '招考职位', '职位属性', '职位分布', '职位简介', '职位代码', '机构层级', '考试类别', '招考人数', '专业', '学历', '学位', '政治面貌', '基层工作最低年限', '服务基层项目工作经历', '是否在面试阶段组织专业能力测试', '面试人员比例', '工作地点', '落户地点', '备注', '部门网站', '咨询电话1', '咨询电话2', '咨询电话3'];
function book(rows: string[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['中央机关及其直属机构2027年度考试录用公务员招考简章'], HEADER, ...rows]), '中央国家行政机关省级以下直属机构');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['说明'], ['无表头']]), '说明');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}
const row = (code: string, major: string, hires = '2', edu = '本科及以上') => HEADER.map((h) => ({ 部门代码: '130110', 职位代码: code, 专业: major, 招考人数: hires, 学历: edu, 部门名称: '国家税务总局北京市税务局' } as Record<string, string>)[h] ?? `${h}值`);

test('职位表: zip → workbooks → rows with every column verbatim', async () => {
  const zip = new JSZip();
  zip.folder('招考简章')!.file('中央机关及其直属机构2027年度考试录用公务员招考简章.xlsx', book([row('300110001001', '本科：0809计算机类；研究生：0812计算机科学与技术'), row('300110001002', '不限', '3'), ['', '']]));
  zip.file('readme.txt', 'x');
  const data = await zip.generateAsync({ type: 'uint8array' });
  const wbs = await workbooksFrom('gk2027_zhaokaojianzhang.zip', data);
  assert.equal(wbs.length, 1);
  const { rows, skipped, ignored } = positionRows(wbs[0]!);
  assert.deepEqual(ignored.map((x) => x.split('/').pop()), ['说明']);
  assert.equal(rows.length, 2);
  assert.deepEqual(skipped, [], 'headerless sheet is not a failure');
  assert.equal(rows[0]!.raw['专业'], '本科：0809计算机类；研究生：0812计算机科学与技术');
  assert.equal(Object.keys(rows[0]!.raw).length, HEADER.length);
  assert.equal(rows[0]!.cols.position_code, '300110001001');
  assert.equal(rows[0]!.cols.phone3, '咨询电话3值');
});

test('expert rules file: 财会审计类 / 社会保障类 with source 专家规则; codes outside our catalog kept but flagged', async () => {
  const { RULES_CSV } = await import('../ingest.js');
  const rows = parseCsv(readFileSync(RULES_CSV, 'utf8'));
  const byPhrase = Object.fromEntries(rows.map((r) => [r.phrase, r]));
  assert.equal(byPhrase['财会审计类']!.source, '专家规则'); assert.equal(byPhrase['社会保障类']!.source, '专家规则');
  const rules = rows.map((r, i) => ({ id: i + 1, source: r.source, phrase: r.phrase!, level: r.level as 'any', catalog: (r.catalog || null) as null, major_code: r.major_code!, match_type: r.match_type as 'category' }));
  const c2: Catalogs = { ...cat, majors: new Map([...cat.majors, ['120203K', '会计学'], ['120204', '财务管理'], ['120207', '审计学'], ['120208', '资产评估'], ['120213T', '财务会计教育'], ['120403', '劳动与社会保障'], ['120401', '公共事业管理'], ['020303', '保险学'], ['030302', '社会工作']]),
    grad: new Map([...cat.grad, ['1253', '会计'], ['0352', '社会工作']]) };
  const a = matchPhrase('财会审计类', 'any', c2, rules, 'any');
  assert.deepEqual([a.rule_id, a.match_type, a.code_doubtful, a.undergrad_majors], [1, 'category', 1, ['120203K', '120204', '120207', '120208', '120213T']]);
  assert.match(a.major_code!, /grad:120201\|grad:1253\|grad:0257$/);
  assert.deepEqual(matchPhrase('社会保障类', 'any', c2, rules, 'any').undergrad_majors, ['020303', '030302', '120401', '120403']);
  assert.deepEqual(matchPhrase('财会审计类', 'any', c2, rules, 'grad').undergrad_majors, [], '研究生 segment never feeds 本科 counts');
});

test('备注 listing a phrase\'s majors overrides the rule; unparseable list → unresolved', () => {
  const rules = [{ id: 1, phrase: '计算机大类', level: 'any' as const, catalog: null, major_code: '0809', match_type: 'category' as const }];
  assert.deepEqual(remarksList('计算机大类', '计算机大类专业包括软件工程、计算机科学与技术。本单位不提供宿舍'), ['软件工程', '计算机科学与技术']);
  assert.deepEqual(remarksList('计算机大类', '计算机大类（含软件工程）'), ['软件工程']);
  assert.equal(remarksList('计算机大类', '取得注册会计师证书'), null);
  const [o] = matchMajors('计算机大类', cat, rules, '本科及以上', '计算机大类专业包括软件工程、计算机科学与技术。');
  assert.deepEqual([o!.remarks_override, o!.rule_id, o!.undergrad_majors], [1, null, ['080901', '080902']]);
  const [n] = matchMajors('计算机大类', cat, rules, '本科及以上');
  assert.deepEqual([n!.remarks_override, n!.rule_id, n!.undergrad_majors.length], [0, 1, 3], 'no 备注 list: rule applies');
  const [u] = matchMajors('计算机大类', cat, rules, '本科及以上', '计算机大类专业包括软件工程、量子玄学。');
  assert.deepEqual([u!.remarks_override, u!.match_type, u!.undergrad_majors], [2, 'unresolved', []]);
});

const CATS = ['哲学', '经济学', '法学', '教育学', '文学', '历史学', '理学', '工学', '农学', '医学', '军事学', '管理学'];
const GRAD_LINES = CATS.flatMap((c, i) => { const cc = String(i + 1).padStart(2, '0'); return [`${cc}${c}`, ...'甲乙丙丁戊己庚辛壬'.split('').map((x, j) => `${cc}${String(j + 20).padStart(2, '0')}${c}${x}科`)]; })
  .concat(['08工学', '0812计算机科学与技术（可授工学、理学学位）']);
test('crawler reads the default data/civil-service zip; ingest stores notice, positions, matches, rules and the unresolved report', async () => {
  const zip = new JSZip();
  zip.file('招考简章.xlsx', book([row('300110001001', '本科：0809计算机类；研究生：0812计算机科学与技术'), row('300110001002', '计算机相关专业、人工智能工程', '3'), row('300110001003', '人工智能工程', '1'), row('300110001004', '软件工程', '5', '硕士研究生及以上')]));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(TMP, 'civil-service'), { recursive: true });
  writeFileSync(GK2027.default_file, await zip.generateAsync({ type: 'uint8array' }));
  const { setRunSink } = await import('../../lib/crawllog.js');
  setRunSink(() => {});
  const { crawl } = await import('../gk2027/crawler.js');
  const dump = await crawl([]);
  assert.equal(dump.rows.length, 4);
  assert.ok(dump.source.startsWith('file:'));

  const { migrate } = await import('../../CAREER/migrate.js');
  migrate(process.env.CAREER_DB!, () => {});
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(process.env.CAREER_DB!);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO major_category (code, name, catalog_edition, source_url) VALUES ('08', '工学', 2026, 'x')").run();
  db.prepare("INSERT INTO major_class (code, name, category_code, catalog_edition, source_url) VALUES ('0809', '计算机类', '08', 2026, 'x')").run();
  for (const [c, n] of [['080901', '计算机科学与技术'], ['080902', '软件工程']]) db.prepare("INSERT INTO major (code, base_code, name, category_code, category_name, class_code, class_name, is_special, is_controlled, is_engineering, degree_categories, catalog_edition, source_url, updated_at) VALUES (?, ?, ?, '08', '工学', '0809', '计算机类', 0, 0, 1, '工学', 2026, 'x', 'x')").run(c, c, n);
  db.close();
  const rules = join(TMP, 'rules.csv');
  writeFileSync(rules, '# c\nphrase,level,catalog,major_code,match_type,note,reviewer\n人工智能工程,any,,,unresolved,"待定, 需专家",expert\n');
  const { ingest } = await import('../ingest.js');
  const r = ingest({ rulesCsv: rules, gradLines: GRAD_LINES });
  assert.equal(r.positions, 4); assert.equal(r.hires, 11);
  assert.deepEqual(r.by_type, { exact: 2, category: 1, unlimited: 0, related: 1, unresolved: 2 });
  assert.equal(r.positions_all_resolved, 2);
  assert.deepEqual(r.undergrad, { positions: 3, hires: 6, positions_with_match: 1, hires_with_match: 2, position_majors: 2, distinct_majors: 2, positions_incomplete: 2, hires_incomplete: 4 });
  assert.deepEqual(r.remarks_override, { applied: 0, unparsed: 0 });
  assert.deepEqual(r.needs_grad, { positions: 1, hires: 5, positions_with_match: 1, hires_with_match: 5 });
  assert.deepEqual(r.unresolved.map((u) => [u.phrase, u.positions, u.hires]), [['人工智能工程', 2, 4], ['计算机相关专业', 1, 3]]);
  const ro = new Database(process.env.CAREER_DB!, { readonly: true });
  const n = ro.prepare("SELECT age_min, age_max, age_max_relaxed FROM gwy_notice WHERE id = 'gk2027'").get();
  assert.deepEqual(n, { age_min: 18, age_max: 38, age_max_relaxed: 43 });
  assert.equal(JSON.parse((ro.prepare("SELECT raw_json FROM gwy_position WHERE position_code = '300110001001'").get() as { raw_json: string }).raw_json)['部门名称'], '国家税务总局北京市税务局');
  assert.deepEqual(ro.prepare("SELECT note, reviewer FROM gwy_major_rule").get(), { note: '待定, 需专家', reviewer: 'expert' });
  assert.equal((ro.prepare("SELECT reviewed FROM gwy_position_major WHERE rule_id IS NOT NULL LIMIT 1").get() as { reviewed: number }).reviewed, 1);
  assert.deepEqual(ro.prepare("SELECT position_code, major_code FROM gwy_position_undergrad_major ORDER BY 1, 2").all(),
    [{ position_code: '300110001001', major_code: '080901' }, { position_code: '300110001001', major_code: '080902' }], '硕士 position 004 not in 本科 counts');
  assert.equal((ro.prepare("SELECT needs_grad FROM gwy_position WHERE position_code = '300110001004'").get() as { needs_grad: number }).needs_grad, 1);
  assert.deepEqual(ro.prepare("SELECT position_code, majors_incomplete FROM gwy_position ORDER BY 1").all().map((x: any) => x.majors_incomplete), [0, 1, 1, 0]);
  ro.close();
  const csv = parseCsv(readFileSync(join(TMP, 'civil-service', 'gk2027_unresolved_majors.csv'), 'utf8'));
  assert.equal(csv[0]!.phrase, '人工智能工程'); assert.equal(csv[0]!.positions, '2');
  // re-ingest is idempotent
  assert.equal(ingest({ rulesCsv: rules, gradLines: null }).positions, 4);
});

test('trailing code forms: bracketed 专业代码 and bare suffix', () => {
  assert.deepEqual(splitCodes('会计学（专业代码120203K）'), { codes: ['120203K'], name: '会计学' });
  assert.deepEqual(splitCodes('软件工程0835'), { codes: ['0835'], name: '软件工程' });
  assert.deepEqual(m('软件工程0835', 'grad'), ['grad', '0835', 'exact', 0]);
});
