/** 能报考的国考岗位 (GWY/public.ts + GET /api/public/gwy/major/:major) */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'gwy-public-'));
process.env.SPIDERS_DATA_DIR = TMP;
process.env.CAREER_DB = join(TMP, 'career.db');
const Database = (await import('better-sqlite3')).default;
const { migrate } = await import('../../CAREER/migrate.js');
const { publicGwyForMajor, isFreshGradOnly, isPartyOnly, GWY_SOURCE_NOTE } = await import('../public.js');
const { publicApi } = await import('../../web/server/public.js');

migrate(process.env.CAREER_DB!, () => {});
const db = new Database(process.env.CAREER_DB!);
db.pragma('foreign_keys = OFF');
db.prepare("INSERT INTO gwy_notice (id, year, exam_type, title, url) VALUES ('gk2027', 2027, '国考', '2027年度国考', 'u')").run();
const pos = (code: string, hires: number, political: string, remarks: string, needsGrad = 0) =>
  db.prepare('INSERT INTO gwy_position (notice_id, dept_code, position_code, sheet, row_no, hires, political, remarks, needs_grad, raw_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('gk2027', 'D', code, 's', Number(code.slice(1)), hires, political, remarks, needsGrad, '{}');
const ug = (code: string, major: string) => db.prepare("INSERT INTO gwy_position_undergrad_major (notice_id, dept_code, position_code, major_code, via_seq) VALUES ('gk2027', 'D', ?, ?, 0)").run(code, major);
const pm = (code: string, catalog: string | null, majorCode: string, segment = 'grad') =>
  db.prepare("INSERT INTO gwy_position_major (notice_id, dept_code, position_code, seq, level, segment, phrase, catalog, major_code, match_type) VALUES ('gk2027', 'D', ?, 0, 'any', ?, 'x', ?, ?, 'category')").run(code, segment, catalog, majorCode);
pos('P1', 2, '中共党员', '限应届高校毕业生报考。'); ug('P1', '080901');
pos('P2', 3, '中共党员或共青团员', '2027届高校毕业生，男性'); ug('P2', '080901');
pos('P3', 1, '不限', '非应届毕业生须有工作经历。'); ug('P3', '080901'); ug('P3', '080601');
pos('G1', 4, '不限', '', 1); pm('G1', null, 'undergrad:0809|grad:0812', 'undergrad');
pos('G2', 5, '不限', '', 1); pm('G2', 'grad', '0809'); // 4-digit grad code, not the 本科 class
pos('G3', 6, '不限', '', 1); pm('G3', 'undergrad', '080901', 'undergrad');

test('flags', () => {
  assert.equal(isPartyOnly('中共党员'), true); assert.equal(isPartyOnly('中共党员或共青团员'), false);
  assert.equal(isFreshGradOnly('限应届高校毕业生报考'), true);
  assert.equal(isFreshGradOnly('2027届高校毕业生，女性'), true);
  assert.equal(isFreshGradOnly('3.限应届高校毕业生报考。'), true);
  assert.equal(isFreshGradOnly('非应届毕业生须有工作经历'), false);
  assert.equal(isFreshGradOnly('非2027届高校毕业生需专业从事相关工作'), false);
});

test('counts for a 本科 major', () => {
  const g = publicGwyForMajor(db, '080901')!;
  assert.deepEqual(g.undergrad, { positions: 3, hires: 6, party: { positions: 1, pct: 33.3 }, fresh_grad: { positions: 2, pct: 66.7 } });
  assert.deepEqual(g.needs_grad, { positions: 2, hires: 10 }, 'G1 via its 本科 class, G3 exact; G2 is a 研究生 code');
  assert.equal(g.note, GWY_SOURCE_NOTE);
  assert.deepEqual(publicGwyForMajor(db, '080601')!.undergrad.positions, 1);
  assert.deepEqual(publicGwyForMajor(db, '999999')!.undergrad, { positions: 0, hires: 0, party: { positions: 0, pct: 0 }, fresh_grad: { positions: 0, pct: 0 } });
  assert.equal(publicGwyForMajor(db, '080901', 'nope'), null);
});

test('API', async () => {
  const r = await publicApi.request('/gwy/major/080901');
  assert.equal(r.status, 200);
  const j = await r.json() as { undergrad: { positions: number }; note: string };
  assert.equal(j.undergrad.positions, 3); assert.equal(j.note, '来源：2027 年度国考职位表；部分岗位的专业要求尚未归类');
  assert.equal((await publicApi.request('/gwy/major/080901', { method: 'POST' })).status, 405);
});

test('grad_pathway.csv loader (stub)', async () => {
  const { loadGradPathway, GRAD_PATHWAY_CSV } = await import('../public.js');
  const { writeFileSync } = await import('node:fs');
  assert.ok(loadGradPathway(GRAD_PATHWAY_CSV) instanceof Map, 'committed template parses');
  const f = join(TMP, 'gp.csv');
  writeFileSync(f, '# c\nug_class,ug_class_name,grad_code,grad_kind,note,reviewer,source,reviewed\n0809,计算机类,0812,academic,,e,专家规则,1\n0809,计算机类,0854,professional,,e,专家规则,0\n');
  assert.deepEqual(loadGradPathway(f).get('0809')!.map((x) => [x.grad_code, x.grad_kind, x.reviewed]), [['0812', 'academic', true], ['0854', 'professional', false]]);
  writeFileSync(f, 'ug_class,ug_class_name,grad_code,grad_kind\n0809,计算机类,812,academic\n');
  assert.throws(() => loadGradPathway(f), /bad row/);
});
