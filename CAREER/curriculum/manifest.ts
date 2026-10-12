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

/**
 * major_code may be one code, a '|'-separated list (080901|080902), or '*' (a multi-major 汇编: every pilot
 * major whose section is found in the document). Multi-major documents are split into major sections first.
 */
export const isMultiMajor = (s: Pick<CurriculumSource, 'major_code'>) => s.major_code === '*' || s.major_code.includes('|');
/** null = all pilot majors ('*') */
export const majorCodes = (s: Pick<CurriculumSource, 'major_code'>): string[] | null =>
  s.major_code === '*' ? null : s.major_code.split('|').map((x) => x.trim()).filter(Boolean);

export function readManifest(path = MANIFEST): CurriculumSource[] {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const seen = new Set<string>();
  return rows.map((r, i) => {
    const line = i + 2;
    const format = (r.format || '').toLowerCase();
    if (!r.school || !r.major_code || !r.url) throw new Error(`${path}:${line}: school, major_code and url are required`);
    if (!/^https?:\/\//.test(r.url)) throw new Error(`${path}:${line}: url must be http(s)`);
    if (!(FORMATS as readonly string[]).includes(format)) throw new Error(`${path}:${line}: format must be one of ${FORMATS.join('/')}`);
    if (r.major_code !== '*' && !r.major_code.split('|').every((c) => /^\d{6}[TK]{0,2}$/.test(c.trim())))
      throw new Error(`${path}:${line}: major_code must be a code like 080901, a list 080901|080902, or *`);
    if (seen.has(r.url)) throw new Error(`${path}:${line}: duplicate url (list several majors in one row: 080901|080902 or *)`);
    seen.add(r.url);
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

/** The 25 pilot majors (CAREER/seeds/pilot_majors.csv). */
export function pilotMajors(): Map<string, string> {
  const rows = parseCsv(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'seeds', 'pilot_majors.csv'), 'utf8'));
  return new Map(rows.map((r) => [r.major_code!, r.expected_name!]));
}
