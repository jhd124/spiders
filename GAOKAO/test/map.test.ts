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
const { patternToRegExp, loadMapRules, matchRules, applyToudangMajorMap, unmappedStemNames, sampleMappedRows } = await import('../map.js');
const { ingestSdToudang } = await import('../ingest.js');

migrate(process.env.CAREER_DB!, () => {});

test('pattern wildcards', () => {
  assert.ok(patternToRegExp('计算机科学与技术').test('计算机科学与技术'));
  assert.ok(!patternToRegExp('计算机科学与技术').test('计算机科学与技术（试验班）'));
  assert.ok(patternToRegExp('计算机类*').test('计算机类'));
  assert.ok(patternToRegExp('计算机类*').test('计算机类（智能科技）'));
  assert.ok(patternToRegExp('工科试验班*计算机*').test('工科试验班（计算机）'));
  assert.ok(patternToRegExp('工科试验班*AI*').test('工科试验班（AI加先进技术领军班）'));
  assert.ok(patternToRegExp('电气*实验班*').test('电气与智慧能源新工科实验班'));
  assert.ok(patternToRegExp('能源动力类（电气*）*').test('能源动力类（电气与智慧能源）'));
  assert.ok(!patternToRegExp('工科试验班*计算机*').test('工科试验班（未来智造）'));
});

test('rule match order and school scope', () => {
  const rules = loadMapRules();
  assert.equal(matchRules('A422', '计算机科学与技术', rules)!.major_codes.join('|'), '080901');
  assert.equal(matchRules('A422', '计算机类（智能科技新工科实验班）', rules)!.match_type, 'category');
  assert.deepEqual(matchRules('A422', '计算机类', rules)!.major_codes, ['080901', '080902']);
  assert.equal(matchRules('A422', '工科试验班（计算机）', rules), null, 'HITWH-only patterns');
  assert.ok(matchRules('H213', '工科试验班（未来信息）', rules));
  assert.equal(matchRules('A422', '石油工程', rules), null);
  assert.equal(matchRules('H213', '工科试验班（未来智造拔尖班）', rules), null);
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
    'H213哈尔滨工业大学(威海),10工科试验班（计算机）,60,11000',
    'H213哈尔滨工业大学(威海),11工科试验班（AI加先进技术）,20,10500',
    'H213哈尔滨工业大学(威海),12工科试验班（未来智造拔尖班）,30,12000',
    'H213哈尔滨工业大学(威海),13电子信息工程,15,13000',
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
