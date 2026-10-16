/**
 * Apply toudang→MOE map and print/export expert QA samples.
 *   npm run gaokao:map
 *   npm run gaokao:map -- --out-dir /tmp/gaokao-qa
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CAREER_DB } from '../CAREER/db.js';
import { migrate } from '../CAREER/migrate.js';
import { DATA_DIR } from '../lib/io.js';
import { isMain } from '../lib/main.js';
import { applyToudangMajorMap, sampleMappedRows, unmappedStemNames } from './map.js';

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function runMapAndQa(opts: { dbPath?: string; outDir?: string } = {}) {
  const dbPath = opts.dbPath ?? CAREER_DB;
  migrate(dbPath, () => {});
  const db = new Database(dbPath);
  try {
    const stats = applyToudangMajorMap(db);
    console.log(`[gaokao:map] ordinary=${stats.ordinary} mapped_rows=${stats.mapped_rows} links=${stats.mapped_links} unmapped_ordinary=${stats.unmapped_ordinary}`);

    const samples = sampleMappedRows(db, 5);
    const pending = unmappedStemNames(db);
    const outDir = opts.outDir ?? join(DATA_DIR, 'gaokao');
    mkdirSync(outDir, { recursive: true });

    const samplePath = join(outDir, 'mapped-samples.csv');
    writeFileSync(samplePath, [
      'school_code,school_name,year,major_name_raw,min_rank,major_codes,match_type,via_label',
      ...samples.map((r) => [r.school_code, r.school_name, r.year, r.major_name_raw, r.min_rank, r.major_codes, r.match_type, r.via_label ?? ''].map(csvCell).join(',')),
    ].join('\n') + '\n');

    const pendingPath = join(outDir, 'unmapped-stem.csv');
    writeFileSync(pendingPath, [
      'school_code,major_name_raw,years',
      ...pending.map((r) => [r.school_code, r.major_name_raw, r.years].map(csvCell).join(',')),
    ].join('\n') + '\n');

    console.log(`[gaokao:map] samples (${samples.length}) → ${samplePath}`);
    for (const r of samples) {
      const via = r.via_label ? ` [${r.via_label}]` : '';
      console.log(`  ${r.school_code} ${r.year} 位次${r.min_rank} ${r.major_name_raw} → ${r.major_codes}${via}`);
    }
    console.log(`[gaokao:map] unmapped STEM-ish (${pending.length}) → ${pendingPath}`);
    for (const r of pending.slice(0, 30)) console.log(`  ? ${r.school_code} ${r.major_name_raw} (${r.years})`);
    if (pending.length > 30) console.log(`  … +${pending.length - 30} more`);
    return { stats, samples, pending, samplePath, pendingPath };
  } finally {
    db.close();
  }
}

if (isMain(import.meta.url)) {
  const i = process.argv.indexOf('--out-dir');
  runMapAndQa({ outDir: i >= 0 ? process.argv[i + 1] : undefined });
}
