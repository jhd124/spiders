/** JOBS pipeline: normalizers, title classifier, UPC cleaner, ingest -> skills -> salary_stat. No network, no LLM. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = mkdtempSync(join(tmpdir(), 'jobs-test-'));
process.env.SPIDERS_DATA_DIR = TMP;
process.env.CAREER_DB = join(TMP, 'career.db');
delete process.env.LLM_API_KEY;
const HERE = dirname(fileURLToPath(import.meta.url));
const Database = (await import('better-sqlite3')).default;
const { migrate } = await import('../../CAREER/migrate.js');
const { decodeText, parseSalary, statMonthly, normCity, normEducation, normExperience, quarterOf, dedupeKey } = await import('../normalize.js');
const { classifyTitle, classifyPosting } = await import('../occupations.js');
const { cleanOne } = await import('../upc/clean.js');
const { pickPublic } = await import('../upc/crawler.js');
const { upsertPostings, reclassifyAll } = await import('../ingest.js');
const { tagPostings, matchTerms, makeTerm, nameTerms, llmExtractSkills } = await import('../skills.js');
const { computeSalaryStats, percentile, salaryWindowStart } = await import('../stats.js');
const { MockProvider } = await import('../../lib/llm.js');

test('parseSalary: units, ranges, 薪, yearly, open-ended, 面议, daily', () => {
  assert.deepEqual(parseSalary('6000-8000'), { min: 6000, max: 8000, months: null, note: '元' });
  assert.equal(parseSalary('10k-15k').min, 10000);
  assert.equal(parseSalary('10-15K·13薪').max, 15000);
  assert.equal(parseSalary('10-15K·13薪').months, 13);
  assert.deepEqual([parseSalary('1-1.5万').min, parseSalary('1-1.5万').max], [10000, 15000]);
  assert.deepEqual([parseSalary('1W-2W').min, parseSalary('1W-2W').max], [10000, 20000]);
  const y = parseSalary('24-36万/年');
  assert.deepEqual([y.min, y.max], [20000, 30000]);
  assert.match(y.note, /年薪/);
  assert.deepEqual([parseSalary('8000元以上').min, parseSalary('8000元以上').max], [8000, null]);
  assert.equal(parseSalary('面议').min, null);
  assert.equal(parseSalary('200元/天').min, null);
  assert.equal(parseSalary('8-12').min, 8000);
  assert.equal(parseSalary('50-80').max, 80000);
  assert.equal(parseSalary('').note, 'empty');
  assert.equal(parseSalary('1-2').min, 1000);
  assert.equal(parseSalary('100-200').min, null); // 元/月 out of range -> dropped
});

test('decodeText', () => {
  assert.equal(decodeText('大数据开发&nbsp;'), '大数据开发');
  assert.equal(decodeText('A&amp;B<br/>C'), 'A&B\nC');
});

test('statMonthly annualizes 薪 months', () => {
  assert.equal(statMonthly(10000, 20000, null), 15000);
  assert.equal(statMonthly(12000, 12000, 13), 13000);
  assert.equal(statMonthly(8000, null, null), 8000);
  assert.equal(statMonthly(null, null, null), null);
});

test('city / education / experience / quarter', () => {
  assert.equal(normCity('山东省青岛市市北区'), '青岛');
  assert.equal(normCity('北京市海淀区'), '北京');
  assert.equal(normCity('广东省深圳市'), '深圳');
  assert.equal(normCity('新疆维吾尔自治区乌鲁木齐市'), '乌鲁木齐');
  assert.equal(normCity('山东省济南市市辖区'), '济南');
  assert.equal(normCity(null), null);
  assert.equal(normEducation('不限,本科,硕士,博士'), '不限');
  assert.equal(normEducation('本科,硕士'), '本科');
  assert.equal(normEducation('硕士研究生及以上'), '硕士');
  assert.equal(normEducation(null), null);
  assert.equal(normExperience('3-5年'), 3);
  assert.equal(normExperience('应届毕业生'), 0);
  assert.equal(quarterOf('2026-10-12'), '2026Q4');
  assert.equal(quarterOf('2026-03-01T00:00:00Z'), '2026Q1');
  assert.equal(dedupeKey('甲公司', 'Java开发', '青岛', '1-2万'), dedupeKey('甲公司 ', 'Java开发（校招）', '青岛', '1-2万'));
});

test('classifyTitle: specific rules first, non-tech excluded', () => {
  assert.equal(classifyTitle('Java开发工程师')?.code, '2-02-10-03');
  assert.equal(classifyTitle('嵌入式软件工程师')?.code, '2-02-10-06');
  assert.equal(classifyTitle('图像算法工程师')?.code, '2-02-38-01');
  assert.equal(classifyTitle('大数据开发工程师')?.code, '2-02-38-03');
  assert.equal(classifyTitle('数据分析师')?.code, '2-02-30-09');
  assert.equal(classifyTitle('云平台运维开发')?.code, '2-02-38-04');
  assert.equal(classifyTitle('网络安全工程师')?.code, '2-02-10-07');
  assert.equal(classifyTitle('网络工程师')?.code, '2-02-10-04');
  assert.equal(classifyTitle('大数据开发&nbsp;')?.code, '2-02-38-03');
  assert.equal(classifyTitle('安全员'), null);
  assert.equal(classifyTitle('软件销售'), null);
  assert.equal(classifyTitle('硬件研发工程师'), null);
  assert.equal(classifyTitle('机械设计工程师'), null);
});

const fixture = JSON.parse(readFileSync(join(HERE, 'fixtures', 'upc_search_p1.json'), 'utf8')) as { data: { list: Record<string, unknown>[] } };
const cleaned = fixture.data.list.map((r) => cleanOne(pickPublic(r, 'fixture', '2026-10-14T00:00:00Z'))!);

test('UPC: only public fields kept, normalized posting', () => {
  const raw = pickPublic(fixture.data.list[0]!, 'Java', 't');
  assert.equal((raw as Record<string, unknown>).jltdyx, undefined, 'contact e-mail must not be stored');
  const a1 = cleaned[0]!;
  assert.equal(a1.id, 'upc:A1');
  assert.equal(a1.city, '青岛');
  assert.equal(a1.education, '本科');
  assert.equal(a1.channel, '校招');
  assert.equal(a1.salary_min_month, 10000);
  assert.equal(a1.occupation_code, '2-02-10-03');
  assert.match(a1.source_url, /career\.upc\.edu\.cn\/career\/zwxx\/view\/A1$/);
  assert.equal(cleaned[2]!.channel, '实习');
  assert.equal(cleaned[3]!.occupation_code, null);
  assert.equal(cleaned[4]!.salary_min_month, null);
});

test('skill terms: ascii word boundaries, name splitting', () => {
  assert.deepEqual(nameTerms('大数据平台（Hadoop/Spark）'), ['大数据平台', 'Hadoop', 'Spark']);
  assert.deepEqual(nameTerms('C/C++'), ['C++']);
  assert.deepEqual(nameTerms('Linux使用'), ['Linux']);
  const java = makeTerm('Java', 'software.java')!;
  assert.equal(matchTerms('熟悉JavaScript', [java]).size, 0);
  assert.equal(matchTerms('熟悉Java/Go', [java]).size, 1);
  assert.equal(makeTerm('C', 'x'), null);
  assert.equal(matchTerms('精通c++开发', [makeTerm('C++', 'software.c-cpp')!]).size, 1);
});

function db0() {
  migrate(process.env.CAREER_DB!, () => {});
  const db = new Database(process.env.CAREER_DB!);
  db.pragma('foreign_keys = OFF');
  return db;
}

test('migration 021 + ingest + term tagging + salary_stat', async () => {
  const db = db0();
  const cols = (db.prepare('PRAGMA table_info(job_posting)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['city', 'education', 'dedupe_key', 'raw_json', 'skills_extracted_at']) assert.ok(cols.includes(c), c);
  assert.ok((db.prepare('PRAGMA table_info(salary_stat)').all() as { name: string }[]).some((c) => c.name === 'education'));
  // more same-occupation postings so a group reaches the min sample
  const extra = [11000, 12000, 14000, 9000].map((s, i) => ({ ...cleaned[0]!, id: `upc:J${i}`, salary_raw: `${s}-${s + 4000}`, salary_min_month: s, salary_max_month: s + 4000, dedupe_key: `k${i}` }));
  const dup = { ...cleaned[0]!, id: 'upc:DUP' }; // same dedupe_key as A1 -> counted once
  assert.equal(upsertPostings(db, [...cleaned, ...extra, dup]), 10);
  assert.equal(upsertPostings(db, cleaned), 5, 'idempotent upsert');
  assert.equal((db.prepare('SELECT count(*) n FROM job_posting').get() as { n: number }).n, 10);

  const r = await tagPostings(db, { log: () => {} });
  assert.ok(r.tagged >= 3);
  const skillsOf = (id: string) => (db.prepare('SELECT skill_id FROM job_posting_skill WHERE posting_id = ? ORDER BY skill_id').all(id) as { skill_id: string }[]).map((x) => x.skill_id);
  assert.ok(skillsOf('upc:A1').includes('software.java'));
  assert.ok(skillsOf('upc:A1').includes('software.db-sql'));
  assert.ok(skillsOf('upc:A1').includes('software.linux'));
  assert.ok(skillsOf('upc:A2').includes('ai.dl'));
  assert.ok(skillsOf('upc:A2').includes('software.python'));
  assert.ok(skillsOf('upc:A5').includes('embedded.mcu'));
  assert.equal((await tagPostings(db, { log: () => {} })).scanned, 0, 'already extracted postings are not rescanned');

  const s = computeSalaryStats(db, { minSample: 5, log: () => {} });
  assert.ok(s.written > 0);
  const row = db.prepare(`SELECT * FROM salary_stat WHERE occupation_code = '2-02-10-03' AND city = '青岛' AND channel = '全部' AND education = '全部' AND quarter NOT LIKE '%-%'`).get() as
    { sample_size: number; p50_month: number; quarter: string; method_note: string } | undefined;
  assert.ok(row, 'qingdao software row');
  assert.equal(row.sample_size, 5, 'DUP collapsed by dedupe_key');
  assert.equal(row.quarter, '2026Q4');
  assert.equal(row.p50_month, 13000); // midpoints 11000 13000 13000 14000 16000
  assert.match(row.method_note, /midpoint/);
  assert.ok(db.prepare(`SELECT 1 FROM salary_stat WHERE city = '全国' AND occupation_code = '2-02-10-03'`).get());
  const ai = db.prepare(`SELECT sample_size, p50_month FROM salary_stat WHERE occupation_code = '2-02-38-01' AND city = '全国' AND channel = '全部' AND education = '全部' AND quarter NOT LIKE '%-%'`).get() as { sample_size: number; p50_month: number | null };
  assert.ok(ai.sample_size > 0 && ai.sample_size < 5);
  assert.equal(ai.p50_month, null, 'AI below min sample: count only');
  db.close();
});

test('percentile interpolation', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.25), 10);
});

test('LLM fallback hook with a stub provider: only listed skill ids survive', async () => {
  const stub = new MockProvider(() => JSON.stringify({ skills: [{ id: 'ai.ml', quote: '机器学习' }, { id: 'made.up', quote: 'x' }] }));
  const out = await llmExtractSkills(stub, '研究员', '要求机器学习背景', [{ id: 'ai.ml', name: '机器学习' }]);
  assert.deepEqual(out, [{ skill_id: 'ai.ml', quote: '机器学习' }]);
  const bad = new MockProvider(() => 'not json');
  assert.deepEqual(await llmExtractSkills(bad, 't', 'jd', [{ id: 'ai.ml', name: '机器学习' }]), []);

  const db = db0();
  db.prepare(`INSERT INTO job_posting (id, site, channel, title_raw, jd_text, occupation_code, source_url, fetched_at, extraction_method)
    VALUES ('t:1', 't', '校招', '研究员（AI）', '要求有良好的科研能力', '2-02-38-01', 'u', '2026-10-14', 'api')`).run();
  const r = await tagPostings(db, { llm: new MockProvider(() => '{"skills":[{"id":"ai.ml","quote":"科研"}]}'), log: () => {} });
  assert.equal(r.llmTagged, 1);
  assert.deepEqual(db.prepare(`SELECT method, confidence FROM job_posting_skill WHERE posting_id = 't:1'`).get(), { method: 'llm', confidence: 0.5 });
  db.close();
});

test('expert classification rules (2026-10-14)', () => {
  const code = (t: string) => classifyPosting(t).code;
  assert.equal(code('机器视觉工程师'), '2-02-38-01');
  assert.equal(code('视觉工程师'), '2-02-38-01');
  for (const t of ['视觉设计', '视觉设计师']) assert.deepEqual([code(t), classifyPosting(t).reason], [null, 'design'], t);
  assert.deepEqual([code('视觉管培生'), classifyPosting('视觉管培生').reason], [null, 'mgmt_trainee']);
  assert.equal(code('网络安全员'), '2-02-10-07');
  assert.equal(code('网络、信息安全管理'), '2-02-10-07');
  assert.equal(code('安全员'), null);
  assert.equal(code('需求工程师'), '2-02-10-03');
  assert.equal(code('软件测试工程师'), '2-02-10-03');
  assert.deepEqual(classifyPosting('软件测试 | 硬件测试'), { code: '2-02-10-03', confidence: 0.8, multiRole: false, reason: 'first_role' });
  assert.equal(code('集成电路设计-深圳'), null);
  for (const t of ['系统开发、测试、应用维护、网络与信息安全管理……', '职能类岗位（数据分析/数据管理/软件开发工程师/…）', '算法工程师、Java开发、测试、运维、产品经理、UI设计、数据分析、网络安全、嵌入式、硬件、销售、运营']) {
    const c = classifyPosting(t);
    assert.deepEqual([c.code, c.multiRole, c.reason], [null, true, 'multi_role'], t);
  }
  for (const t of ['腾讯云智研发2024届校园招聘', '某某公司2025届校园招聘', '招聘岗位汇总']) assert.deepEqual([code(t), classifyPosting(t).reason], [null, 'generic'], t);
  for (const t of ['销售管培生', '大数据与会计专业教师', '课程顾问', '营销培训生', '软件销售']) assert.deepEqual([code(t), classifyPosting(t).reason], [null, 'excluded_word'], t);
  assert.notEqual(classifyPosting('技术管培生').reason, 'mgmt_trainee', '管培 with a tech word is not excluded by the 管培 rule');
  assert.equal(code('嵌入式软件设计'), '2-02-10-06', '设计 with a tech word is not a design job');
});

test('reclassify on ingest + multi-role / 面议 / window / min sample in salary_stat', async () => {
  const db = db0();
  db.exec('DELETE FROM job_posting_skill; DELETE FROM job_posting; DELETE FROM salary_stat;');
  const base = { ...cleaned[0]!, published_at: '2026-09-01', channel: '校招' as const, education: '本科' as const, city: '青岛' };
  const mk = (id: string, title: string, sal: number | null, extra: Record<string, unknown> = {}) => ({ ...base, id, title_raw: title, dedupe_key: id,
    salary_raw: sal == null ? '面议' : `${sal}-${sal + 2000}`, salary_min_month: sal, salary_max_month: sal == null ? null : sal + 2000, salary_note: sal == null ? '面议' : '元', ...extra });
  const ps = [
    ...Array.from({ length: 30 }, (_, i) => mk(`sw${i}`, '软件测试工程师', 8000 + i * 100)),
    mk('old', 'Java开发工程师', 50000, { published_at: '2023-05-01' }),        // outside 24-month window
    mk('neg', 'Java开发工程师', null),                                          // 面议
    mk('multi', '系统开发、测试、应用维护、网络与信息安全管理', 90000),          // multi-role
    ...Array.from({ length: 3 }, (_, i) => mk(`ai${i}`, '机器视觉工程师', 12000)),
  ];
  upsertPostings(db, ps);
  // simulate a row stored under old rules: reclassify must fix it even if it is not in this run's clean file
  db.prepare(`UPDATE job_posting SET occupation_code = '2-02-10-03', multi_role = 0 WHERE id = 'multi'`).run();
  const rc = reclassifyAll(db);
  assert.ok(rc.changed >= 1);
  assert.deepEqual(db.prepare(`SELECT occupation_code, multi_role, classify_reason FROM job_posting WHERE id = 'multi'`).get(), { occupation_code: null, multi_role: 1, classify_reason: 'multi_role' });
  await tagPostings(db, { log: () => {} });
  assert.notEqual((db.prepare(`SELECT skills_extracted_at s FROM job_posting WHERE id = 'multi'`).get() as { s: string | null }).s, null, 'multi-role postings still get skill matching');

  const s = computeSalaryStats(db, { now: new Date('2026-10-14T08:00:00Z'), log: () => {} });
  assert.equal(s.since, '2024-10-01');
  assert.equal(s.window, '2024Q4-2026Q4');
  assert.equal(s.outside, 1, 'the 2023 posting is outside the window');
  const ov = db.prepare(`SELECT * FROM salary_overview WHERE occupation_code = '2-02-10-03' AND education = '全部'`).get() as { sample_size: number; p50_month: number | null; window: string };
  assert.equal(ov.window, '2024Q4-2026Q4');
  assert.equal(ov.sample_size, 30, '面议, old and multi-role postings are not counted');
  assert.ok(ov.p50_month != null && ov.p50_month < 20000);
  const ai = db.prepare(`SELECT sample_size, p25_month, p50_month, p75_month FROM salary_overview WHERE occupation_code = '2-02-38-01' AND education = '本科'`).get();
  assert.deepEqual(ai, { sample_size: 3, p25_month: null, p50_month: null, p75_month: null }, '< 30: count only');
  assert.equal(db.prepare(`SELECT 1 FROM salary_stat WHERE quarter IN ('2023Q2')`).get(), undefined);
  db.close();
});

test('salary window start: rolling 24 months to quarter start, or fixed', () => {
  assert.equal(salaryWindowStart(new Date(2026, 9, 14), 24, undefined), '2024-10-01');
  assert.equal(salaryWindowStart(new Date(2027, 0, 5), 24, undefined), '2025-01-01');
  assert.equal(salaryWindowStart(new Date(2026, 9, 14), 24, '2024-10-01'), '2024-10-01');
});
