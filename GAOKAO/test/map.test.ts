/** 投档 → MOE major map (first expert batch). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TMP = mkdtempSync(join(tmpdir(), 'gaokao-map-'));
process.env.SPIDERS_DATA_DIR = TMP;
process.env.CAREER_DB = join(TMP, 'career.db');

const Database = (await import('better-sqlite3')).default;
const { migrate } = await import('../../CAREER/migrate.js');
const { patternToRegExp, normParens, loadMapRules, matchRules, applyToudangMajorMap, unmappedStemNames, sampleMappedRows } = await import('../map.js');
const { ingestSdToudang } = await import('../ingest.js');

migrate(process.env.CAREER_DB!, () => {});

test('pattern wildcards + paren normalize', () => {
  assert.equal(normParens('能源动力类（电气）'), '能源动力类(电气)');
  assert.ok(patternToRegExp('计算机科学与技术').test(normParens('计算机科学与技术')));
  assert.ok(!patternToRegExp('计算机科学与技术').test(normParens('计算机科学与技术（试验班）')));
  assert.ok(patternToRegExp('计算机类*').test(normParens('计算机类（智能科技）')));
  assert.ok(patternToRegExp('工科试验班*计算机*').test(normParens('工科试验班（计算机）')));
  assert.ok(patternToRegExp('工科试验班*AI*').test(normParens('工科试验班（AI加先进技术领军班）')));
  assert.ok(patternToRegExp('电气*实验班*').test(normParens('电气与智慧能源新工科实验班')));
  assert.ok(patternToRegExp('能源动力类（电气*）*').test(normParens('能源动力类（电气与智慧能源）')));
  assert.ok(patternToRegExp('能源动力类（电气*）*').test(normParens('能源动力类(电气与智慧能源新工科实验班)')));
  assert.ok(!patternToRegExp('工科试验班*计算机*').test(normParens('工科试验班（未来智造）')));
});

test('rule match order and school scope', () => {
  const rules = loadMapRules();
  assert.equal(matchRules('A422', '计算机科学与技术', rules)!.major_codes.join('|'), '080901');
  assert.equal(matchRules('A422', '工程软件', rules)!.major_codes.join('|'), '080902');
  assert.equal(matchRules('A422', '计算机类（智能科技新工科实验班）', rules)!.match_type, 'category');
  assert.deepEqual(matchRules('A422', '计算机类', rules)!.major_codes, ['080901', '080902']);
  const sduPower = matchRules('A422', '能源动力类(电气与智慧能源新工科实验班)', rules)!;
  assert.deepEqual(sduPower.major_codes, ['080601']);
  assert.equal(sduPower.match_type, 'category');
  assert.equal(matchRules('A422', '工科试验班（计算机）', rules), null, 'HITWH-only patterns');
  const fut = matchRules('H213', '工科试验班（未来信息）', rules)!;
  assert.deepEqual(fut.major_codes, ['080901', '080902', '080701'], 'no AI → no 080717T');
  const ai = matchRules('H213', '工科试验班（AI加先进技术领军班）', rules)!;
  assert.ok(ai.major_codes.includes('080717T'));
  const ai2 = matchRules('H213', '工科试验班（人工智能）', rules)!;
  assert.ok(ai2.major_codes.includes('080717T'));
  assert.equal(matchRules('A422', '石油工程', rules), null);
  assert.equal(matchRules('H213', '工科试验班（未来智造拔尖班）', rules), null);
  assert.equal(matchRules('A422', '智能建造与智慧交通(工程机器人新工科实验班)', rules), null);
  assert.equal(matchRules('A422', '生物医药数据科学', rules), null);
  assert.equal(matchRules('A422', '大数据管理与应用', rules), null);
});

test('apply map on fixtures + samples + stem pending', () => {
  const dir = join(TMP, 'in');
  mkdirSync(dir, { recursive: true });
  // richer 2025 fixture for mapping
  writeFileSync(join(dir, 'map-2025.csv'), [
    '院校代号及名称,专业代号及名称,投档计划数,最低位次',
    'A422山东大学,01计算机科学与技术,50,7000',
    'A422山东大学,02计算机类,100,8500',
    'A422山东大学,03电气工程及其自动化,40,9000',
    'A422山东大学,04法学类,30,10000',
    'A425中国石油大学(华东),05电气工程及其自动化,40,28000',
    'A425中国石油大学(华东),06石油工程,80,20000',
    'A422山东大学,05能源动力类(电气与智慧能源新工科实验班),70,8800',
    'A422山东大学,06工程软件,20,9500',
    'H213哈尔滨工业大学(威海),10工科试验班（计算机）,60,11000',
    'H213哈尔滨工业大学(威海),11工科试验班（AI加先进技术）,20,10500',
    'H213哈尔滨工业大学(威海),12工科试验班（未来智造拔尖班）,30,12000',
    'H213哈尔滨工业大学(威海),13电子信息工程,15,13000',
    'A422山东大学,98智能建造与智慧交通(工程机器人新工科实验班),10,15000',
    'A422山东大学,99某中外合作办学计算机,5,40000',
  ].join('\n'));
  ingestSdToudang({ dir });
  const db = new Database(process.env.CAREER_DB!);
  const stats = applyToudangMajorMap(db);
  assert.ok(stats.mapped_rows >= 7);
  const links = db.prepare('SELECT count(*) n FROM gaokao_toudang_major').get() as { n: number };
  assert.ok(links.n >= 10, 'category rows expand to multiple codes');
  const via = db.prepare(`SELECT via_label FROM gaokao_toudang_major m JOIN gaokao_toudang t ON t.id=m.toudang_id
    WHERE t.major_name_raw LIKE '计算机类%' LIMIT 1`).get() as { via_label: string };
  assert.equal(via.via_label, '按计算机类投档');
  const power = db.prepare(`SELECT via_label, group_concat(m.major_code,'|') codes FROM gaokao_toudang_major m JOIN gaokao_toudang t ON t.id=m.toudang_id
    WHERE t.major_name_raw LIKE '能源动力类%' GROUP BY t.id`).get() as { via_label: string; codes: string };
  assert.equal(power.via_label, '按能源动力类(电气与智慧能源新工科实验班)投档');
  assert.equal(power.codes, '080601');
  const hitCs = db.prepare(`SELECT group_concat(m.major_code,'|') codes FROM gaokao_toudang_major m JOIN gaokao_toudang t ON t.id=m.toudang_id
    WHERE t.school_code='H213' AND t.major_name_raw LIKE '%计算机%' AND t.major_name_raw NOT LIKE '%AI%' GROUP BY t.id`).get() as { codes: string };
  assert.deepEqual(hitCs.codes.split('|').sort(), ['080701', '080901', '080902']);
  const hitAi = db.prepare(`SELECT group_concat(m.major_code,'|') codes FROM gaokao_toudang_major m JOIN gaokao_toudang t ON t.id=m.toudang_id
    WHERE t.school_code='H213' AND t.major_name_raw LIKE '%AI%' GROUP BY t.id`).get() as { codes: string };
  assert.match(hitAi.codes, /080717T/);
  assert.equal((db.prepare(`SELECT count(*) n FROM gaokao_toudang_major m JOIN gaokao_toudang t ON t.id=m.toudang_id WHERE t.major_name_raw LIKE '智能建造%'`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT count(*) n FROM gaokao_toudang_major m JOIN gaokao_toudang t ON t.id=m.toudang_id WHERE t.major_name_raw='工程软件'`).get() as { n: number }).n, 1);
  const special = db.prepare(`SELECT count(*) n FROM gaokao_toudang_major m JOIN gaokao_toudang t ON t.id=m.toudang_id WHERE t.is_ordinary=0`).get() as { n: number };
  assert.equal(special.n, 0, 'special rows never mapped');
  const samples = sampleMappedRows(db, 3);
  assert.ok(samples.some((s) => s.school_code === 'A422'));
  assert.ok(samples.some((s) => s.school_code === 'H213'));
  const pending = unmappedStemNames(db);
  assert.ok(!pending.some((p) => p.major_name_raw.includes('未来智造')), '未来智造 left out of stem pending list');
  // 法学类 unmapped but not STEM-ish → not in pending
  assert.ok(!pending.some((p) => /法学/.test(p.major_name_raw)));
  db.close();
});
