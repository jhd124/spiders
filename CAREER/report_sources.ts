/**
 * CAREER/seeds/report_sources.csv -> report_source (schema + link registry only; no extraction yet).
 * Columns: school,report_type,year,url,format,verified_by,notes
 *   report_type: 就业质量报告 | 本科教学质量报告 (yearly mandatory; 本科毕业率/去向落实率/升学率/出国率, sometimes per major)
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { parseCsv } from '../lib/csv.js';

export const REPORT_MANIFEST = process.env.REPORT_MANIFEST ?? join(dirname(fileURLToPath(import.meta.url)), 'seeds', 'report_sources.csv');
export const REPORT_TYPES = ['就业质量报告', '本科教学质量报告'] as const;
const FORMATS = ['pdf', 'html', 'docx', 'doc'];

export function readReportManifest(path = REPORT_MANIFEST) {
  const seen = new Set<string>();
  return parseCsv(readFileSync(path, 'utf8')).map((r, i) => {
    const where = `${path}:${i + 2}`;
    if (!r.school || !r.year || !r.url) throw new Error(`${where}: school, year and url are required`);
    if (!(REPORT_TYPES as readonly string[]).includes(r.report_type ?? '')) throw new Error(`${where}: report_type must be ${REPORT_TYPES.join(' | ')}`);
    const format = (r.format ?? '').toLowerCase();
    if (!FORMATS.includes(format)) throw new Error(`${where}: format must be one of ${FORMATS.join('/')}`);
    if (!/^https?:\/\//.test(r.url)) throw new Error(`${where}: url must be http(s)`);
    if (seen.has(r.url)) throw new Error(`${where}: duplicate url`);
    seen.add(r.url);
    return { id: 'rep-' + createHash('sha256').update(r.url.trim()).digest('hex').slice(0, 16), school: r.school, report_type: r.report_type!, year: r.year, url: r.url, format, verified_by: r.verified_by || null, notes: r.notes || null };
  });
}

export function syncReportSources(db: Database.Database, path = REPORT_MANIFEST): number {
  const rows = readReportManifest(path);
  const now = new Date().toISOString();
  const stmt = db.prepare(`INSERT INTO report_source (id, school_name, school_id, report_type, year, url, format, verified_by, notes, updated_at)
    VALUES (@id, @school, (SELECT id FROM school WHERE name = @school), @report_type, @year, @url, @format, @verified_by, @notes, @now)
    ON CONFLICT (id) DO UPDATE SET school_name=excluded.school_name, school_id=excluded.school_id, report_type=excluded.report_type, year=excluded.year,
      format=excluded.format, verified_by=excluded.verified_by, notes=excluded.notes, updated_at=excluded.updated_at`);
  for (const r of rows) stmt.run({ ...r, now });
  console.log(`[career] report sources: ${rows.length}`);
  return rows.length;
}
