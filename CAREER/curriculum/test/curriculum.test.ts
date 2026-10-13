/** npm run test:career — runs without any LLM key (mock + a local fake OpenAI-compatible server). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'career-cur-'));
process.env.SPIDERS_DATA_DIR = TMP;
process.env.CAREER_DB = join(TMP, 'career.db');

const { validateExtraction } = await import('../schema.js');
const { chunkPages, extractCourses, mockProvider } = await import('../extract.js');
const { MemoryCache } = await import('../cache.js');
const { OpenAICompatibleProvider, providerFromEnv, MockProvider } = await import('../../../lib/llm.js');
const { parseCsv } = await import('../../../lib/csv.js');

const PAGES = [
  { page: 1, text: '一、培养目标\n本专业培养……' },
  { page: 2, text: '四、核心课程设置\n计算概论、离散数学、数据结构与算法、操作系统。\n五、主要实践性教学环节' },
  { page: 3, text: 'sd01 | 操作系统 | 4 | 72 | 56 | 16 | 考试 | 4' },
];
const ctx = { school: '测试大学', majorCode: '080901', majorName: '计算机科学与技术' };

test('schema: valid items kept, invalid ones reported', () => {
  const r = validateExtraction({ courses: [
    { name: '操作系统', course_type: '必修', block: '专业基础课程', credits: 4, hours: '72', semester: '4', page: 3, snippet: '操作系统 | 4', confidence: 0.9 },
    { name: '体育', course_type: '核心', credits: 1, hours: null, semester: null, page: 1, snippet: '体育', confidence: 0.5 },
    { name: 'x', course_type: '核心', page: 0, snippet: '', confidence: 2 },
  ] });
  assert.equal(r.courses.length, 1);
  assert.equal(r.courses[0]!.hours, 72);
  assert.equal(r.courses[0]!.block, '专业基础课程');
  assert.equal(r.courses[0]!.core_in_section, false);
  assert.equal(r.errors.length, 2);
  assert.deepEqual(validateExtraction([]).courses, []);
});

test('chunking keeps page markers and respects the size cap', () => {
  const big = [{ page: 1, text: Array.from({ length: 400 }, (_, i) => `第${i}行 课程设置`).join('\n') }, ...PAGES];
  const chunks = chunkPages(big, 1000);
  assert.ok(chunks.length > 3);
  for (const c of chunks) {
    assert.ok(c.text.length <= 1000, `chunk ${c.text.length}`);
    assert.match(c.text, /^\[\[第\d+页\]\]/);
  }
  assert.ok(chunks.at(-1)!.pages.includes(3));
});

test('mock pipeline: finds core courses with page + verbatim snippet, flagged mock', async () => {
  const r = await extractCourses(PAGES, ctx, mockProvider(), new MemoryCache());
  assert.equal(r.mock, true);
  assert.deepEqual(r.courses.map((c) => c.name), ['计算概论', '离散数学', '数据结构与算法', '操作系统']);
  assert.ok(r.courses.every((c) => c.page === 2 && c.confidence === 0.3));
});

const fake = (payload: unknown) => {
  let calls = 0;
  const p = new MockProvider(() => { calls++; return JSON.stringify(payload); });
  Object.defineProperty(p, 'isMock', { value: false });
  Object.defineProperty(p, 'model', { value: 'fake-model' });
  return { p, calls: () => calls };
};

test('hallucinated snippets are dropped; duplicates merged; cache avoids a second paid call', async () => {
  const { p, calls } = fake({ courses: [
    { name: '操作系统', course_type: null, credits: null, hours: null, semester: null, page: 2, snippet: '数据结构与算法、操作系统', confidence: 0.7 },
    { name: '操作系统', course_type: '必修', block: '专业基础课程', credits: 4, hours: 72, semester: '4', page: 3, snippet: 'sd01 | 操作系统 | 4 | 72', confidence: 0.95 },
    { name: '量子计算', course_type: '必修', credits: 3, hours: null, semester: null, page: 2, snippet: '量子计算导论', confidence: 0.9 },
  ] });
  const cache = new MemoryCache();
  const r1 = await extractCourses(PAGES, ctx, p, cache);
  assert.equal(r1.courses.length, 1);
  assert.equal(r1.courses[0]!.course_type, '必修');
  assert.equal(r1.courses[0]!.core_in_section, true, 'listed in 四、核心课程设置');
  assert.equal(r1.courses[0]!.credits, 4);
  assert.ok(r1.stats.dropped_unverified >= 1);
  const n = calls();
  const r2 = await extractCourses(PAGES, ctx, p, cache);
  assert.equal(calls(), n, 'second run must be served from cache');
  assert.equal(r2.stats.cached, r2.stats.sent);
});

test('OpenAI-compatible provider: request shape, JSON mode, usage; env selection', async () => {
  let seen: { auth?: string; body?: Record<string, unknown> } = {};
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(b) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'm1', choices: [{ message: { content: '{"courses":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const p = new OpenAICompatibleProvider(`http://127.0.0.1:${port}/v1/`, 'k', 'm1');
    const r = await p.chat([{ role: 'user', content: 'hi' }], { json: true });
    assert.equal(seen.auth, 'Bearer k');
    assert.deepEqual(seen.body?.response_format, { type: 'json_object' });
    assert.equal(seen.body?.temperature, 0);
    assert.equal(r.promptTokens, 10);
  } finally {
    srv.close();
  }
  assert.equal(providerFromEnv(mockProvider(), {}).isMock, true);
  assert.equal(providerFromEnv(mockProvider(), { LLM_API_KEY: 'k', LLM_BASE_URL: 'u', LLM_MODEL: 'm', LLM_MOCK: '1' }).isMock, true);
  assert.equal(providerFromEnv(mockProvider(), { LLM_API_KEY: 'k', LLM_BASE_URL: 'u', LLM_MODEL: 'm' }).isMock, false);
});

test('csv parser handles quotes, commas and newlines', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n'), [{ a: 'x, y', b: 'say "hi"\nthere' }]);
});

test('ingest: mock results are never stored; real results are, and reviews survive re-ingest', async () => {
  const { migrate } = await import('../../migrate.js');
  const { ingestCurriculum } = await import('../load.js');
  const { sourceId } = await import('../manifest.js');
  const Database = (await import('better-sqlite3')).default;
  migrate(process.env.CAREER_DB!, () => {});
  const db = new Database(process.env.CAREER_DB!);
  db.prepare("INSERT INTO major_category (code, name, catalog_edition, source_url) VALUES ('08','工学',2026,'x')").run();
  db.prepare("INSERT INTO major (code, base_code, name, category_code, category_name, is_special, is_controlled, is_engineering, degree_categories, catalog_edition, source_url, updated_at) VALUES ('080901','080901','计算机科学与技术','08','工学',0,0,1,'工学',2026,'x','t')").run();
  const url = 'https://example.edu.cn/plan.pdf';
  const manifest = join(TMP, 'm.csv');
  writeFileSync(manifest, `school,major_code,grade_year,url,format,verified_by,notes\n测试大学,080901,2024,${url},pdf,expert,\n`);
  const id = sourceId(url);
  mkdirSync(join(TMP, 'raw'), { recursive: true });
  mkdirSync(join(TMP, 'clean'), { recursive: true });
  writeFileSync(join(TMP, 'raw', 'career-curriculum.json'), JSON.stringify({ docs: [{ source: { id }, meta: { sha256: 'ab'.repeat(32), bytes: 1, fetched_at: 't', url } }] }));
  const course = { name: '操作系统', course_type: '必修', block: '专业核心课程', module: null, core_in_section: false, credits: 4, hours: 72, semester: '4', page: 3, snippet: '操作系统 | 4', confidence: 0.9 };
  const writeClean = (mock: boolean) => writeFileSync(join(TMP, 'clean', 'career-curriculum.json'), JSON.stringify({ results: [{ source_id: id, school: '测试大学', major_code: '080901', doc_sha256: 'ab'.repeat(32), url, model: mock ? 'mock' : 'fake-model', mock, courses: [course] }] }));
  const count = () => (db.prepare('SELECT COUNT(*) n FROM major_course').get() as { n: number }).n;

  writeClean(true);
  ingestCurriculum(db, { manifest });
  assert.equal(count(), 0, 'mock must not be ingested');
  assert.equal((db.prepare('SELECT status FROM curriculum_source').get() as { status: string }).status, 'fetched');

  writeClean(false);
  ingestCurriculum(db, { manifest });
  const row = db.prepare('SELECT * FROM major_course').get() as Record<string, unknown>;
  assert.equal(row.extraction_method, 'llm');
  assert.equal(row.reviewed, 0);
  assert.equal(row.model, 'fake-model');
  assert.equal(row.source_page, 3);
  assert.equal(row.course_type, '必修');
  assert.equal(row.table_block, '专业核心课程');
  assert.equal(row.core_in_section, 0);
  assert.equal(row.is_core, 0, 'table block alone is 专业必修, not core (expert rule 009)');
  assert.ok(String(row.source_doc_id).startsWith('curriculum:'));

  db.prepare("UPDATE major_course SET review_status='edited', reviewed=1, credits=5, reviewer='专家'").run();
  ingestCurriculum(db, { manifest });
  const after = db.prepare('SELECT credits, review_status FROM major_course').get() as { credits: number; review_status: string };
  assert.deepEqual(after, { credits: 5, review_status: 'edited' });
  db.close();
});

test('multi-major 汇编: sections split by heading; class variants recorded, not extracted; non-pilot skipped', async () => {
  const { planUnits } = await import('../plan.js');
  const pages = [
    { page: 1, text: '计算机科学与技术学院' },
    { page: 2, text: '山东大学本科专业培养方案\n计算机科学与技术专业培养方案（080901）\n四、核心课程：\n离散数学、操作系统\n·129·' },
    { page: 3, text: '学院\n计算机科学与技术专业（菁英班）培养方案（080901）\n四、核心课程：\n高级算法\n·130·' },
    { page: 4, text: '学院\n电子商务专业培养方案（120801）\n四、核心课程：\n电子商务概论' },
  ];
  const p = planUnits({ major_code: '*' }, pages);
  assert.equal(p.sections.length, 3);
  assert.deepEqual(p.units.map((u) => [u.major_code, u.section?.page_start, u.section?.page_end]), [['080901', 2, 2]]);
  assert.equal(p.sections[1]!.variant, '菁英班');
  assert.equal(p.sections[2]!.pilot, false);
  const r = await extractCourses(p.units[0]!.pages, ctx, mockProvider(), new MemoryCache());
  assert.deepEqual(r.courses.map((c) => c.name), ['离散数学', '操作系统']);
  assert.deepEqual(planUnits({ major_code: '080902|080901' }, pages).missing, ['080902']);
});

test('manifests: major_code formats, report_sources validation', async () => {
  const { readManifest } = await import('../manifest.js');
  const { readReportManifest } = await import('../../report_sources.js');
  const f = join(TMP, 'm2.csv');
  writeFileSync(f, 'school,major_code,grade_year,url,format,verified_by,notes\nA,*,2024,https://a/x.pdf,pdf,,\nB,080901|080902,,https://b/x.pdf,pdf,,\n');
  assert.equal(readManifest(f).length, 2);
  writeFileSync(f, 'school,major_code,grade_year,url,format,verified_by,notes\nA,cs,2024,https://a/x.pdf,pdf,,\n');
  assert.throws(() => readManifest(f));
  writeFileSync(f, 'school,report_type,year,url,format,verified_by,notes\n山东大学,本科教学质量报告,2023-2024学年,https://a/r.pdf,pdf,,\n');
  assert.equal(readReportManifest(f)[0]!.report_type, '本科教学质量报告');
  writeFileSync(f, 'school,report_type,year,url,format,verified_by,notes\n山东大学,年报,2024,https://a/r.pdf,pdf,,\n');
  assert.throws(() => readReportManifest(f));
  assert.equal(readReportManifest().length, 0);
});

test('format detection uses magic bytes only (content-type ignored, e.g. application/octet-stream)', async () => {
  const { looksLike, fetchFile } = await import('../fetch.js');
  const pdf = new TextEncoder().encode('%PDF-1.7\n...');
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const html = new TextEncoder().encode('<html>login</html>');
  assert.ok(looksLike('pdf', pdf));
  assert.ok(!looksLike('pdf', html));
  assert.ok(!looksLike('pdf', zip));
  assert.ok(looksLike('docx', zip));
  assert.ok(!looksLike('docx', pdf));
  const f = join(TMP, 'download.jsp'); // no extension, like the SDU download url
  writeFileSync(f, pdf);
  const r = await fetchFile('magic-test', 'https://x/download.jsp?id=1', 'pdf', f);
  assert.equal(r.meta.bytes, pdf.length);
  writeFileSync(f, html);
  await assert.rejects(fetchFile('magic-test', 'https://x/download.jsp?id=1', 'pdf', f));
});

test('ingest: sources removed from the manifest are deleted with their pending rows', async () => {
  const { ingestCurriculum } = await import('../load.js');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(process.env.CAREER_DB!);
  const before = (db.prepare('SELECT COUNT(*) n FROM curriculum_source').get() as { n: number }).n;
  assert.ok(before >= 1);
  const manifest = join(TMP, 'empty.csv');
  writeFileSync(manifest, 'school,major_code,grade_year,url,format,verified_by,notes\n');
  ingestCurriculum(db, { manifest });
  assert.equal((db.prepare('SELECT COUNT(*) n FROM curriculum_source').get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM major_course WHERE review_status='pending' AND curriculum_source_id IS NOT NULL").get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM curriculum_source_major').get() as { n: number }).n, 0);
});

test('skill tagger: only listed ids, max 3, untagged never forced, mock never writes', async () => {
  const { parseTagResponse, LlmSkillTagger, mockTagProvider } = await import('../skills.js');
  const skills = [
    { id: 'software.dsa', name: '数据结构与算法', domain_id: 'software', domain_name: '软件开发' },
    { id: 'software.os', name: '操作系统原理', domain_id: 'software', domain_name: '软件开发' },
    { id: 'ai.ml', name: '机器学习', domain_id: 'ai', domain_name: '人工智能' },
    { id: 'ai.dl', name: '深度学习', domain_id: 'ai', domain_name: '人工智能' },
  ];
  const courses = [
    { course_id: 'a', name: '数据结构与算法', course_type: '必修', credits: 4, snippet: null, is_core: 1 },
    { course_id: 'b', name: '毕业论文（设计）', course_type: '必修', credits: 7, snippet: null, is_core: null, table_block: '专业核心课程' },
    { course_id: 'c', name: '人工智能引论', course_type: '必修', credits: 3, snippet: null, is_core: 0 },
  ];
  const resp = JSON.stringify({ courses: [
    { course: '数据结构与算法', skills: [{ skill_id: 'software.dsa', rationale: 'x' }, { skill_id: 'made.up', rationale: 'y' }] },
    { course: '毕业论文（设计）', skills: [], reason: '综合训练' },
    { course: '人工智能引论', skills: ['ai.ml', 'ai.dl', 'software.dsa', 'software.os'].map((skill_id) => ({ skill_id, rationale: 'r' })) },
  ] });
  const p = parseTagResponse(resp, courses, skills);
  assert.deepEqual(p.tags.filter((t) => t.course_id === 'a').map((t) => t.skill_id), ['software.dsa']);
  assert.equal(p.droppedUnknown, 1);
  // no verified quote -> 课名推断 -> at most 2 (MAX_NAME_INFERRED)
  assert.equal(p.tags.filter((t) => t.course_id === 'c').length, 2);
  assert.equal(p.droppedNameInferred, 2);
  assert.deepEqual(p.untagged, [{ course_id: 'b', is_core: false, reason: '综合训练' }]);
  assert.equal(parseTagResponse('not json', courses, skills).untagged.length, 3);

  const { tagSkills } = await import('../tag.js');
  const Database = (await import('better-sqlite3')).default;
  const { migrate } = await import('../../migrate.js');
  migrate(process.env.CAREER_DB!, () => {});
  const db = new Database(process.env.CAREER_DB!);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT OR IGNORE INTO course (id, school_id, name, source_url, extraction_method) VALUES ('s:数据结构与算法', 's', '数据结构与算法', 'u', 'llm')").run();
  db.prepare("INSERT OR IGNORE INTO major_course (school_id, major_code, course_id, source_url, extraction_method, course_type, is_core) VALUES ('s', '080901', 's:数据结构与算法', 'u', 'llm', '必修', 1)").run();
  db.close();
  const s = await tagSkills(process.env.CAREER_DB!, new LlmSkillTagger(mockTagProvider(skills), new MemoryCache()));
  assert.equal(s.mock, true);
  assert.ok(s.tags >= 1);
  const db2 = new Database(process.env.CAREER_DB!);
  assert.equal((db2.prepare('SELECT count(*) n FROM course_skill').get() as { n: number }).n, 0);
  assert.equal((db2.prepare('SELECT count(*) n FROM skill').get() as { n: number }).n, 38);
  db2.close();
});

test('table chunking: one unit per 课程类别 block, label fragments kept, subtotals close blocks', async () => {
  const { segmentTableBlocks, findCoreSection } = await import('../tables.js');
  const { planChunks, typeFromBlock } = await import('../extract.js');
  const pages = [
    { page: 1, text: '四、核心课程设置\n计算概论、离散数学、计\n算机网络。\n五、主要实践性教学环节\n十、课程设置及学时分配表\n（二）专业培养计划--专业教育课程\n课程类别 | 课程号 | 课程名称 | 分 | 学\n学时 | 学时' },
    { page: 2, text: 'sd1 | 计算概论 | 2 | 32 | 32 | 考试 | 1\n学科 | sd2 | 线性代数 | 3 | 48 | 48 | 考试 | 1\n平台\n基础\n课程\n应修小计 | 5 | 80\nsd3 | 离散数学 | 4 | 64 | 64 | 考试 | 2\n专业 | sd4 | 计算机网络 | 3 | 64 | 32 | 32 | 考试 | 3\n基础\n业 | 应修小计 | 7 | 128\n十一、课程与毕业要求对应关系\nsd9 | 不是课程 | 1 | 1' },
  ];
  assert.match(findCoreSection(pages)!.text, /计\n算机网络/);
  const blocks = segmentTableBlocks(pages);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.rows.length), [2, 2]);
  assert.equal(blocks[0]!.label_hint, '学科平台基础课程');
  assert.match(blocks[1]!.label_hint, /^专业基础/);
  assert.equal(blocks[0]!.table_title, '（二）专业培养计划--专业教育课程');
  const units = planChunks(pages);
  assert.deepEqual(units.map((u) => u.kind), ['core_section', 'table_block', 'table_block']);
  assert.equal(typeFromBlock('专业限选课程', '必修'), '限选');
  assert.equal(typeFromBlock('专业核心课程', null), null);
});

test('evidence-based tagging: verbatim quote checked, hedges flagged, tool skills need the tool named', async () => {
  const { parseTagResponse, TAG_PROMPT_VERSION } = await import('../skills.js');
  const { isCoreValue, coreLabel } = await import('../load.js');
  assert.equal(isCoreValue({ core_in_section: false, block: '专业核心课程' }), 0);
  assert.equal(isCoreValue({ core_in_section: true, block: null }), 1);
  assert.equal(coreLabel({ is_core: 0, table_block: '专业核心课程', course_type: '必修' }), '专业必修');
  assert.match(TAG_PROMPT_VERSION, /v3/);
  const skills = [
    { id: 'software.os', name: '操作系统原理', domain_id: 'software', domain_name: '软件开发', skill_type: '专业知识' },
    { id: 'software.python', name: 'Python', domain_id: 'software', domain_name: '软件开发', skill_type: '工具与技术' },
    { id: 'hardware.fpga', name: 'FPGA', domain_id: 'hardware', domain_name: '电路与硬件', skill_type: '工具与技术' },
    { id: 'hardware.comp-arch', name: '计算机组成与体系结构', domain_id: 'hardware', domain_name: '电路与硬件', skill_type: '专业知识' },
  ];
  const source = 'sd01 | 操作系统 | 4 | 72\n sd02 | 计算概论 | 2 | 48\n sd03 | 计算机组成综合实践 | 2 | 64\n基于 FPGA 完成 CPU 设计';
  const courses = ['操作系统', '计算概论', '计算机组成综合实践'].map((name, i) => ({ course_id: String(i), name, course_type: '必修', credits: 2, snippet: null, is_core: 1 }));
  const resp = JSON.stringify({ courses: [
    { course: '操作系统', skills: [{ skill_id: 'software.os', quote: '操作系统  | 4', rationale: '课程名即操作系统' }] },
    { course: '计算概论', skills: [{ skill_id: 'software.python', quote: '计算概论 | 2', rationale: '入门课常用 Python' }, { skill_id: 'software.os', quote: '计算概论讲操作系统', rationale: '通常涉及' }] },
    { course: '计算机组成综合实践', skills: [{ skill_id: 'hardware.fpga', quote: '基于 FPGA 完成 CPU 设计', rationale: '原文写明 FPGA' }, { skill_id: 'hardware.comp-arch', rationale: '组成' }] },
  ] });
  const p = parseTagResponse(resp, courses, skills, source);
  const get = (c: string, s: string) => p.tags.find((t) => t.course_id === c && t.skill_id === s);
  assert.equal(get('0', 'software.os')?.needs_review, false, 'whitespace/separators normalized');
  assert.equal(get('1', 'software.python'), undefined, 'tool not named in the text is dropped');
  assert.equal(get('1', 'software.os')?.needs_review, true);
  assert.match(get('1', 'software.os')!.review_reason!, /引用不在原文中.*通常/);
  assert.equal(get('2', 'hardware.fpga')?.needs_review, false);
  assert.match(get('2', 'hardware.comp-arch')!.review_reason!, /没有原文引用/);
});

test('evidence_type: name-only quote -> 课名推断 (max 2, knowledge skills only); weights documented', async () => {
  const { parseTagResponse, quoteIsNameOnly, EVIDENCE_WEIGHT, tagWeight } = await import('../skills.js');
  assert.equal(EVIDENCE_WEIGHT['课名推断'], 0.5);
  assert.equal(tagWeight('课名推断'), 0.5);
  assert.equal(quoteIsNameOnly('sd02130 | 信息安全导论 | 3 | 48 | 考试 | 5', '信息安全导论'), true);
  assert.equal(quoteIsNameOnly('信息安全导论：讲授对称密码与公钥密码', '信息安全导论'), false);
  assert.equal(quoteIsNameOnly('操作系统、数据库系统、编译原理、计', '操作系统', ['数据库系统', '编译原理']), true, 'a list of course names is name-only');
  const K = (id: string, name: string) => ({ id, name, domain_id: id.split('.')[0]!, domain_name: 'd', skill_type: '专业知识' });
  const skills = [K('network-sec.infosec-basics', '信息安全基础'), K('network-sec.crypto', '密码学'), K('network-sec.protocols', '计算机网络协议'),
    { ...K('software.linux', 'Linux使用'), skill_type: '工具与技术' }, { ...K('software.db-sql', '数据库与SQL'), skill_type: '工具与技术' }];
  const source = 'sd1 | 信息安全导论 | 3 | 48\nsd2 | 云计算技术 | 2 | 32\nsd3 | 数据库系统 | 4 | 64\nsd4 | 计算机网络 | 4 | 64 课程讲授TCP/IP协议栈';
  const courses = ['信息安全导论', '云计算技术', '数据库系统', '计算机网络'].map((name, i) => ({ course_id: String(i), name, course_type: '必修', credits: 2, snippet: null, is_core: 0 }));
  const resp = JSON.stringify({ courses: [
    { course: '信息安全导论', skills: ['network-sec.infosec-basics', 'network-sec.crypto', 'network-sec.protocols'].map((skill_id) => ({ skill_id, evidence_type: '原文明确', quote: 'sd1 | 信息安全导论 | 3 | 48', rationale: '课名' })) },
    { course: '云计算技术', skills: [{ skill_id: 'software.linux', evidence_type: '课名推断', quote: '云计算技术', rationale: 'x' }] },
    { course: '数据库系统', skills: [{ skill_id: 'software.db-sql', evidence_type: '原文明确', quote: '数据库系统 | 4', rationale: '课名含数据库' }] },
    { course: '计算机网络', skills: [{ skill_id: 'network-sec.protocols', evidence_type: '原文明确', quote: '课程讲授TCP/IP协议栈', rationale: '原文' }] },
  ] });
  const p = parseTagResponse(resp, courses, skills, source);
  const of = (c: string) => p.tags.filter((t) => t.course_id === c);
  assert.deepEqual(of('0').map((t) => [t.skill_id, t.evidence_type]), [['network-sec.infosec-basics', '课名推断'], ['network-sec.crypto', '课名推断']], 'model claim downgraded; max 2');
  assert.equal(p.droppedNameInferred, 1);
  assert.equal(of('1').length, 0, 'tool never inferred');
  assert.equal(of('2')[0]?.evidence_type, '原文明确', 'tool literally in the course name counts as named');
  assert.equal(of('3')[0]?.evidence_type, '原文明确');
});

test('tagging stability: per-course cache, re-run is a no-op, reviewed rows survive a rules-version bump', async () => {
  const { tagSkills } = await import('../tag.js');
  const { LlmSkillTagger } = await import('../skills.js');
  const Database = (await import('better-sqlite3')).default;
  const { migrate } = await import('../../migrate.js');
  const dbPath = join(TMP, 'stability.db');
  migrate(dbPath, () => {});
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  for (const [n, core] of [['操作系统', 1], ['密码学', 0], ['大学英语', 0]] as const) {
    db.prepare("INSERT INTO course (id, school_id, name, source_url, extraction_method) VALUES (?, 's', ?, 'u', 'llm')").run(`s:${n}`, n);
    db.prepare("INSERT INTO major_course (school_id, major_code, course_id, source_url, extraction_method, course_type, is_core, snippet) VALUES ('s', '080901', ?, 'u', 'llm', '必修', ?, ?)").run(`s:${n}`, core, `x | ${n} | 3`);
  }
  db.close();
  let calls = 0, nonce = 0;
  const ids: Record<string, string> = { '操作系统': 'software.os', '密码学': 'network-sec.crypto' };
  // a deliberately non-deterministic fake model: rationale differs on every call
  const provider = { model: 'fake', isMock: false, async chat(m: { content: string }[]) {
    calls++; nonce++;
    const names = m[m.length - 1]!.content.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, '').split('｜')[0]!);
    return { model: 'fake', promptTokens: 10, completionTokens: 5, text: JSON.stringify({ courses: names.map((n) => ({ course: n, reason: ids[n] ? null : '通识课',
      skills: ids[n] ? [{ skill_id: ids[n], evidence_type: '课名推断', quote: `x | ${n} | 3`, rationale: `run ${nonce}` }] : [] })) }) };
  } };
  const dump = () => { const d = new Database(dbPath); const r = d.prepare('SELECT rowid, * FROM course_skill ORDER BY course_id, skill_id').all(); const u = d.prepare('SELECT * FROM course_skill_untagged ORDER BY course_id').all(); d.close(); return JSON.stringify([r, u]); };
  const s1 = await tagSkills(dbPath, new LlmSkillTagger(provider, new MemoryCache()));
  assert.equal(s1.llm_calls, 1); assert.equal(s1.tags, 2); assert.equal(s1.untagged.length, 1);
  const first = dump();
  const s2 = await tagSkills(dbPath, new LlmSkillTagger(provider, new MemoryCache()));
  assert.equal(s2.llm_calls, 0); assert.equal(s2.reused, 3); assert.equal(calls, 1);
  assert.equal(dump(), first, 'second run leaves every row byte-identical');
  assert.match(first, /"evidence_type":"课名推断"/); assert.match(first, /"weight":0.5/);

  const d = new Database(dbPath);
  d.prepare("UPDATE course_skill SET reviewed = 1, rationale = '专家确认' WHERE course_id = 's:操作系统'").run();
  const before = JSON.stringify(d.prepare("SELECT rowid, * FROM course_skill WHERE course_id = 's:操作系统'").get());
  d.close();
  const s3 = await tagSkills(dbPath, new LlmSkillTagger(provider, new MemoryCache()), { rulesVersion: 'bumped' });
  assert.equal(s3.llm_calls, 1); assert.equal(s3.retagged, 3);
  const d2 = new Database(dbPath);
  assert.equal(JSON.stringify(d2.prepare("SELECT rowid, * FROM course_skill WHERE course_id = 's:操作系统'").get()), before, 'reviewed row untouched');
  assert.match((d2.prepare("SELECT rationale FROM course_skill WHERE course_id = 's:密码学'").get() as { rationale: string }).rationale, /run 2/, 'unreviewed row updated in place');
  d2.close();
});

test('核心课名: deterministic, conservative; tools only when literally named (数据库系统 whitelisted)', async () => {
  const { coreNameMatches, storedEvidenceType, parseTagResponse, EVIDENCE_WEIGHT } = await import('../skills.js');
  assert.deepEqual(EVIDENCE_WEIGHT, { '原文明确': 1.0, '核心课名': 0.8, '课名推断': 0.5 });
  for (const [c, s] of [['操作系统', '操作系统原理'], ['编译原理', '编译原理'], ['数据结构与算法', '数据结构与算法'], ['软件工程', '软件工程方法'], ['离散数学', '离散数学'], ['计算机网络', '计算机网络协议'], ['计算机组成与系统结构', '计算机组成与体系结构'], ['机器学习（双语）', '机器学习']])
    assert.equal(coreNameMatches(c!, s!), true, `${c}->${s}`);
  for (const [c, s] of [['算法设计与分析', '数据结构与算法'], ['计算机系统导论', '操作系统原理'], ['人工智能引论', '机器学习'], ['操作系统', '计算机组成与体系结构'], ['高级算法设计与分析', '数据结构与算法']])
    assert.equal(coreNameMatches(c!, s!), false, `${c}->${s}`);
  assert.equal(storedEvidenceType('课名推断', true, '操作系统', '操作系统原理'), '核心课名');
  assert.equal(storedEvidenceType('课名推断', false, '操作系统', '操作系统原理'), '课名推断');
  assert.equal(storedEvidenceType('原文明确', true, '操作系统', '操作系统原理'), '原文明确');
  const T = (id: string, name: string) => ({ id, name, domain_id: 'software', domain_name: 'd', skill_type: '工具与技术' });
  const skills = [T('software.python', 'Python'), T('software.db-sql', '数据库与SQL'), T('software.linux', 'Linux使用')];
  const source = 'a | Python程序设计 | 3\nb | 数据库原理 | 3\nc | 数据库系统 | 4\nd | 操作系统实验 | 2 课程在Linux环境下完成';
  const courses = ['Python程序设计', '数据库原理', '数据库系统', '操作系统实验'].map((name, i) => ({ course_id: String(i), name, course_type: '必修', credits: 2, snippet: null, is_core: 0 }));
  const resp = JSON.stringify({ courses: [
    { course: 'Python程序设计', skills: [{ skill_id: 'software.python', evidence_type: '课名推断', quote: 'a | Python程序设计 | 3', rationale: '课名' }] },
    { course: '数据库原理', skills: [{ skill_id: 'software.db-sql', evidence_type: '原文明确', quote: 'b | 数据库原理 | 3', rationale: '课名' }] },
    { course: '数据库系统', skills: [{ skill_id: 'software.db-sql', evidence_type: '课名推断', quote: 'c | 数据库系统 | 4', rationale: '课名' }] },
    { course: '操作系统实验', skills: [{ skill_id: 'software.linux', evidence_type: '原文明确', quote: '课程在Linux环境下完成', rationale: '原文' }] },
  ] });
  const p = parseTagResponse(resp, courses, skills, source);
  const of = (c: string) => p.tags.find((t) => t.course_id === c)?.evidence_type;
  assert.equal(of('0'), '原文明确');
  assert.equal(of('1'), undefined, '数据库原理: tool not literally named -> dropped');
  assert.equal(of('2'), '原文明确', 'whitelist');
  assert.equal(of('3'), '原文明确');
});

test('核心课名 post-step: no LLM, idempotent, reviewed rows only get type/weight', async () => {
  const { classifyCoreNames } = await import('../tag.js');
  const Database = (await import('better-sqlite3')).default;
  const { migrate } = await import('../../migrate.js');
  const dbPath = join(TMP, 'corename.db');
  migrate(dbPath, () => {});
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO course (id, school_id, name, source_url, extraction_method) VALUES ('s:操作系统', 's', '操作系统', 'u', 'llm'), ('s:计算机系统导论', 's', '计算机系统导论', 'u', 'llm')").run();
  db.prepare("INSERT INTO major_course (school_id, major_code, course_id, source_url, extraction_method, is_core) VALUES ('s', '080901', 's:操作系统', 'u', 'llm', 1), ('s', '080901', 's:计算机系统导论', 'u', 'llm', 1)").run();
  db.prepare(`INSERT INTO course_skill (course_id, skill_id, weight, extraction_method, reviewed, rationale, tagged_at, evidence_quote, evidence_type) VALUES
    ('s:操作系统', 'software.os', 0.5, 'llm', 1, '专家确认', 't0', 'q', '课名推断'),
    ('s:计算机系统导论', 'software.os', 0.375, 'llm', 0, 'r', 't0', 'q', '课名推断')`).run();
  const r1 = classifyCoreNames(db);
  assert.deepEqual(r1, { checked: 2, updated: 2, core_name: 1 });
  assert.equal((db.prepare("SELECT weight FROM course_skill WHERE course_id = 's:计算机系统导论'").get() as { weight: number }).weight, 0.5, '0.375 -> exactly 0.5 (no rank multiplier)');
  const os = db.prepare("SELECT * FROM course_skill WHERE course_id = 's:操作系统'").get() as Record<string, unknown>;
  assert.equal(os.evidence_type, '核心课名'); assert.equal(os.weight, 0.8);
  assert.equal(os.reviewed, 1); assert.equal(os.rationale, '专家确认'); assert.equal(os.tagged_at, 't0');
  const snap = JSON.stringify(db.prepare('SELECT rowid, * FROM course_skill').all());
  assert.equal(classifyCoreNames(db).updated, 0);
  assert.equal(JSON.stringify(db.prepare('SELECT rowid, * FROM course_skill').all()), snap, 'idempotent');
  db.close();
  // the function takes no tagger/provider: it cannot call an LLM
  assert.equal(classifyCoreNames.length, 1);
});

test('ingest refreshes source facts on reviewed rows (server bug: approved before 008 -> is_core lost)', async () => {
  const { ingestCurriculum } = await import('../load.js');
  const { RAW_NAME } = await import('../crawler.js');
  const { rawPath, cleanPath } = await import('../../../lib/io.js');
  const Database = (await import('better-sqlite3')).default;
  const { migrate } = await import('../../migrate.js');
  const dbPath = join(TMP, 'facts.db');
  migrate(dbPath, () => {});
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO major (code, base_code, name, category_code, category_name, is_special, is_controlled, is_engineering, degree_categories, catalog_edition, source_url, updated_at) VALUES ('080901','080901','计算机科学与技术','08','工学',0,0,1,'工学',2026,'x','t')").run();
  const manifest = join(TMP, 'facts.csv');
  writeFileSync(manifest, 'school,major_code,grade_year,url,format,verified_by,notes\n测试大学,080901,2024,https://x/facts.pdf,pdf,e,\n');
  const { readManifest } = await import('../manifest.js');
  const id = readManifest(manifest)[0]!.id;
  mkdirSync(join(TMP, 'raw'), { recursive: true }); mkdirSync(join(TMP, 'clean'), { recursive: true });
  writeFileSync(rawPath(RAW_NAME), JSON.stringify({ docs: [] }));
  const course = { name: '操作系统', course_type: '必修', block: '专业核心课程', module: null, core_in_section: true, credits: 4, hours: null, semester: '4', page: 3, snippet: '操作系统', confidence: 0.9 };
  writeFileSync(cleanPath(RAW_NAME), JSON.stringify({ results: [{ source_id: id, school: '测试大学', major_code: '080901', mock: false, model: 'm', doc_sha256: 'x', url: 'u', courses: [course] }] }));
  ingestCurriculum(db, { manifest });
  assert.equal((db.prepare('SELECT count(*) n FROM major_course').get() as { n: number }).n, 1);
  // simulate the server: approved before 008, so the 008 columns kept their defaults and 009 derived is_core 0
  db.prepare("UPDATE major_course SET review_status = 'approved', reviewed = 1, core_in_section = 0, is_core = 0, course_type = NULL, table_block = NULL, credits = 9").run();
  ingestCurriculum(db, { manifest });
  const r = db.prepare('SELECT * FROM major_course').get() as Record<string, unknown>;
  assert.equal(r.core_in_section, 1); assert.equal(r.is_core, 1); assert.equal(r.course_type, '必修'); assert.equal(r.table_block, '专业核心课程');
  assert.equal(r.review_status, 'approved'); assert.equal(r.credits, 9, 'reviewed values other than source facts untouched');
  db.close();
});

test('course-list quote is never 原文明确 -> 课名推断 + needs_review (expert 2026-10-13)', async () => {
  const { quoteIsCourseList, parseTagResponse, applyCourseListRule } = await import('../skills.js');
  const names = ['程序设计基础', '高级语言程序设计', '数据结构', '操作系统', '计算机网络', '数据库系统', '编译原理'];
  assert.equal(quoteIsCourseList('程序设计基础、数据结构、操作系统、计算机网络等专业课程实验', '程序设计基础', names), true);
  assert.equal(quoteIsCourseList('……高级语言程序设计、数据结构、编译原理等专业课程实验', '高级语言程序设计', names), true);
  assert.equal(quoteIsCourseList('核心课程：操作系统、数据库系统、编译原理。', '操作系统', names), true);
  assert.equal(quoteIsCourseList('程序设计基础：讲授C语言语法、指针与链表、递归和排序算法。', '程序设计基础', names), false);
  assert.equal(quoteIsCourseList('操作系统课程要求学生完成进程调度与内存管理实验', '操作系统', names), false);
  assert.equal(quoteIsCourseList('sd01 | 操作系统 | 4 | 72', '操作系统', names), false);
  const src = '实践环节包括程序设计基础、数据结构、操作系统、计算机网络等专业课程实验。';
  const courses = [{ course_id: 'c1', name: '程序设计基础', course_type: '必修', credits: 4, snippet: null }];
  const skills = [{ id: 'software.dsa', name: '数据结构与算法', domain_id: 'software', domain_name: '软件', skill_type: '专业知识' }];
  const r = parseTagResponse(JSON.stringify({ courses: [{ course: '程序设计基础', skills: [{ skill_id: 'software.dsa', evidence_type: '原文明确', quote: '程序设计基础、数据结构、操作系统、计算机网络等专业课程实验', rationale: '实验' }] }] }), courses, skills, src, names);
  assert.equal(r.tags[0]!.evidence_type, '课名推断');
  assert.equal(r.tags[0]!.needs_review, true);
  assert.match(r.tags[0]!.review_reason!, /罗列课名/);
  // cached (pre-rule) result gets the same treatment
  const cached = { evidence_type: '原文明确', evidence_quote: '程序设计基础、数据结构、操作系统等专业课程实验', needs_review: false, review_reason: null };
  const a = applyCourseListRule(cached, '程序设计基础', names);
  assert.equal(a.evidence_type, '课名推断'); assert.equal(a.needs_review, true);
  assert.deepEqual(applyCourseListRule(a, '程序设计基础', names), a);
});

test('014: expert rejections stick (no LLM, idempotent, cache cannot recreate); 数据挖掘 -> 机器学习', async () => {
  const { tagSkills } = await import('../tag.js');
  const { LlmSkillTagger } = await import('../skills.js');
  const Database = (await import('better-sqlite3')).default;
  const { migrate } = await import('../../migrate.js');
  const dbPath = join(TMP, 'm014.db');
  migrate(dbPath, () => {});
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT OR IGNORE INTO school (id, name, source) VALUES ('name:山东大学', '山东大学', 't')").run();
  const tags: Record<string, [string, string][]> = { '程序设计基础': [['software.dsa', '原文明确']], '高级语言程序设计': [['software.dsa', '原文明确']], '信息检索与数据挖掘': [['data.cleaning', '课名推断']], '操作系统': [['software.os', '课名推断']] };
  for (const n of Object.keys(tags)) {
    const id = `name:山东大学:${n}`;
    db.prepare("INSERT INTO course (id, school_id, name, source_url, extraction_method) VALUES (?, 'name:山东大学', ?, 'u', 'llm')").run(id, n);
    db.prepare("INSERT INTO major_course (school_id, major_code, course_id, plan_year, source_url, extraction_method, course_type, is_core, snippet) VALUES ('name:山东大学', '080901', ?, 2024, 'u', 'llm', '必修', 0, ?)").run(id, `x | ${n} | 3`);
    for (const [sk, et] of tags[n]!) db.prepare("INSERT INTO course_skill (course_id, skill_id, weight, extraction_method, reviewed, evidence_type, evidence_quote) VALUES (?, ?, ?, 'llm', 0, ?, 'q')").run(id, sk, et === '原文明确' ? 1 : 0.5, et);
  }
  db.prepare("DELETE FROM schema_migrations WHERE version = '014'").run();
  db.close();
  migrate(dbPath, () => {}); migrate(dbPath, () => {}); // applied once; second run no-op
  const d = new Database(dbPath);
  const rows = () => d.prepare("SELECT c.name, cs.skill_id, cs.evidence_type, cs.weight, cs.reviewed FROM course_skill cs JOIN course c ON c.id = cs.course_id ORDER BY 1, 2").all();
  assert.deepEqual(rows(), [
    { name: '信息检索与数据挖掘', skill_id: 'ai.ml', evidence_type: '课名推断', weight: 0.5, reviewed: 1 },
    { name: '操作系统', skill_id: 'software.os', evidence_type: '课名推断', weight: 0.5, reviewed: 0 },
  ]);
  assert.equal((d.prepare('SELECT count(*) n FROM course_skill_rejected').get() as { n: number }).n, 3);
  // the (stub) model re-proposes the rejected tags: none is written back
  let calls = 0;
  const provider = { model: 'stub', isMock: false, async chat(m: { content: string }[]) {
    calls++;
    const names = m[m.length - 1]!.content.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, '').split('｜')[0]!);
    return { model: 'stub', promptTokens: 1, completionTokens: 1, text: JSON.stringify({ courses: names.map((n) => ({ course: n, reason: null,
      skills: (tags[n] ?? []).map(([sk]) => ({ skill_id: sk, evidence_type: '课名推断', quote: `x | ${n} | 3`, rationale: 'r' })) })) }) };
  } };
  await tagSkills(dbPath, new LlmSkillTagger(provider, new MemoryCache()));
  assert.ok(calls >= 1);
  assert.deepEqual(rows().map((r: any) => `${r.name}:${r.skill_id}`), ['信息检索与数据挖掘:ai.ml', '操作系统:software.os']);
  d.close();
});

test('HTML: sniffed by bytes, gbk meta honoured, article body only, tables kept as | rows, segmented like PDF', async () => {
  const { sniffFormat, looksLike } = await import('../fetch.js');
  const { extractText } = await import('../text.js');
  const { planChunks } = await import('../extract.js');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><nav>首页 学院简介</nav><form name="f"><div id="vsb_content">
    <p>软件工程专业培养方案（2024版）</p><p>${'本专业培养软件工程人才。'.repeat(20)}</p>
    <p><span>四</span><span>、</span><span>核心课程设置</span></p><p>本专业必修核心课程包括数据结构、操作系统、软件工程等。</p>
    <p>五、主要实践性教学环节</p><p>九、软件工程专业课程设置及学时分配表</p><p>（一）专业培养计划--专业教育课程</p>
    <table><tr><td>课程类别</td><td>课程号</td><td>课 程 名 称</td><td>学分</td></tr>
    <tr><td>专业核心课程</td><td>sd01</td><td>数据结构</td><td>4</td></tr><tr><td>sd02</td><td>操作系统</td><td>4</td></tr><tr><td>应修小计</td><td>8</td></tr></table>
    </div></form><footer>版权所有</footer></body></html>`;
  const b = new TextEncoder().encode(html);
  assert.equal(sniffFormat(b), 'html'); assert.ok(looksLike('html', b));
  assert.equal(sniffFormat(new TextEncoder().encode('%PDF-1.7 ...')), 'pdf'); assert.equal(looksLike('html', new TextEncoder().encode('%PDF-1.7')), false);
  assert.equal(sniffFormat(new Uint8Array([0x50, 0x4b, 3, 4])), 'docx');
  const [p] = await extractText(b, 'html');
  assert.doesNotMatch(p!.text, /首页|版权所有/);
  assert.match(p!.text, /^四、核心课程设置$/m);
  assert.match(p!.text, /^专业核心课程 \| sd01 \| 数据结构 \| 4$/m);
  const units = planChunks([p!]);
  assert.equal(units[0]!.kind, 'core_section');
  assert.ok(units.some((u) => u.kind === 'table_block' && u.text.includes('sd02 | 操作系统 | 4')));
  const gbk = Buffer.concat([Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head><body><p>'), Buffer.from([0xba, 0xcb, 0xd0, 0xc4]), Buffer.from('</p></body></html>')]);
  assert.equal((await extractText(new Uint8Array(gbk), 'html'))[0]!.text, '核心');
});

test('core section: only 核心课程 counts (专业基础课程 / 主干学科 sub-lists are cut; 主干学科 heading is not core)', async () => {
  const { findCoreSection } = await import('../tables.js');
  const hit = [{ page: 2, text: '三、主干学科\n计算机科学与技术\n四、专业基础课程和专业核心课程\n专业基础课程：高级语言程序设计I、数据结构与算法、\n计算机网络、操作系统。\n专业核心课程：计算机体系结构、计算系统设计与实现、处理器设计\n与实践。\n五、修业年限' }];
  const c = findCoreSection(hit)!;
  assert.match(c.text, /计算机体系结构/); assert.match(c.text, /与实践/);
  assert.doesNotMatch(c.text, /数据结构与算法|操作系统|主干学科\n/);
  const upc = [{ page: 1, text: '三、主干学科、专业核心课程\n主干学科：计算机科学与技术\n专业核心课程：计算机网络原理，数据库原理，\n数据结构\n四、特色课程' }];
  const u = findCoreSection(upc)!.text;
  assert.doesNotMatch(u, /主干学科：/); assert.match(u, /数据库原理/); assert.match(u, /数据结构/);
  assert.equal(findCoreSection([{ page: 1, text: '三、主干学科\n计算机科学与技术\n四、毕业要求' }]), null);
  const sdu = [{ page: 1, text: '四、核心课程设置\n本专业必修核心课程包括数据结构、操作系统等。\n五、实践' }];
  assert.equal(findCoreSection(sdu)!.text, '四、核心课程设置\n本专业必修核心课程包括数据结构、操作系统等。');
});
