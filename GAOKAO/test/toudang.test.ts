/** Shandong 投档表 parse + ingest (fixtures for 2025 plan_count shape and 2026 subject shape). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TMP = mkdtempSync(join(tmpdir(), 'gaokao-td-'));
process.env.SPIDERS_DATA_DIR = TMP;
process.env.CAREER_DB = join(TMP, 'career.db');

const Database = (await import('better-sqlite3')).default;
const { migrate } = await import('../../CAREER/migrate.js');
const { splitCodeName, splitMajor, parseCsvText, parseWorkbook, isOrdinaryRow } = await import('../parse.js');
const { ingestSdToudang, pilotOrdinaryRows, loadFile } = await import('../ingest.js');
const { PILOT_CODES } = await import('../sources.js');

migrate(process.env.CAREER_DB!, () => {});

test('split code/name', () => {
  assert.deepEqual(splitCodeName('A422山东大学'), { code: 'A422', name: '山东大学' });
  assert.deepEqual(splitCodeName('H213 哈尔滨工业大学（威海）'), { code: 'H213', name: '哈尔滨工业大学（威海）' });
  assert.deepEqual(splitMajor('01计算机类'), { code: '01', name: '计算机类' });
  assert.equal(isOrdinaryRow('普通类常规批第1次志愿', '计算机类'), true);
  assert.equal(isOrdinaryRow('普通类常规批第1次志愿', '某中外合作办学'), false);
});

test('2025 CSV: plan_count present, subject null', () => {
  const rows = loadFile(join(FIX, 'sd-toudang-2025.csv'));
  assert.equal(rows.length, 6);
  const cs = rows.find((r) => r.school_code === 'A422' && r.major_code_raw === '01')!;
  assert.deepEqual(
    { plan_count: cs.plan_count, subject_requirement: cs.subject_requirement, min_rank: cs.min_rank, school_name: cs.school_name },
    { plan_count: 100, subject_requirement: null, min_rank: 8500, school_name: '山东大学' },
  );
  assert.equal(rows.find((r) => /中外合作/.test(r.major_name_raw))!.is_ordinary, 0);
});

test('2026 CSV: subject present, plan_count null', () => {
  const rows = loadFile(join(FIX, 'sd-toudang-2026.csv'));
  assert.equal(rows.length, 4);
  const cs = rows.find((r) => r.school_code === 'A422' && r.major_code_raw === '01')!;
  assert.equal(cs.plan_count, null);
  assert.equal(cs.subject_requirement, '物理和化学');
  assert.equal(cs.min_rank, 7800);
  assert.ok(rows.every((r) => PILOT_CODES.has(r.school_code)));
});

test('xlsx workbook both header shapes', () => {
  const wb = XLSX.utils.book_new();
  const a = XLSX.utils.aoa_to_sheet([
    ['院校代号及名称', '专业代号及名称', '投档计划数', '最低位次'],
    ['A422山东大学', '01计算机类', 10, 9000],
  ]);
  XLSX.utils.book_append_sheet(wb, a, '2024');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const rows = parseWorkbook(buf, { year: 2024, source_file: 'fixture-2024.xlsx' });
  assert.equal(rows[0]!.plan_count, 10);
  assert.equal(rows[0]!.min_rank, 9000);

  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet([
    ['院校代号及名称', '专业代号及名称', '选考科目要求', '最低位次'],
    ['A425中国石油大学(华东)', '05电气工程及其自动化', '物理和化学', 27000],
  ]), 'Sheet1');
  const rows2 = parseWorkbook(XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' }) as Buffer, { year: 2026, source_file: 'fixture-2026.xlsx' });
  assert.equal(rows2[0]!.plan_count, null);
  assert.equal(rows2[0]!.subject_requirement, '物理和化学');
});

test('ingest into career.db + pilot filter', () => {
  const dir = join(TMP, 'gaokao', 'sd-toudang');
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FIX, 'sd-toudang-2025.csv'), join(dir, 'sd-toudang-2025.csv'));
  copyFileSync(join(FIX, 'sd-toudang-2026.csv'), join(dir, 'sd-toudang-2026.csv'));
  const r = ingestSdToudang({ dir });
  assert.equal(r.files, 2);
  assert.equal(r.rows, 10);
  assert.deepEqual(r.years, [2025, 2026]);
  const db = new Database(process.env.CAREER_DB!);
  const pilots = db.prepare("SELECT school_code, count(*) n FROM gaokao_pilot_school").get() as { n: number };
  assert.equal(pilots.n, 3);
  const a422 = pilotOrdinaryRows(db, 'A422', 2025);
  assert.equal(a422.length, 2, '中外合作 excluded from ordinary');
  assert.equal((a422[0] as { min_rank: number }).min_rank, 8500);
  const n2026 = db.prepare("SELECT count(*) n FROM gaokao_toudang WHERE year=2026 AND subject_requirement IS NOT NULL").get() as { n: number };
  assert.equal(n2026.n, 4);
  db.close();
});
