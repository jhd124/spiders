/**
 * Export DISTINCT pilot-school majors for expert MOE mapping.
 * Default: school_codes A422,A425,H213; years 2022–2026 (or whatever is present in that range).
 *   npm run gaokao:export-pilot-majors
 *   npm run gaokao:export-pilot-majors -- --out /tmp/pilot-majors.csv
 *
 * CSV columns (专家): 院校代号, 专业代号, 专业名称原文, 出现年份, 是否已标特殊类型, 特殊类型
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CAREER_DB } from '../CAREER/db.js';
import { DATA_DIR } from '../lib/io.js';
import { isMain } from '../lib/main.js';
import { PILOT_CODES } from './sources.js';

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export interface PilotMajorExportRow {
  school_code: string;
  major_code_raw: string;
  major_name_raw: string;
  years: string;           // comma-separated, sorted
  special_flagged: '是' | '否';
  special_type: string;    // type label or empty
}

/** One row per (school_code, major_code_raw, major_name_raw); years aggregated; special if any year flagged. */
export function exportPilotMajors(
  db: Database.Database,
  opts: { schoolCodes?: string[]; years?: number[] } = {},
): PilotMajorExportRow[] {
  const codes = opts.schoolCodes ?? [...PILOT_CODES];
  const years = opts.years ?? [2022, 2023, 2024, 2025, 2026];
  const ph = codes.map(() => '?').join(',');
  const yh = years.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT school_code, major_code_raw, major_name_raw, year, special_type, is_ordinary
    FROM gaokao_toudang
    WHERE school_code IN (${ph}) AND year IN (${yh})
    ORDER BY school_code, major_code_raw, major_name_raw, year`).all(...codes, ...years) as {
    school_code: string; major_code_raw: string; major_name_raw: string; year: number;
    special_type: string | null; is_ordinary: number;
  }[];

  const map = new Map<string, { years: Set<number>; special: string | null }>();
  for (const r of rows) {
    const k = `${r.school_code}\t${r.major_code_raw}\t${r.major_name_raw}`;
    let e = map.get(k);
    if (!e) { e = { years: new Set(), special: null }; map.set(k, e); }
    e.years.add(r.year);
    if (r.special_type && !e.special) e.special = r.special_type;
    if (!r.is_ordinary && !e.special) e.special = r.special_type ?? '特殊';
  }
  return [...map.entries()].map(([k, e]) => {
    const [school_code, major_code_raw, major_name_raw] = k.split('\t') as [string, string, string];
    return {
      school_code, major_code_raw, major_name_raw,
      years: [...e.years].sort((a, b) => a - b).join(','),
      special_flagged: (e.special ? '是' : '否') as '是' | '否',
      special_type: e.special ?? '',
    };
  }).sort((a, b) => a.school_code.localeCompare(b.school_code) || a.major_code_raw.localeCompare(b.major_code_raw) || a.major_name_raw.localeCompare(b.major_name_raw));
}

export function pilotMajorsCsv(rows: PilotMajorExportRow[]): string {
  const header = ['院校代号', '专业代号', '专业名称原文', '出现年份', '是否已标特殊类型', '特殊类型'];
  return [header.join(','), ...rows.map((r) =>
    [r.school_code, r.major_code_raw, r.major_name_raw, r.years, r.special_flagged, r.special_type].map(csvCell).join(','))].join('\n') + '\n';
}

if (isMain(import.meta.url)) {
  const outArg = process.argv.indexOf('--out');
  const out = outArg >= 0 && process.argv[outArg + 1]
    ? process.argv[outArg + 1]!
    : join(DATA_DIR, 'gaokao', 'pilot-majors-for-mapping.csv');
  const db = new Database(CAREER_DB, { readonly: true, fileMustExist: true });
  try {
    const rows = exportPilotMajors(db);
    writeFileSync(out, pilotMajorsCsv(rows), 'utf8');
    console.log(`[gaokao] wrote ${rows.length} distinct majors → ${out}`);
  } finally {
    db.close();
  }
}
