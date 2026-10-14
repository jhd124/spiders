/** Student API (/api/public): read-only GET, student fields only, scoring from match.ts. No LLM. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'career-public-'));
process.env.SPIDERS_DATA_DIR = TMP;
process.env.CAREER_DB = join(TMP, 'career.db');
const Database = (await import('better-sqlite3')).default;
const { migrate } = await import('../../migrate.js');
const { loadOccupationDisplay, DISPLAY_CSV } = await import('../../display.js');
const { publicApi } = await import('../../../web/server/public.js');

migrate(process.env.CAREER_DB!, () => {});
{
  const db = new Database(process.env.CAREER_DB!);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO occupation (code, level, level_name, name, edition, source_batch, source_url, updated_at) VALUES ('2-02-38-01', 4, '细类', '人工智能工程技术人员', '2022', '大典2022', 'u', 'x'), ('2-02-10-03', 4, '细类', '别的名字', '2022', '大典2022', 'u', 'x')`).run();
  db.prepare(`INSERT INTO school (id, name, source) VALUES ('name:甲大学', '甲大学', 't')`).run();
  const course = (name: string, type: string | null, skill: string, nr = 0) => {
    const id = `a:${name}`;
    db.prepare("INSERT INTO course (id, school_id, name, source_url, extraction_method) VALUES (?, 'name:甲大学', ?, 'u', 'llm')").run(id, name);
    db.prepare("INSERT INTO major_course (school_id, major_code, course_id, source_url, extraction_method, course_type, is_core) VALUES ('name:甲大学', '080717T', ?, 'u', 'llm', ?, 1)").run(id, type);
    db.prepare("INSERT INTO course_skill (course_id, skill_id, weight, extraction_method, reviewed, evidence_quote, evidence_type, needs_review, review_reason) VALUES (?, ?, 0.8, 'llm', 0, 'SECRET QUOTE', '核心课名', ?, 'SECRET REASON')").run(id, skill, nr);
  };
  course('机器学习', '必修', 'ai.ml');
  course('深度学习（选修）', '任选', 'ai.dl');
  course('计算机视觉', '限选', 'ai.cv', 1); // flagged: never shown to students
  db.prepare(`INSERT INTO occupation_skill (occupation_code, skill_id, importance, source, verified_by, note, extraction_method, reviewed) VALUES
    ('2-02-38-01', 'ai.ml', 'core', 'expert', 'SECRET VERIFIER', 'SECRET NOTE', 'expert', 1), ('2-02-38-01', 'ai.dl', 'core', 'expert', 'SECRET VERIFIER', NULL, 'expert', 1),
    ('2-02-38-01', 'ai.cv', 'general', 'expert', 'SECRET VERIFIER', NULL, 'expert', 1)`).run();
  db.prepare(`INSERT INTO salary_stat (occupation_code, city, quarter, channel, education, sample_size, p25_month, p50_month, p75_month, computed_at, source_label, low_sample) VALUES
    ('2-02-38-01', '全部', '2024Q4-2026Q4', '全部', '本科', 45, 8000, 10000, 13000, 'x', '来源：全国某就业网，样本 45 条', 1),
    ('2-02-38-01', '全部', '2024Q4-2026Q4', '全部', '硕士', 12, 9000, 12000, 15000, 'x', '来源：某就业网', 1)`).run();
  const errs: string[] = [];
  const orig = console.error; console.error = (s: string) => errs.push(s);
  const r = loadOccupationDisplay(db, DISPLAY_CSV, () => {});
  console.error = orig;
  assert.equal(r.loaded, 11);
  assert.ok(r.mismatch.some((m) => m.includes('2-02-10-03') && m.includes('别的名字')), 'official name mismatch reported');
  assert.equal(loadOccupationDisplay(db, DISPLAY_CSV, () => {}).loaded, 11, 'idempotent');
  db.close();
}

const get = async (p: string) => { const r = await publicApi.request(p); const body = (await r.json()) as any; return { status: r.status, body, text: JSON.stringify(body) }; };

test('public API is GET-only', async () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await publicApi.request('/occupations', { method: m })).status, 405, m);
  assert.equal((await publicApi.request('/nope')).status, 404);
});

test('occupations list: display name, official name, search aliases', async () => {
  const { body } = await get('/occupations');
  const ai = body.find((o: any) => o.code === '2-02-38-01');
  assert.deepEqual(ai, { code: '2-02-38-01', display_name: 'AI算法工程师', official_name: '人工智能工程技术人员', aliases: ['算法工程师', '机器学习工程师', '大模型工程师'], core_skills: 2, skills: 3 });
});

test('occupation page: skills, salary rules (<30 count only, low-sample note, never 全国), ranked majors labelled 核心能力 n/m, no admin fields', async () => {
  const { body, text } = await get('/occupation/2-02-38-01');
  assert.deepEqual(body.core_skills.sort(), ['机器学习', '深度学习'].sort());
  assert.deepEqual(body.general_skills, ['计算机视觉']);
  const ben = body.salary.find((s: any) => s.education === '本科'), shuo = body.salary.find((s: any) => s.education === '硕士');
  assert.equal(ben.p50, 10000); assert.equal(ben.note, '样本较少，仅供参考');
  assert.equal(shuo.p50, null); assert.equal(shuo.p25, null); assert.equal(shuo.sample_size, 12);
  assert.doesNotMatch(text, /全国/);
  assert.deepEqual(body.majors, [{ school_id: 'name:甲大学', school: '甲大学', major_code: '080717T', major: '080717T', core_covered: 1, core_total: 2, label: '核心能力 1/2' }]);
  assert.doesNotMatch(text, /SECRET|needs_review|quote|verified_by|weight/);
});

test('major-for-occupation detail: sentence, badges, uncovered skills to supplement, flagged tags hidden', async () => {
  const { body, text } = await get(`/occupation/2-02-38-01/major/${encodeURIComponent('name:甲大学')}/080717T`);
  assert.equal(body.sentence, '必修和限选课教到了 2 项核心能力中的 1 项');
  assert.deepEqual(body.covered, [{ skill: '机器学习', courses: [{ course: '机器学习', type: '必修' }] }]);
  assert.deepEqual(body.to_supplement, [{ skill: '深度学习', courses: [{ course: '深度学习（选修）', type: '任选' }] }]);
  assert.deepEqual(body.general, [{ skill: '计算机视觉', covered: false, courses: [] }], 'needs_review course not shown');
  assert.doesNotMatch(text, /SECRET|缺失|needs_review/);
});

test('reverse: major page ranks occupations by core coverage', async () => {
  const { body } = await get('/majors');
  assert.deepEqual(body, [{ school_id: 'name:甲大学', school: '甲大学', major_code: '080717T', major: '080717T' }]);
  const m = (await get(`/major/${encodeURIComponent('name:甲大学')}/080717T`)).body;
  assert.equal(m.occupations[0].code, '2-02-38-01');
  assert.equal(m.occupations[0].label, '核心能力 1/2');
  assert.equal((await publicApi.request('/major/x/y')).status, 404);
});
