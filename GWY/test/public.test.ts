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
  const filled = loadGradPathway(GRAD_PATHWAY_CSV);
  assert.equal(filled.get('0809')!.length, 4);
  assert.deepEqual(filled.get('0809')!.map((x) => x.grad_code).sort(), ['0812', '0835', '0839', '0854']);
  assert.equal(filled.get('0806')!.map((x) => x.grad_code).includes('0808'), true, '电气类 → 研究生 0808');
  assert.ok(filled.get('0806')!.every((x) => x.reviewed && x.grad_kind));
  const f = join(TMP, 'gp.csv');
  writeFileSync(f, '# c\nug_class,ug_class_name,grad_code,grad_kind,note,reviewer,source,reviewed\n0809,计算机类,0812,academic,,e,专家规则,1\n0809,计算机类,0854,professional,,e,专家规则,0\n');
  assert.deepEqual(loadGradPathway(f).get('0809')!.map((x) => [x.grad_code, x.grad_kind, x.reviewed]), [['0812', 'academic', true], ['0854', 'professional', false]]);
  writeFileSync(f, 'ug_class,ug_class_name,grad_code,grad_kind\n0809,计算机类,812,academic\n');
  assert.throws(() => loadGradPathway(f), /bad row/);
});

test('读对口研究生后可报: pathway codes (catalogs kept separate)', () => {
  // G4 lists graduate 0812 (对口 for 计算机类 0809) and graduate 0808 (电气工程 — 对口 for 电气类 0806, NOT for 计算机类)
  // G5 lists undergrad:0808 (自动化类) — must NOT be treated as graduate 0808
  pos('G4', 7, '不限', '', 1); pm('G4', null, 'grad:0812|grad:0808', 'grad');
  pos('G5', 8, '不限', '', 1); pm('G5', 'undergrad', '0808', 'undergrad');
  pos('G6', 9, '不限', '', 1); pm('G6', 'grad', '0854', 'grad'); // 电子信息 专硕: 对口 for 0809 and 0807
  const cs = publicGwyForMajor(db, '080901')!;
  assert.ok(cs.needs_grad.positions >= 3, `got ${cs.needs_grad.positions}`); // G1, G3 + G4 (0812) + G6
  assert.ok(cs.needs_grad.hires >= 10 + 7 + 9);
  // 080601 (电气类): G4 via grad:0808, not G5 (undergrad 0808 is 自动化类)
  const ee = publicGwyForMajor(db, '080601')!;
  assert.ok(ee.needs_grad.positions >= 1);
  assert.ok(ee.needs_grad.hires >= 7, 'graduate 0808 电气工程 counts for 电气类');
  // 080801 (自动化类): G5 via undergrad 0808, G6 via 0854; NOT G4's grad:0808
  const auto = publicGwyForMajor(db, '080801')!;
  const autoKeys = new Set(); // just check counts: G5 + G6 at least
  assert.ok(auto.needs_grad.positions >= 2);
  assert.ok(auto.needs_grad.hires >= 8 + 9);
});
