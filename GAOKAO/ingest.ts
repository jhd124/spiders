/**
 * Ingest Shandong 投档表 → career.db (migration 035).
 * Reads every .xls/.xlsx/.csv under data/gaokao/sd-toudang/ (override: GAOKAO_SD_TOUDANG_DIR).
 * Server production path: /opt/spiders/data/gaokao/sd-toudang/
 *   npm run gaokao:sd-toudang
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { CAREER_DB } from '../CAREER/db.js';
import { migrate } from '../CAREER/migrate.js';
import { isMain } from '../lib/main.js';
import { parseCsvText, parseWorkbook, type ToudangRow } from './parse.js';
import { PILOT_CODES, SD_TOUDANG_DIR } from './sources.js';

export interface IngestResult {
  dir: string;
  files: number;
  rows: number;
  years: number[];
  pilot_rows: number;
  by_year: Record<string, number>;
}

function listInputFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(xlsx?|csv)$/i.test(f) && !f.startsWith('.') && !f.startsWith('~'))
    .map((f) => join(dir, f))
    .sort();
}

export function loadFile(path: string, year?: number | null): ToudangRow[] {
  const name = basename(path);
  const buf = readFileSync(path);
  if (/\.csv$/i.test(name)) {
    const y = year ?? Number(name.match(/(20\d{2})/)?.[1]);
    if (!y) throw new Error(`${name}: put 20xx in the filename or pass year`);
    return parseCsvText(buf.toString('utf8'), { year: y, source_file: name });
  }
  return parseWorkbook(buf, { year: year ?? null, source_file: name });
}

export function ingestSdToudang(opts: { dbPath?: string; dir?: string; files?: string[] } = {}): IngestResult {
  const dbPath = opts.dbPath ?? CAREER_DB;
  const dir = opts.dir ?? SD_TOUDANG_DIR();
  migrate(dbPath, () => {});
  const paths = opts.files ?? listInputFiles(dir);
  const db = new Database(dbPath);
  const result: IngestResult = { dir, files: 0, rows: 0, years: [], pilot_rows: 0, by_year: {} };
  try {
    db.pragma('foreign_keys = ON');
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO gaokao_toudang
      (province, year, admission_type, is_ordinary, special_type, school_code, school_name, major_code_raw, major_name_raw,
       subject_requirement, plan_count, min_rank, source_file, source_url, imported_at)
      VALUES (@province, @year, @admission_type, @is_ordinary, @special_type, @school_code, @school_name, @major_code_raw, @major_name_raw,
       @subject_requirement, @plan_count, @min_rank, @source_file, @source_url, @imported_at)
      ON CONFLICT(province, year, admission_type, school_code, major_code_raw) DO UPDATE SET
        school_name=excluded.school_name, major_name_raw=excluded.major_name_raw,
        subject_requirement=excluded.subject_requirement, plan_count=excluded.plan_count, min_rank=excluded.min_rank,
        is_ordinary=excluded.is_ordinary, special_type=excluded.special_type,
        source_file=excluded.source_file, source_url=excluded.source_url, imported_at=excluded.imported_at`);

    const yearsTouched = new Set<number>();
    for (const p of paths) {
      const rows = loadFile(p);
      if (!rows.length) { console.warn(`[gaokao] ${basename(p)}: 0 rows`); continue; }
      const y = rows[0]!.year;
      yearsTouched.add(y);
      // replace that year's ordinary 第1次志愿 from this file set: delete year rows that share source_file first, then upsert
      db.prepare('DELETE FROM gaokao_toudang WHERE year = ? AND source_file = ?').run(y, basename(p));
      db.transaction(() => {
        for (const r of rows) ins.run({ ...r, imported_at: now });
      })();
      result.files++;
      result.rows += rows.length;
      result.by_year[String(y)] = (result.by_year[String(y)] ?? 0) + rows.length;
      result.pilot_rows += rows.filter((r) => PILOT_CODES.has(r.school_code)).length;
      console.log(`[gaokao] ${basename(p)}: ${rows.length} rows (year ${y}, pilot ${rows.filter((r) => PILOT_CODES.has(r.school_code)).length})`);
    }
    result.years = [...yearsTouched].sort();
    if (!paths.length) console.warn(`[gaokao] no .xls/.xlsx/.csv in ${dir} — drop provincial 投档表 files there (server: /opt/spiders/data/gaokao/sd-toudang/)`);
    return result;
  } finally {
    db.close();
  }
}

/** Product helper: ordinary rows for a pilot school_code in a year (raw names; no MOE map yet). */
export function pilotOrdinaryRows(db: Database.Database, schoolCode: string, year: number) {
  return db.prepare(`SELECT * FROM gaokao_toudang WHERE school_code = ? AND year = ? AND is_ordinary = 1 ORDER BY major_code_raw`).all(schoolCode, year);
}

if (isMain(import.meta.url)) {
  mkdirSync(SD_TOUDANG_DIR(), { recursive: true });
  const r = ingestSdToudang();
  console.log(`[gaokao] done: ${r.files} files, ${r.rows} rows, years ${r.years.join(',') || '—'}, pilot_rows ${r.pilot_rows}`);
}
