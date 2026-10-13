/** 职业 → 技能 → 专业 matching: deterministic, no LLM. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'career-match-'));
process.env.SPIDERS_DATA_DIR = TMP;
process.env.CAREER_DB = join(TMP, 'career.db');
const Database = (await import('better-sqlite3')).default;
const { migrate } = await import('../../migrate.js');
const { loadOccupationSkills, matchOccupation, listOccupations, OCC_SKILLS_CSV } = await import('../../match.js');

function setup() {
  migrate(process.env.CAREER_DB!, () => {});
  const db = new Database(process.env.CAREER_DB!);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO occupation (code, level, level_name, name, edition, source_batch, source_url, updated_at) VALUES ('2-02-38-01', 4, '细类', '人工智能工程技术人员', '2022', '大典2022', 'u', 'x')`).run();
  db.prepare(`INSERT INTO school (id, name, source) VALUES ('a', '甲大学', 't'), ('b', '乙大学', 't')`).run();
  const course = (school: string, major: string, name: string, core: number, tags: [string, string, number?][]) => {
    const id = `${school}:${major}:${name}`;
    db.prepare("INSERT INTO course (id, school_id, name, source_url, extraction_method) VALUES (?, ?, ?, 'u', 'llm')").run(id, school, name);
    db.prepare("INSERT INTO major_course (school_id, major_code, course_id, source_url, extraction_method, course_type, is_core) VALUES (?, ?, ?, 'u', 'llm', '必修', ?)").run(school, major, id, core);
    for (const [skill, ev, nr] of tags)
      db.prepare(`INSERT INTO course_skill (course_id, skill_id, weight, extraction_method, reviewed, evidence_quote, evidence_type, needs_review) VALUES (?, ?, ?, 'llm', 0, ?, ?, ?)`)
        .run(id, skill, { 原文明确: 1, 核心课名: 0.8, 课名推断: 0.5 }[ev], `q ${name}`, ev, nr ?? 0);
  };
  course('a', '080717T', '机器学习', 1, [['ai.ml', '核心课名']]);
  course('a', '080717T', '深度学习', 1, [['ai.dl', '原文明确']]);
  course('a', '080901', '操作系统', 1, [['software.os', '核心课名']]);
  course('a', '080901', '人工智能导论', 0, [['ai.ml', '课名推断']]);
  course('a', '080901', 'Linux实践', 0, [['software.linux', '原文明确']]);           // general only: must not outrank core
  course('b', '080901', '模式识别', 0, [['ai.ml', '原文明确', 1], ['ai.cv', '原文明确']]); // flagged tag: listed, not scored
  return db;
}

test('occupation skills load by NAME, unmatched names are reported, ranking = core first, general only breaks ties', () => {
  const db = setup();
  const csv = join(TMP, 'occ.csv');
  writeFileSync(csv, 'occupation_code,occupation_name,skill_name,importance,source,verified_by,note\n' +
    '2-02-38-01,人工智能工程技术人员,机器学习,core,expert,专家,\n2-02-38-01,人工智能工程技术人员,深度学习,core,expert,专家,\n' +
    '2-02-38-01,人工智能工程技术人员,Linux使用,general,expert,专家,\n2-02-38-01,人工智能工程技术人员,计算机视觉,general,expert,专家,\n' +
    '2-02-38-01,人工智能工程技术人员,不存在的技能,core,expert,专家,\n9-99,x,机器学习,core,expert,专家,\n');
  const errs: string[] = [];
  const orig = console.error; console.error = (m: string) => errs.push(m);
  const r = loadOccupationSkills(db, csv, () => {});
  console.error = orig;
  assert.equal(r.loaded, 4);
  assert.equal(r.skipped.length, 2);
  assert.match(errs.join(), /不存在的技能: unknown skill name/);
  assert.match(errs.join(), /9-99\/机器学习: unknown occupation/);

  const m = matchOccupation(db, '2-02-38-01')!;
  assert.equal(m.example_data, false);
  assert.deepEqual(m.majors.map((x) => `${x.school_id}/${x.major_code}`), ['a/080717T', 'a/080901', 'b/080901']);
  const [ai, cs, b] = m.majors;
  assert.deepEqual([ai!.core_score, ai!.general_score, ai!.coverage_pct], [1.8, 0, 0.5]);
  assert.deepEqual([cs!.core_score, cs!.general_score], [0.5, 0.5]);
  assert.deepEqual([b!.core_score, b!.general_score, b!.flagged], [0, 0.5, 1], 'needs_review tag not scored');
  const ml = b!.skills.find((s) => s.skill_id === 'ai.ml')!;
  assert.equal(ml.covered, false); assert.equal(ml.courses[0]!.needs_review, true);
  assert.equal(listOccupations(db)[0]!.verified, 4);

  // the CSV is the source of truth: a removed row disappears on reload
  writeFileSync(csv, 'occupation_code,skill_name,importance,source,verified_by\n2-02-38-01,机器学习,core,example,\n');
  loadOccupationSkills(db, csv, () => {});
  const m2 = matchOccupation(db, '2-02-38-01')!;
  assert.equal(m2.skills.length, 1); assert.equal(m2.example_data, true); assert.equal(m2.unverified, 1);
  db.close();
});

test('the shipped expert seed: every skill name and occupation resolves', () => {
  const db = new Database(process.env.CAREER_DB!);
  for (const c of ['2-02-10-03', '2-02-38-03', '2-02-30-09', '2-02-10-06', '2-02-10-07', '2-02-10-04', '2-02-38-04'])
    db.prepare(`INSERT OR IGNORE INTO occupation (code, level, level_name, name, edition, source_batch, source_url, updated_at) VALUES (?, 4, '细类', ?, '2022', '大典2022', 'u', 'x')`).run(c, c);
  const r = loadOccupationSkills(db, OCC_SKILLS_CSV, () => {});
  assert.deepEqual(r.skipped, []);
  assert.equal(r.loaded, 81);
  assert.equal((db.prepare(`SELECT count(*) n FROM occupation_skill WHERE extraction_method = 'expert' AND verified_by = '国内教育行业专家' AND reviewed = 1`).get() as { n: number }).n, 81);
  db.close();
});
