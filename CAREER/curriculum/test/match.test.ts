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

test('core score counts only 必修/限选 courses; a core skill reached only by 任选 (or NULL type) is 可选修获得', () => {
  const db = new Database(process.env.CAREER_DB!);
  db.pragma('foreign_keys = OFF');
  db.prepare(`DELETE FROM occupation_skill`).run();
  db.prepare(`INSERT INTO occupation_skill (occupation_code, skill_id, importance, source, extraction_method, reviewed) VALUES
    ('2-02-38-01', 'ai.ml', 'core', 'expert', 'expert', 1), ('2-02-38-01', 'ai.nlp', 'general', 'expert', 'expert', 1)`).run();
  const add = (id: string, name: string, type: string | null, skill: string) => {
    db.prepare("INSERT INTO course (id, school_id, name, source_url, extraction_method) VALUES (?, 'c', ?, 'u', 'llm')").run(id, name);
    db.prepare("INSERT INTO major_course (school_id, major_code, course_id, source_url, extraction_method, course_type, is_core) VALUES ('c', '080902', ?, 'u', 'llm', ?, 0)").run(id, type);
    db.prepare("INSERT INTO course_skill (course_id, skill_id, weight, extraction_method, reviewed, evidence_type) VALUES (?, ?, 1, 'llm', 0, '原文明确')").run(id, skill);
  };
  db.prepare(`INSERT INTO school (id, name, source) VALUES ('c', '丙大学', 't')`).run();
  add('c:ml', '机器学习（选修）', '任选', 'ai.ml');
  add('c:nlp', '自然语言处理', null, 'ai.nlp');
  const m = matchOccupation(db, '2-02-38-01')!.majors.find((x) => x.school_id === 'c')!;
  assert.equal(m.core_score, 0);
  assert.equal(m.general_score, 0.5, 'general skills still count 任选 / NULL-type courses');
  assert.deepEqual(m.elective_only, ['机器学习']);
  assert.deepEqual(m.missing, []);
  assert.equal(m.coverage_pct, 0.5);
  db.close();
});

test('expert aliases tag courses deterministically; admin delete is tombstoned; implied course_type backfill', async () => {
  const { loadSkillAliases, addAlias, deleteAlias, exportAliasesCsv, ALIAS_CSV } = await import('../../aliases.js');
  const { backfillImpliedTypes } = await import('../load.js');
  const db = new Database(process.env.CAREER_DB!);
  db.pragma('foreign_keys = OFF');
  const course = (id: string, name: string, core: number, block: string | null = null, type: string | null = '必修') => {
    db.prepare("INSERT INTO course (id, school_id, name, source_url, extraction_method) VALUES (?, 'h', ?, 'u', 'llm')").run(id, name);
    db.prepare("INSERT INTO major_course (school_id, major_code, course_id, source_url, extraction_method, course_type, is_core, table_block) VALUES ('h', '080717T', ?, 'u', 'llm', ?, ?, ?)").run(id, type, core, block);
  };
  course('h:dg', '代数与几何', 1);
  course('h:la', '线性代数与解析几何（Ⅰ）', 0);
  course('h:sg', '集合论与图论', 0);
  course('h:en', '学术英语写作', 0, '大学英语课题组', null);
  db.prepare("INSERT INTO course_skill_rejected (course_id, skill_id, reason, rejected_by, rejected_at) VALUES ('h:sg', 'foundation.discrete-math', 'x', 'e', 'now')").run();
  const r = loadSkillAliases(db, ALIAS_CSV, () => {});
  assert.deepEqual(r.bad, []);
  const { applyAliasRules } = await import('../../aliases.js');
  const a = applyAliasRules(db);
  assert.equal(a.types, 1);
  assert.equal(backfillImpliedTypes(db), 0, 'idempotent');
  assert.equal((db.prepare("SELECT course_type FROM major_course WHERE course_id = 'h:en'").get() as { course_type: string }).course_type, '限选');
  const tag = (c: string) => db.prepare("SELECT skill_id, evidence_type, weight, source FROM course_skill WHERE course_id = ? ORDER BY skill_id").all(c);
  assert.deepEqual(tag('h:dg'), [{ skill_id: 'foundation.linear-algebra', evidence_type: '核心课名', weight: 0.8, source: 'rule:alias' }]);
  assert.deepEqual(tag('h:la'), [{ skill_id: 'foundation.linear-algebra', evidence_type: '课名推断', weight: 0.5, source: 'rule:alias' }]);
  assert.deepEqual(tag('h:sg'), [], 'expert-rejected pair never added');
  assert.equal(applyAliasRules(db).tags.inserted, 0, 'idempotent');

  deleteAlias(db, '代数与几何', 'expert');
  assert.deepEqual(tag('h:dg'), []);
  loadSkillAliases(db, ALIAS_CSV, () => {});
  assert.equal(db.prepare("SELECT 1 FROM skill_alias WHERE alias = '代数与几何'").get(), undefined, 'tombstoned: seed does not re-add');
  addAlias(db, '代数与几何', '线性代数', 'expert');
  assert.equal(tag('h:dg').length, 1);
  assert.throws(() => addAlias(db, '线性代数', '离散数学', 'e'), /already a skill name/);
  assert.match(exportAliasesCsv(db), /^alias,skill_name,source,note\n[\s\S]*代数与几何,线性代数,expert,added by expert/);
  db.close();
});
