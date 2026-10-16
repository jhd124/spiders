/**
 * Apply expert 投档 → MOE major map (GAOKAO/rules/toudang_major_map.csv).
 * Only is_ordinary=1 rows. Patterns: exact, trailing *, or multiple * wildcards.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { parseCsv } from '../GWY/parse.js';
import { PILOT_CODES } from './sources.js';

export const MAP_CSV = join(dirname(fileURLToPath(import.meta.url)), 'rules', 'toudang_major_map.csv');

export interface MapRule {
  school_code: string | null;
  name_pattern: string;
  major_codes: string[];
  match_type: 'exact' | 'category';
  note: string | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Unify fullwidth / halfwidth parentheses so 能源动力类（电气*） matches 能源动力类(电气…). */
export const normParens = (s: string) => s.replace(/[（）]/g, (c) => (c === '（' || c === '(' ? '(' : ')'));

/** Expert pattern → RegExp: each * → .* ; match full major_name_raw (parens normalized). */
export function patternToRegExp(pattern: string): RegExp {
  const p = normParens(pattern.trim());
  if (!p.includes('*')) return new RegExp(`^${escapeRe(p)}$`);
  return new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`);
}

export function loadMapRules(path = MAP_CSV): MapRule[] {
  const text = readFileSync(path, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  return parseCsv(text).flatMap((r) => {
    const pat = (r.name_pattern ?? '').trim();
    const codes = (r.major_codes ?? '').split('|').map((c) => c.trim()).filter(Boolean);
    const mt = (r.match_type ?? '').trim();
    if (!pat || !codes.length || (mt !== 'exact' && mt !== 'category')) {
      if (pat || r.major_codes) throw new Error(`toudang_major_map.csv bad row: ${JSON.stringify(r)}`);
      return [];
    }
    const sc = (r.school_code ?? '').trim();
    return [{
      school_code: !sc || sc === '*' ? null : sc,
      name_pattern: pat,
      major_codes: codes,
      match_type: mt as 'exact' | 'category',
      note: r.note?.trim() || null,
    }];
  });
}

export function matchRules(schoolCode: string, majorName: string, rules: MapRule[]): MapRule | null {
  const name = normParens(majorName);
  for (const r of rules) {
    if (r.school_code && r.school_code !== schoolCode) continue;
    if (patternToRegExp(r.name_pattern).test(name)) return r;
  }
  return null;
}

export interface ApplyMapResult {
  ordinary: number;
  mapped_rows: number;
  mapped_links: number;
  unmapped_ordinary: number;
}

export function applyToudangMajorMap(db: Database.Database, opts: { rulesPath?: string; schoolCodes?: string[] } = {}): ApplyMapResult {
  const rules = loadMapRules(opts.rulesPath ?? MAP_CSV);
  const codes = opts.schoolCodes ?? [...PILOT_CODES];
  const ph = codes.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, school_code, major_name_raw FROM gaokao_toudang
    WHERE is_ordinary = 1 AND school_code IN (${ph})`).all(...codes) as { id: number; school_code: string; major_name_raw: string }[];

  db.prepare(`DELETE FROM gaokao_toudang_major WHERE toudang_id IN (
    SELECT id FROM gaokao_toudang WHERE school_code IN (${ph}))`).run(...codes);

  const ins = db.prepare(`INSERT INTO gaokao_toudang_major (toudang_id, major_code, match_type, rule_note, via_label)
    VALUES (?, ?, ?, ?, ?)`);
  let mapped_rows = 0, mapped_links = 0, unmapped = 0;
  db.transaction(() => {
    for (const row of rows) {
      const hit = matchRules(row.school_code, row.major_name_raw, rules);
      if (!hit) { unmapped++; continue; }
      mapped_rows++;
      const via = hit.match_type === 'category' ? `按${row.major_name_raw}投档` : null;
      const note = hit.note || hit.name_pattern;
      for (const code of hit.major_codes) {
        ins.run(row.id, code, hit.match_type, note, via);
        mapped_links++;
      }
    }
  })();
  return { ordinary: rows.length, mapped_rows, mapped_links, unmapped_ordinary: unmapped };
}

/** STEM-ish names still unmapped; skip 未来智造 / 先进材料与智能制造 / 理工交叉. */
const STEM_PENDING = /计算机|软件|人工智能|电子|通信|自动化|电气|数据科学|大数据|网络空间|信息安全|机器人/;
const STEM_SKIP = /未来智造|先进材料与智能制造|理工交叉/;

export function unmappedStemNames(db: Database.Database, schoolCodes: string[] = [...PILOT_CODES]): { school_code: string; major_name_raw: string; years: string }[] {
  const ph = schoolCodes.map(() => '?').join(',');
  const rows = db.prepare(`SELECT t.school_code, t.major_name_raw, t.year FROM gaokao_toudang t
    LEFT JOIN gaokao_toudang_major m ON m.toudang_id = t.id
    WHERE t.is_ordinary = 1 AND t.school_code IN (${ph}) AND m.toudang_id IS NULL
    ORDER BY t.school_code, t.major_name_raw, t.year`).all(...schoolCodes) as { school_code: string; major_name_raw: string; year: number }[];
  const map = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!STEM_PENDING.test(r.major_name_raw) || STEM_SKIP.test(r.major_name_raw)) continue;
    const k = `${r.school_code}\t${r.major_name_raw}`;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k)!.add(r.year);
  }
  return [...map.entries()].map(([k, ys]) => {
    const [school_code, major_name_raw] = k.split('\t') as [string, string];
    return { school_code, major_name_raw, years: [...ys].sort((a, b) => a - b).join(',') };
  });
}

export function sampleMappedRows(db: Database.Database, perSchool = 5, schoolCodes: string[] = [...PILOT_CODES]) {
  const out: { school_code: string; school_name: string; year: number; major_name_raw: string; min_rank: number; major_codes: string; via_label: string | null; match_type: string }[] = [];
  for (const sc of schoolCodes) {
    const rows = db.prepare(`SELECT t.school_code, t.school_name, t.year, t.major_name_raw, t.min_rank,
        group_concat(m.major_code, '|') AS major_codes, max(m.via_label) AS via_label, max(m.match_type) AS match_type
      FROM gaokao_toudang t JOIN gaokao_toudang_major m ON m.toudang_id = t.id
      WHERE t.school_code = ? AND t.is_ordinary = 1
      GROUP BY t.id ORDER BY t.min_rank ASC, t.year DESC LIMIT ?`).all(sc, perSchool) as typeof out;
    out.push(...rows);
  }
  return out;
}
