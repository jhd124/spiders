/**
 * GWY ingest → data/career.db (migration 030): notice + age rule, 研究生学科目录, expert rules (GWY/rules/major_rules.csv),
 * 职位表 rows, and 专业 → MOE major matches. Writes reports to data/civil-service/:
 *   gk2027_unresolved_majors.csv  phrases left unresolved/related, with position & hire counts (for the expert)
 *   gk2027_match_stats.json       counts by match type
 *   npm run gwy:ingest
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { CAREER_DB } from '../CAREER/db.js';
import { migrate } from '../CAREER/migrate.js';
import { rawPath } from '../lib/io.js';
import { isMain } from '../lib/main.js';
import { GK2027, GRAD_CATALOG, GWY_DIR } from './sources.js';
import { csvCell, matchMajors, needsGrad, parseAge, parseCsv, parseGradCatalog, type Catalogs, type Level, type MatchType, type Rule } from './parse.js';
import { OUT_FILE, type PositionsDump } from './gk2027/crawler.js';

export const RULES_CSV = join(dirname(fileURLToPath(import.meta.url)), 'rules', 'major_rules.csv');
export const LEGACY_CSV = join(dirname(fileURLToPath(import.meta.url)), 'rules', 'grad_legacy_map.csv');
const POS_COLS = ['dept_name', 'bureau', 'org_nature', 'position_name', 'position_attr', 'position_dist', 'position_desc', 'org_level', 'exam_category', 'major_text', 'education', 'degree', 'political', 'grassroots_years', 'grassroots_project', 'skill_test', 'interview_ratio', 'work_place', 'hukou_place', 'remarks', 'website', 'phone1', 'phone2', 'phone3'];

export interface SegmentStats { positions: number; hires: number; positions_with_match: number; hires_with_match: number }
export interface IngestResult { positions: number; hires: number; code_doubtful: number;
  /** 本科 product basis: positions not requiring 硕士+, counted only through 本科-catalog matches */
  undergrad: SegmentStats & { position_majors: number; distinct_majors: number;
    /** positions with a matched major plus some unresolved/related phrase: counted for the matched majors, flagged 部分专业要求未归类 */
    positions_incomplete: number; hires_incomplete: number;
    /** positions with no matched major at all: absent from major page counts */
    positions_no_match: number; hires_no_match: number };
  exclusions_partial: number; exclusions_unmatched: number; exclusions_unmatched_distinct: number; via_legacy: number;
  remarks_override: { applied: number; unparsed: number };
  /** 需读研后报考: positions requiring 硕士及以上 — never mixed into the 本科 counts */
  needs_grad: SegmentStats; phrases: number; by_type: Record<MatchType, number>; positions_all_resolved: number; unresolved: { phrase: string; level: Level; match_type: MatchType; positions: number; hires: number; note?: string }[]; grad: number }

export function ingest(opts: { dbPath?: string; dump?: PositionsDump; rulesCsv?: string; legacyCsv?: string; gradLines?: string[] | null; outDir?: string } = {}): IngestResult {
  const dbPath = opts.dbPath ?? CAREER_DB;
  const outDir = opts.outDir ?? GWY_DIR;
  migrate(dbPath, () => {});
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    const now = new Date().toISOString();
    const dump = opts.dump ?? (existsSync(OUT_FILE()) ? (JSON.parse(readFileSync(OUT_FILE(), 'utf8')) as PositionsDump) : null);

    // notice + age rule
    const age = parseAge(GK2027.age_text);
    db.prepare(`INSERT INTO gwy_notice (id, year, exam_type, province, title, url, text_source_url, age_text, age_min, age_max, age_max_relaxed, age_relaxed_for, published, positions_file, positions_sha256, imported_at)
      VALUES (@id, @year, @exam_type, @province, @title, @url, @text_source_url, @age_text, @age_min, @age_max, @age_max_relaxed, @age_relaxed_for, @published, @file, @sha, @now)
      ON CONFLICT(id) DO UPDATE SET age_text=excluded.age_text, age_min=excluded.age_min, age_max=excluded.age_max, age_max_relaxed=excluded.age_max_relaxed, age_relaxed_for=excluded.age_relaxed_for,
        positions_file=COALESCE(excluded.positions_file, positions_file), positions_sha256=COALESCE(excluded.positions_sha256, positions_sha256), imported_at=excluded.imported_at`)
      .run({ ...GK2027, ...age, file: dump?.file ?? null, sha: dump?.sha256 ?? null, now });

    // graduate catalog
    let gradLines = opts.gradLines;
    if (gradLines === undefined) {
      const p = rawPath('gwy-grad_catalog');
      gradLines = existsSync(p) ? ((JSON.parse(readFileSync(p, 'utf8')).sources?.[GRAD_CATALOG.id]?.[0]?.lines as string[] | undefined) ?? null) : null;
    }
    if (gradLines) {
      const grad = parseGradCatalog(gradLines);
      if (grad.length < 100) throw new Error(`grad catalog parse looks wrong: ${grad.length} entries`);
      const ins = db.prepare('INSERT OR REPLACE INTO gwy_grad_discipline (code, name, kind, category_code, master_only, note, edition, source_url, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)');
      db.transaction(() => { db.prepare('DELETE FROM gwy_grad_discipline').run(); for (const g of grad) ins.run(g.code, g.name, g.kind, g.category_code, g.master_only, g.note, GRAD_CATALOG.edition, GRAD_CATALOG.url, now); })();
    }

    // rules
    const rules: Rule[] = parseCsv(readFileSync(opts.rulesCsv ?? RULES_CSV, 'utf8')).map((r, i) => ({
      id: i + 1, source: r.source || null, context: r.context || null, phrase: r.phrase!, level: (r.level || 'any') as Level, catalog: (r.catalog || null) as Rule['catalog'], major_code: r.major_code || null, match_type: r.match_type as MatchType,
    }));
    db.transaction(() => {
      db.prepare('UPDATE gwy_position_major SET rule_id = NULL').run();
      db.prepare('DELETE FROM gwy_major_rule').run();
      const ins = db.prepare('INSERT INTO gwy_major_rule (id, phrase, level, catalog, major_code, match_type, note, reviewer, source, context) VALUES (?,?,?,?,?,?,?,?,?,?)');
      const csv = parseCsv(readFileSync(opts.rulesCsv ?? RULES_CSV, 'utf8'));
      rules.forEach((r, i) => ins.run(r.id, r.phrase, r.level, r.catalog, r.major_code, r.match_type, csv[i]!.note || null, csv[i]!.reviewer || null, r.source ?? null, r.context ?? null));
    })();

    const legacy = parseCsv(readFileSync(opts.legacyCsv ?? LEGACY_CSV, 'utf8'));
    db.transaction(() => {
      db.prepare('DELETE FROM gwy_grad_legacy').run();
      const ins = db.prepare('INSERT OR REPLACE INTO gwy_grad_legacy (old_name, old_code, parent_codes, source, note, reviewed) VALUES (?,?,?,?,?,?)');
      for (const l of legacy) ins.run(l.old_name, l.old_code || null, l.parent_codes, l.source, l.note || null, Number(l.reviewed) ? 1 : 0);
    })();
    const cat: Catalogs = {
      gradLegacy: new Map(legacy.map((l) => [l.old_name!, l.parent_codes!.split('|').map((c) => c.trim()).filter(Boolean)])),
      majors: new Map((db.prepare('SELECT code, name FROM major').all() as { code: string; name: string }[]).map((r) => [r.code, r.name])),
      classes: new Map((db.prepare('SELECT code, name FROM major_class').all() as { code: string; name: string }[]).map((r) => [r.code, r.name])),
      ugCategories: new Map((db.prepare('SELECT code, name FROM major_category').all() as { code: string; name: string }[]).map((r) => [r.code, r.name])),
      grad: new Map((db.prepare('SELECT code, name FROM gwy_grad_discipline').all() as { code: string; name: string }[]).map((r) => [r.code, r.name])),
    };
    const result: IngestResult = { positions: 0, hires: 0, code_doubtful: 0, undergrad: { positions: 0, hires: 0, positions_with_match: 0, hires_with_match: 0, position_majors: 0, distinct_majors: 0, positions_incomplete: 0, hires_incomplete: 0, positions_no_match: 0, hires_no_match: 0 }, exclusions_partial: 0, exclusions_unmatched: 0, exclusions_unmatched_distinct: 0, via_legacy: 0, remarks_override: { applied: 0, unparsed: 0 }, needs_grad: { positions: 0, hires: 0, positions_with_match: 0, hires_with_match: 0 }, phrases: 0, by_type: { exact: 0, category: 0, unlimited: 0, related: 0, unresolved: 0 }, positions_all_resolved: 0, unresolved: [], grad: cat.grad.size };
    if (!dump) { console.warn(`[gwy] no positions yet (${OUT_FILE()}); run crawl:gwy-gk2027 first`); return result; }
    if (!cat.majors.size) console.warn('[gwy] WARNING: no 本科 majors in the DB (run the CAREER majors ingest) — 本科 phrases will all be unresolved');
    if (!cat.grad.size) console.warn('[gwy] WARNING: no 研究生 catalog (run crawl:gwy-grad) — 研究生 phrases will all be unresolved');

    const insPos = db.prepare(`INSERT INTO gwy_position (notice_id, dept_code, position_code, sheet, row_no, hires, needs_grad, majors_incomplete, raw_json, ${POS_COLS.join(', ')})
      VALUES (@notice_id, @dept_code, @position_code, @sheet, @row_no, @hires, @needs_grad, @majors_incomplete, @raw_json, ${POS_COLS.map((c) => '@' + c).join(', ')})`);
    const insM = db.prepare('INSERT INTO gwy_position_major (notice_id, dept_code, position_code, seq, level, segment, phrase, catalog, major_code, match_type, rule_id, reviewed, code_doubtful, remarks_override, exclusions_partial, via) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insU = db.prepare('INSERT OR IGNORE INTO gwy_position_undergrad_major (notice_id, dept_code, position_code, major_code, via_seq) VALUES (?,?,?,?,?)');
    const ugMajors = new Set<string>();
    const setIncomplete = db.prepare('UPDATE gwy_position SET majors_incomplete = 1 WHERE notice_id = ? AND dept_code = ? AND position_code = ?');
    const unmatched = new Set<string>();
    const agg = new Map<string, IngestResult['unresolved'][number]>();
    db.transaction(() => {
      db.prepare('DELETE FROM gwy_position_major WHERE notice_id = ?').run(dump.notice_id);
      db.prepare('DELETE FROM gwy_position_undergrad_major WHERE notice_id = ?').run(dump.notice_id);
      db.prepare('DELETE FROM gwy_position WHERE notice_id = ?').run(dump.notice_id);
      const seen = new Set<string>();
      for (const r of dump.rows) {
        const k = `${r.cols.dept_code}/${r.cols.position_code}`;
        if (seen.has(k)) { console.warn(`[gwy] duplicate 部门代码/职位代码 ${k} (${r.file}/${r.sheet} row ${r.row_no}) skipped`); continue; }
        seen.add(k);
        const hires = Number(r.cols.hires);
        const h = Number.isFinite(hires) ? hires : 0;
        const ng = needsGrad(r.cols.education ?? '');
        insPos.run({ needs_grad: ng ? 1 : 0, majors_incomplete: 0, notice_id: dump.notice_id, dept_code: r.cols.dept_code, position_code: r.cols.position_code, sheet: r.sheet, row_no: r.row_no, hires: Number.isFinite(hires) ? hires : null,
          raw_json: JSON.stringify(r.raw), ...Object.fromEntries(POS_COLS.map((c) => [c, r.cols[c] ?? null])) });
        result.positions++; result.hires += Number.isFinite(hires) ? hires : 0;
        const ms = matchMajors(r.cols.major_text ?? '', cat, rules, r.cols.education ?? '', r.cols.remarks ?? '');
        const incomplete = ms.some((m) => m.match_type === 'unresolved' || m.match_type === 'related');
        if (incomplete) setIncomplete.run(dump.notice_id, r.cols.dept_code, r.cols.position_code);
        let ok = true;
        const admitted = new Set<string>();
        for (const m of ms) {
          insM.run(dump.notice_id, r.cols.dept_code, r.cols.position_code, m.seq, m.level, m.segment, m.phrase, m.catalog, m.major_code, m.match_type, m.rule_id, m.rule_id ? 1 : 0, m.code_doubtful, m.remarks_override ?? 0, m.exclusions_partial ?? 0, m.via ?? null);
          if (m.exclusions_partial === 2) { result.exclusions_unmatched++; unmatched.add(m.phrase); } else result.exclusions_partial += m.exclusions_partial ?? 0; if (m.via === 'legacy') result.via_legacy++;
          if (m.remarks_override) result.remarks_override[m.remarks_override === 1 ? 'applied' : 'unparsed']++;
          result.phrases++; result.by_type[m.match_type]++; result.code_doubtful += m.code_doubtful;
          if (!ng) for (const c of m.undergrad_majors) if (!admitted.has(c)) { admitted.add(c); insU.run(dump.notice_id, r.cols.dept_code, r.cols.position_code, c, m.seq); }
          if (m.match_type === 'unresolved' || m.match_type === 'related') {
            ok = false;
            const key = `${m.level}\t${m.phrase}`;
            const a = agg.get(key) ?? { phrase: m.phrase, level: m.level, match_type: m.match_type, positions: 0, hires: 0, ...(m.exclusions_partial === 2 ? { note: '排除项未对上' } : {}) };
            a.positions++; a.hires += Number.isFinite(hires) ? hires : 0; agg.set(key, a);
          }
        }
        if (ok) result.positions_all_resolved++;
        const unlimited = ms.some((m) => m.match_type === 'unlimited');
        if (ng) {
          result.needs_grad.positions++; result.needs_grad.hires += h;
          if (unlimited || ms.some((m) => m.targets.length)) { result.needs_grad.positions_with_match++; result.needs_grad.hires_with_match += h; }
        } else {
          result.undergrad.positions++; result.undergrad.hires += h;

          if (unlimited || admitted.size) {
            result.undergrad.positions_with_match++; result.undergrad.hires_with_match += h;
            if (incomplete) { result.undergrad.positions_incomplete++; result.undergrad.hires_incomplete += h; }
          } else { result.undergrad.positions_no_match++; result.undergrad.hires_no_match += h; }
          result.undergrad.position_majors += admitted.size; for (const c of admitted) ugMajors.add(c);
        }
      }
    })();
    result.undergrad.distinct_majors = ugMajors.size;
    result.exclusions_unmatched_distinct = unmatched.size;
    result.unresolved = [...agg.values()].sort((a, b) => b.positions - a.positions || b.hires - a.hires);

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${dump.notice_id}_unresolved_majors.csv`), ['phrase,level,match_type,positions,hires,suggest_catalog,suggest_major_code,suggest_match_type,note',
      ...result.unresolved.map((u) => [u.phrase, u.level, u.match_type, u.positions, u.hires, '', '', '', u.note ?? ''].map(csvCell).join(','))].join('\n') + '\n');
    const { unresolved, ...stats } = result;
    writeFileSync(join(outDir, `${dump.notice_id}_match_stats.json`), JSON.stringify({ ...stats, notice: GK2027.id, age, source: dump.source, file: dump.file, sha256: dump.sha256, unresolved_phrases: unresolved.length, at: now }, null, 2));
    console.log(`[gwy] 本科 basis: ${JSON.stringify(result.undergrad)}; 需读研后报考: ${JSON.stringify(result.needs_grad)}; code_doubtful phrases: ${result.code_doubtful}`);
    console.log(`[gwy] ${result.positions} positions, ${result.hires} hires; ${result.phrases} 专业 phrases: ${JSON.stringify(result.by_type)}; ${result.positions_all_resolved} positions fully resolved; ${unresolved.length} distinct unresolved/related phrases -> ${outDir}`);
    return result;
  } finally { db.close(); }
}

if (isMain(import.meta.url)) ingest();
