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
    { name: '操作系统', course_type: '核心', credits: 4, hours: '72', semester: '4', page: 3, snippet: '操作系统 | 4', confidence: 0.9 },
    { name: '体育', course_type: '选修', credits: 1, hours: null, semester: null, page: 1, snippet: '体育', confidence: 0.5 },
    { name: 'x', course_type: '核心', page: 0, snippet: '', confidence: 2 },
  ] });
  assert.equal(r.courses.length, 1);
  assert.equal(r.courses[0]!.hours, 72);
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
    { name: '操作系统', course_type: '主干', credits: null, hours: null, semester: null, page: 2, snippet: '数据结构与算法、操作系统', confidence: 0.7 },
    { name: '操作系统', course_type: '核心', credits: 4, hours: 72, semester: '4', page: 3, snippet: 'sd01 操作系统 4 72', confidence: 0.95 },
    { name: '量子计算', course_type: '核心', credits: 3, hours: null, semester: null, page: 2, snippet: '量子计算导论', confidence: 0.9 },
  ] });
  const cache = new MemoryCache();
  const r1 = await extractCourses(PAGES, ctx, p, cache);
  assert.equal(r1.courses.length, 1);
  assert.equal(r1.courses[0]!.course_type, '核心');
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
  const course = { name: '操作系统', course_type: '核心', credits: 4, hours: 72, semester: '4', page: 3, snippet: '操作系统 | 4', confidence: 0.9 };
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
