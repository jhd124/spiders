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
const { classifyTitle, classifyPosting, normalizeTitle, embeddedEvidence } = await import('../occupations.js');
const { cleanOne } = await import('../upc/clean.js');
const { pickPublic } = await import('../upc/crawler.js');
const { upsertPostings, reclassifyAll, applyEmbeddedRule } = await import('../ingest.js');
const { tagPostings, matchTerms, makeTerm, nameTerms, llmExtractSkills } = await import('../skills.js');
const { computeSalaryStats, percentile, salaryWindowStart, sourceLabel } = await import('../stats.js');
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
  assert.ok(db.prepare(`SELECT 1 FROM salary_stat WHERE city = '全部' AND occupation_code = '2-02-10-03'`).get());
  const ai = db.prepare(`SELECT sample_size, p50_month FROM salary_stat WHERE occupation_code = '2-02-38-01' AND city = '全部' AND channel = '全部' AND education = '全部' AND quarter NOT LIKE '%-%'`).get() as { sample_size: number; p50_month: number | null };
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
  assert.ok(r.llmTagged >= 1, 'zero-skill postings incl. earlier ones go to the LLM');
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

test('title normalization: leading year, trailing location, bracketed codes', () => {
  assert.equal(normalizeTitle('2026C/C++开发工程师'), 'C/C++开发工程师');
  assert.equal(normalizeTitle('2027届 Java开发工程师'), 'Java开发工程师');
  assert.equal(normalizeTitle('C/C++软件工程师 (J10605)'), 'C/C++软件工程师');
  assert.equal(normalizeTitle('C/C++软件工程师（J10605）'), 'C/C++软件工程师');
  assert.equal(normalizeTitle('硬件工程师-深圳'), '硬件工程师');
  assert.equal(normalizeTitle('技术支持管培生-山东'), '技术支持管培生');
  assert.equal(normalizeTitle('算法工程师（深圳）'), '算法工程师');
  assert.equal(normalizeTitle('阿里云管培生（商业技术工程师方向）'), '阿里云管培生（商业技术工程师方向）', 'non-code bracket kept');
});

test('expert classification batch 2 (34 no_match titles, 2026-10-14)', () => {
  const SW = '2-02-10-03', EMB = '2-02-10-06', DA = '2-02-30-09', AI = '2-02-38-01';
  const cls = (t: string) => { const c = classifyPosting(t); return [c.code, c.multiRole]; };
  for (const t of ['C/C++开发工程师', '2026C/C++开发工程师', 'C/C++工程师', 'C/C++开发实习生', 'C/C++软件工程师 (J10605)', 'QT/C++开发工程师', 'Qt/C++开发工程师']) {
    assert.deepEqual(cls(t), [SW, false], t);
    assert.equal(classifyPosting(t).reason, 'cpp', t);
  }
  for (const t of ['STM32/单片机 软硬件开发', '硬件工程师', '硬件工程师-深圳']) assert.deepEqual(cls(t), [EMB, false], t);
  assert.deepEqual(classifyPosting('市场/数据分析师'), { code: DA, confidence: 0.8, multiRole: false, reason: 'first_role' });
  assert.deepEqual(classifyPosting('电气/视觉工程师'), { code: AI, confidence: 0.8, multiRole: false, reason: 'first_role' });
  for (const t of ['实施工程师', '技术支持管培生-山东', '技术支持管培生-陕西', '测评交付经理', '2027届校招-测评交付经理']) assert.deepEqual([classifyPosting(t).code, classifyPosting(t).reason], [null, 'support'], t);
  for (const t of ['数字芯片设计', '集成电路设计-深圳']) assert.deepEqual([classifyPosting(t).code, classifyPosting(t).reason], [null, 'chip'], t);
  for (const t of ['腾讯云智研发2026届暑期实习生', '腾讯云智研发2027届暑期实习生招聘', '阿里云管培生（商业技术工程师方向）', '技术类', '工程技术岗', '实习生', '综合实习生', '新零售校招生'])
    assert.deepEqual([classifyPosting(t).code, classifyPosting(t).reason], [null, 'generic'], t);
  for (const t of ['上海视觉艺术学院招聘启事', '品牌宣传实习生', '新媒体专员', '非技术类']) assert.equal(classifyPosting(t).code, null, t);
  // the C/C++ slash must not make a 3-item multi-role title
  assert.equal(classifyPosting('C/C++、Java开发工程师').multiRole, false);
  assert.equal(classifyPosting('软件测试 | 硬件测试').code, SW);
});

test('embedded evidence terms', () => {
  assert.equal(embeddedEvidence('熟悉单片机开发'), '单片机');
  assert.equal(embeddedEvidence('有 FreeRTOS 经验'), 'RTOS');
  assert.equal(embeddedEvidence('负责Linux驱动开发'), '驱动开发');
  assert.equal(embeddedEvidence('数据驱动业务增长，具备自我驱动力'), null);
  assert.equal(embeddedEvidence('后台服务开发'), null);
});

function postingRow(db: InstanceType<typeof Database>, id: string, title: string, jd: string) {
  const c = classifyPosting(title);
  db.prepare(`INSERT INTO job_posting (id, site, channel, title_raw, jd_text, occupation_code, occupation_confidence, classify_reason, source_url, fetched_at, extraction_method)
    VALUES (?, 'upc', '校招', ?, ?, ?, ?, ?, 'u', '2026-10-14', 'api')`).run(id, title, jd, c.code, c.confidence, c.reason);
}

test('LLM fallback picks up zero-skill postings already marked extracted; no LLM call without a provider; --force re-sends', async () => {
  const db = db0();
  db.exec('DELETE FROM job_posting_skill; DELETE FROM job_posting;');
  postingRow(db, 'z1', '研究员（AI）', '要求有良好的科研能力');
  postingRow(db, 'z2', '算法工程师', '负责模型研究');
  // the server state: term pass ran earlier, skills_extracted_at set, zero skills
  db.prepare(`UPDATE job_posting SET skills_extracted_at = '2026-10-13T00:00:00Z'`).run();
  let calls = 0;
  const stub = new MockProvider(() => { calls++; return '{"skills":[{"id":"ai.ml","quote":"研究"}]}'; });
  const off = await tagPostings(db, { log: () => {} });
  assert.equal(off.scanned, 0);
  assert.equal(off.llmPending, 2, 'pending is reported without --llm');
  assert.equal((db.prepare('SELECT count(llm_attempted_at) n FROM job_posting').get() as { n: number }).n, 0, 'nothing marked without --llm');
  const on = await tagPostings(db, { llm: stub, log: () => {} });
  assert.deepEqual([on.llmSent, on.llmTagged, calls], [2, 2, 2]);
  assert.equal((db.prepare('SELECT count(llm_attempted_at) n FROM job_posting').get() as { n: number }).n, 2);
  // a second --llm run does not re-send
  assert.equal((await tagPostings(db, { llm: stub, log: () => {} })).llmSent, 0);
  // an attempted posting whose LLM answer was empty is not re-sent either, unless forced
  const empty = new MockProvider(() => { calls++; return '{"skills":[]}'; });
  db.exec(`DELETE FROM job_posting_skill`);
  assert.equal((await tagPostings(db, { llm: empty, log: () => {} })).llmSent, 0);
  const forced = await tagPostings(db, { all: true, llm: stub, log: () => {} });
  assert.equal(forced.scanned, 2, '--force re-runs the term pass on all');
  assert.equal(forced.llmSent, 2, '--force re-sends every posting without a term hit');
  db.close();
});

test('C/C++ postings move to 嵌入式 when the JD/skills are embedded (after tagging), and back if not', async () => {
  const db = db0();
  db.exec('DELETE FROM job_posting_skill; DELETE FROM job_posting;');
  postingRow(db, 'c1', 'C/C++开发工程师', '熟悉STM32单片机，有RTOS经验');
  postingRow(db, 'c2', 'C/C++软件工程师 (J10605)', '负责后台服务开发，熟悉Linux网络编程');
  postingRow(db, 'c3', 'QT/C++开发工程师', '负责上位机界面开发');
  await tagPostings(db, { log: () => {} });
  const r = applyEmbeddedRule(db);
  assert.deepEqual([r.cpp, r.embedded], [3, 1]);
  const get = (id: string) => db.prepare('SELECT occupation_code, classify_reason FROM job_posting WHERE id = ?').get(id);
  assert.deepEqual(get('c1'), { occupation_code: '2-02-10-06', classify_reason: 'cpp_embedded' });
  assert.deepEqual(get('c2'), { occupation_code: '2-02-10-03', classify_reason: 'cpp' });
  // reclassify keeps the embedded move (no churn), the rule re-checks it
  const rc = reclassifyAll(db);
  assert.equal(rc.changed, 0);
  assert.deepEqual(get('c1'), { occupation_code: '2-02-10-06', classify_reason: 'cpp_embedded' });
  db.prepare(`UPDATE job_posting SET jd_text = '负责后台开发' WHERE id = 'c1'`).run();
  await tagPostings(db, { all: true, log: () => {} });
  applyEmbeddedRule(db);
  assert.deepEqual(get('c1'), { occupation_code: '2-02-10-03', classify_reason: 'cpp' });
  db.close();
});

test('salary labels: no 全国, source label, low-sample flag, 校招 row identical to 全部 not stored', async () => {
  assert.equal(sourceLabel(['upc'], ['校招'], '2024Q4-2026Q4', 97), '来源：中国石油大学（华东）就业网校招岗位，2024Q4–2026Q4，样本 97 条');
  const db = db0();
  db.exec('DELETE FROM job_posting_skill; DELETE FROM job_posting; DELETE FROM salary_stat;');
  const base = { ...cleaned[0]!, published_at: '2026-09-01', channel: '校招' as const, education: '本科' as const, city: '青岛', site: 'upc' };
  const ps = Array.from({ length: 40 }, (_, i) => ({ ...base, id: `upc:s${i}`, dedupe_key: `s${i}`, title_raw: 'Java开发工程师', salary_raw: '8000-10000', salary_min_month: 8000 + i * 50, salary_max_month: 10000, salary_note: '元' }));
  upsertPostings(db, ps);
  const s = computeSalaryStats(db, { now: new Date('2026-10-14T08:00:00Z'), log: () => {} });
  assert.ok(s.dupChannel > 0);
  assert.equal(db.prepare(`SELECT 1 FROM salary_stat WHERE city = '全国'`).get(), undefined, 'never 全国');
  assert.equal(db.prepare(`SELECT 1 FROM salary_stat WHERE channel = '校招'`).get(), undefined, '校招 rows identical to 全部 are dropped');
  const ov = db.prepare(`SELECT sample_size, source_label, sample_note, low_sample FROM salary_overview WHERE occupation_code = '2-02-10-03' AND education = '全部'`).get();
  assert.deepEqual(ov, { sample_size: 40, source_label: '来源：中国石油大学（华东）就业网校招岗位，2024Q4–2026Q4，样本 40 条', sample_note: '样本较少，仅供参考', low_sample: 1 });
  computeSalaryStats(db, { now: new Date('2026-10-14T08:00:00Z'), lowSample: 30, log: () => {} });
  assert.equal((db.prepare(`SELECT low_sample FROM salary_overview WHERE occupation_code = '2-02-10-03' AND education = '全部'`).get() as { low_sample: number }).low_sample, 0, 'threshold configurable');
  const views = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'salary_overview'`).get() as { sql: string }).sql;
  assert.ok(!views.includes('全国'));
  db.close();
});

test('product roles excluded (expert 2026-10-14, batch 3)', () => {
  for (const t of ['软件产品经理', '产品经理', 'AI产品经理-北京', '产品助理', '产品运营实习生']) {
    const c = classifyPosting(t);
    assert.equal(c.code, null, t);
    assert.equal(c.reason, 'product', t);
  }
  assert.equal(classifyPosting('Java开发工程师').reason, 'rule', 'unchanged');
});

test('jd_too_short flag (migration 024): set on reclassify, out of skill demand + comparison, still in salary_stat', async () => {
  const { jdCleanLength, updateShortJdFlags, skillComparison, formatComparison } = await import('../compare.js');
  assert.equal(jdCleanLength(' a b\n c　'), 3);
  assert.equal(jdCleanLength(null), 0);
  const db = db0();
  db.exec('DELETE FROM job_posting_skill; DELETE FROM job_posting; DELETE FROM occupation_skill; DELETE FROM salary_stat;');
  db.prepare(`INSERT OR IGNORE INTO occupation (code, level, level_name, name, edition, source_batch, source_url, updated_at) VALUES ('2-02-10-03', 4, '细类', '软件工程技术人员', '2022', 'test', 'u', '2026-10-14')`).run();
  const long = '负责后台服务开发，熟悉Java和MySQL数据库，了解Linux常用命令，具备良好的沟通能力和团队协作精神，能吃苦耐劳。';
  assert.ok(jdCleanLength(long) >= 50);
  postingRow(db, 'l1', 'Java开发工程师', long);
  postingRow(db, 'l2', 'Java开发工程师', long.replace('Java', 'Python'));
  postingRow(db, 's1', 'Java开发工程师', '熟悉Java，计算机相关专业');
  postingRow(db, 'pm', '软件产品经理', long);
  db.exec(`UPDATE job_posting SET salary_min_month = 10000, salary_max_month = 12000, dedupe_key = id, published_at = '2026-10-01'`);
  const rc = reclassifyAll(db);
  assert.equal(rc.short.flagged, 1);
  const flag = (id: string) => (db.prepare('SELECT jd_too_short f, occupation_code o FROM job_posting WHERE id = ?').get(id) as { f: number; o: string | null });
  assert.equal(flag('s1').f, 1);
  assert.equal(flag('l1').f, 0);
  assert.equal(flag('pm').o, null, '软件产品经理 not 软件工程');
  process.env.JOBS_MIN_JD_CHARS = '5';
  assert.equal(updateShortJdFlags(db).flagged, 0, 'threshold configurable');
  delete process.env.JOBS_MIN_JD_CHARS;
  updateShortJdFlags(db);
  await tagPostings(db, { log: () => {} });
  const demand = db.prepare(`SELECT postings, occupation_postings FROM job_skill_demand WHERE occupation_code = '2-02-10-03' AND skill_id = 'software.java'`).get() as { postings: number; occupation_postings: number };
  assert.deepEqual([demand.postings, demand.occupation_postings], [2, 2], 'short JD not in job_skill_demand');
  const s = computeSalaryStats(db, { minSample: 1, log: () => {} });
  const sal = db.prepare(`SELECT sample_size FROM salary_stat WHERE occupation_code = '2-02-10-03' AND city = '全部' AND channel = '全部' AND education = '全部' AND quarter LIKE '%-%'`).get() as { sample_size: number };
  assert.ok(s.written > 0);
  assert.equal(sal.sample_size, 3, 'short JD still counts for salary');

  // comparison: listed skills even at 0, flags, same skill ids on both sides
  const ins = db.prepare(`INSERT INTO occupation_skill (occupation_code, skill_id, importance, extraction_method) VALUES ('2-02-10-03', ?, ?, 'expert')`);
  ins.run('software.java', 'core');
  ins.run('software.testing', 'core');
  ins.run('software.linux', 'core');
  ins.run('software.python', 'general');
  const [o] = skillComparison(db, { occupation: '2-02-10-03' });
  assert.ok(o);
  assert.equal(o.eligible, 2);
  assert.equal(o.too_short, 1);
  assert.equal(o.sample_from, '2026-10-01');
  const r = (id: string) => o.rows.find((x) => x.skill_id === id)!;
  assert.deepEqual([r('software.java').postings, r('software.java').freq_pct, r('software.java').status, r('software.java').flag], [2, 100, 'core', '']);
  assert.equal(r('software.testing').postings, 0, 'listed core skill with 0 hits is shown');
  assert.equal(r('software.testing').skill_type, '专业知识');
  assert.equal(r('software.testing').flag, '', '专业知识 core skill never flagged 核心低频');
  assert.deepEqual([r('software.linux').skill_type, r('software.linux').postings, r('software.linux').flag], ['工具与技术', 0, '核心低频'], 'tool-type core skill at 0% flagged');
  assert.equal(r('software.python').status, 'general');
  const gap = r('software.db-sql');
  assert.deepEqual([gap.status, gap.freq_pct, gap.flag], ['未列入', 100, '高频未列入']);
  assert.equal(skillComparison(db, { occupation: '2-02-10-03', gapHigh: 101 })[0]!.rows.find((x) => x.skill_id === 'software.db-sql')!.flag, '', 'threshold configurable');
  const txt = formatComparison([o]);
  assert.match(txt, /样本：2 条/);
  assert.match(txt, /核心低频/);
  db.close();
});
