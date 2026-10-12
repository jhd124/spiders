/** CAREER/seeds/curriculum_sources.csv — the expert pastes verified 培养方案 links here. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../lib/csv.js';

export const MANIFEST = process.env.CURRICULUM_MANIFEST ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'seeds', 'curriculum_sources.csv');
export const FORMATS = ['pdf', 'html', 'docx', 'doc'] as const;
export type DocFormat = (typeof FORMATS)[number];

export interface CurriculumSource {
  id: string;
  school: string;
  major_code: string;
  grade_year: string;
  url: string;
  format: DocFormat;
  verified_by: string;
  notes: string;
}

export const sourceId = (url: string) => 'cur-' + createHash('sha256').update(url.trim()).digest('hex').slice(0, 16);

export function readManifest(path = MANIFEST): CurriculumSource[] {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  return rows.map((r, i) => {
    const line = i + 2;
    const format = (r.format || '').toLowerCase();
    if (!r.school || !r.major_code || !r.url) throw new Error(`${path}:${line}: school, major_code and url are required`);
    if (!/^https?:\/\//.test(r.url)) throw new Error(`${path}:${line}: url must be http(s)`);
    if (!(FORMATS as readonly string[]).includes(format)) throw new Error(`${path}:${line}: format must be one of ${FORMATS.join('/')}`);
    return {
      id: sourceId(r.url),
      school: r.school,
      major_code: r.major_code,
      grade_year: r.grade_year ?? '',
      url: r.url,
      format: format as DocFormat,
      verified_by: r.verified_by ?? '',
      notes: r.notes ?? '',
    };
  });
}
