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

const { parseAge, splitMajors, matchPhrase, matchMajors, parseGradCatalog, workbooksFrom, positionRows, parseCsv } = await import('../parse.js');
const { GK2027 } = await import('../sources.js');
type Catalogs = import('../parse.js').Catalogs;

const cat: Catalogs = {
  majors: new Map([['080901', '计算机科学与技术'], ['080902', '软件工程'], ['080910T', '数据科学与大数据技术'], ['120402', '行政管理'], ['030101K', '法学']]),
  classes: new Map([['0809', '计算机类'], ['0301', '法学类']]),
  ugCategories: new Map([['08', '工学']]),
  grad: new Map([['08', '工学'], ['0812', '计算机科学与技术'], ['0835', '软件工程'], ['0351', '法律'], ['0301', '法学']]),
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

test('matching is verbatim only; conflicts, 相关专业 and unknown names are not guessed', () => {
  const m = (p: string, l: 'any' | 'undergrad' | 'grad' = 'any') => { const r = matchPhrase(p, l, cat); return [r.catalog, r.major_code, r.match_type]; };
  assert.deepEqual(m('080901计算机科学与技术'), ['undergrad', '080901', 'exact']);
  assert.deepEqual(m('080910数据科学与大数据技术'), ['undergrad', '080910T', 'exact'], 'T suffix omitted, name agrees');
  assert.deepEqual(m('0809计算机类'), ['undergrad', '0809', 'category']);
  assert.deepEqual(m('0812计算机科学与技术'), ['grad', '0812', 'exact']);
  assert.deepEqual(m('计算机类', 'undergrad'), ['undergrad', '0809', 'category']);
  assert.deepEqual(m('法律', 'grad'), ['grad', '0351', 'exact']);
  assert.deepEqual(m('软件工程', 'undergrad'), ['undergrad', '080902', 'exact']);
  assert.deepEqual(m('软件工程'), [null, 'undergrad:080902|grad:0835', 'exact'], 'level unknown: both catalogs kept');
  assert.deepEqual(m('工学', 'undergrad'), ['undergrad', '08', 'category']);
  assert.deepEqual(m('不限'), [null, null, 'unlimited']);
  assert.deepEqual(m('计算机相关专业'), [null, null, 'related']);
  assert.deepEqual(m('120401行政管理'), [null, null, 'unresolved'], 'code/name disagree (120401 is 公共事业管理)');
  assert.deepEqual(m('人工智能工程'), [null, null, 'unresolved'], 'not in any catalog');
  assert.deepEqual(m('0812计算机科学与技术', 'undergrad'), [null, null, 'unresolved'], '4-digit grad code under 本科');
  const rule = { id: 7, phrase: '人工智能工程', level: 'any' as const, catalog: 'undergrad' as const, major_code: '080717T', match_type: 'exact' as const };
  assert.deepEqual(matchPhrase('人工智能工程', 'any', cat, [rule]).rule_id, 7, 'expert rule wins');
  assert.equal(matchMajors('', cat)[0]!.match_type, 'unresolved');
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
const row = (code: string, major: string, hires = '2') => HEADER.map((h) => ({ 部门代码: '130110', 职位代码: code, 专业: major, 招考人数: hires, 部门名称: '国家税务总局北京市税务局' } as Record<string, string>)[h] ?? `${h}值`);

test('职位表: zip → workbooks → rows with every column verbatim', async () => {
  const zip = new JSZip();
  zip.folder('招考简章')!.file('中央机关及其直属机构2027年度考试录用公务员招考简章.xlsx', book([row('300110001001', '本科：0809计算机类；研究生：0812计算机科学与技术'), row('300110001002', '不限', '3'), ['', '']]));
  zip.file('readme.txt', 'x');
  const data = await zip.generateAsync({ type: 'uint8array' });
  const wbs = await workbooksFrom('gk2027_zhaokaojianzhang.zip', data);
  assert.equal(wbs.length, 1);
  const { rows, skipped } = positionRows(wbs[0]!);
  assert.equal(rows.length, 2);
  assert.match(skipped.join('\n'), /说明: no header row/);
  assert.equal(rows[0]!.raw['专业'], '本科：0809计算机类；研究生：0812计算机科学与技术');
  assert.equal(Object.keys(rows[0]!.raw).length, HEADER.length);
  assert.equal(rows[0]!.cols.position_code, '300110001001');
  assert.equal(rows[0]!.cols.phone3, '咨询电话3值');
});

const CATS = ['哲学', '经济学', '法学', '教育学', '文学', '历史学', '理学', '工学', '农学', '医学', '军事学', '管理学'];
const GRAD_LINES = CATS.flatMap((c, i) => { const cc = String(i + 1).padStart(2, '0'); return [`${cc}${c}`, ...'甲乙丙丁戊己庚辛壬'.split('').map((x, j) => `${cc}${String(j + 20).padStart(2, '0')}${c}${x}科`)]; })
  .concat(['08工学', '0812计算机科学与技术（可授工学、理学学位）']);
test('crawler reads the default data/civil-service zip; ingest stores notice, positions, matches, rules and the unresolved report', async () => {
  const zip = new JSZip();
  zip.file('招考简章.xlsx', book([row('300110001001', '本科：0809计算机类；研究生：0812计算机科学与技术'), row('300110001002', '计算机相关专业、人工智能工程', '3'), row('300110001003', '人工智能工程', '1')]));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(TMP, 'civil-service'), { recursive: true });
  writeFileSync(GK2027.default_file, await zip.generateAsync({ type: 'uint8array' }));
  const { setRunSink } = await import('../../lib/crawllog.js');
  setRunSink(() => {});
  const { crawl } = await import('../gk2027/crawler.js');
  const dump = await crawl([]);
  assert.equal(dump.rows.length, 3);
  assert.ok(dump.source.startsWith('file:'));

  const { migrate } = await import('../../CAREER/migrate.js');
  migrate(process.env.CAREER_DB!, () => {});
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(process.env.CAREER_DB!);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO major_category (code, name, catalog_edition, source_url) VALUES ('08', '工学', 2026, 'x')").run();
  db.prepare("INSERT INTO major_class (code, name, category_code, catalog_edition, source_url) VALUES ('0809', '计算机类', '08', 2026, 'x')").run();
  db.close();
  const rules = join(TMP, 'rules.csv');
  writeFileSync(rules, '# c\nphrase,level,catalog,major_code,match_type,note,reviewer\n人工智能工程,any,,,unresolved,"待定, 需专家",expert\n');
  const { ingest } = await import('../ingest.js');
  const r = ingest({ rulesCsv: rules, gradLines: GRAD_LINES });
  assert.equal(r.positions, 3); assert.equal(r.hires, 6);
  assert.deepEqual(r.by_type, { exact: 1, category: 1, unlimited: 0, related: 1, unresolved: 2 });
  assert.equal(r.positions_all_resolved, 1);
  assert.deepEqual(r.unresolved.map((u) => [u.phrase, u.positions, u.hires]), [['人工智能工程', 2, 4], ['计算机相关专业', 1, 3]]);
  const ro = new Database(process.env.CAREER_DB!, { readonly: true });
  const n = ro.prepare("SELECT age_min, age_max, age_max_relaxed FROM gwy_notice WHERE id = 'gk2027'").get();
  assert.deepEqual(n, { age_min: 18, age_max: 38, age_max_relaxed: 43 });
  assert.equal(JSON.parse((ro.prepare("SELECT raw_json FROM gwy_position WHERE position_code = '300110001001'").get() as { raw_json: string }).raw_json)['部门名称'], '国家税务总局北京市税务局');
  assert.deepEqual(ro.prepare("SELECT note, reviewer FROM gwy_major_rule").get(), { note: '待定, 需专家', reviewer: 'expert' });
  assert.equal((ro.prepare("SELECT reviewed FROM gwy_position_major WHERE rule_id IS NOT NULL LIMIT 1").get() as { reviewed: number }).reviewed, 1);
  ro.close();
  const csv = parseCsv(readFileSync(join(TMP, 'civil-service', 'gk2027_unresolved_majors.csv'), 'utf8'));
  assert.equal(csv[0]!.phrase, '人工智能工程'); assert.equal(csv[0]!.positions, '2');
  // re-ingest is idempotent
  assert.equal(ingest({ rulesCsv: rules, gradLines: null }).positions, 3);
});
