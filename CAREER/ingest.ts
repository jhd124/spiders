/**
 * CAREER ingest: apply migrations, then upsert cleaned master data into data/career.db.
 *   npm run career:ingest                  # everything that has cleaned output
 *   npm run career:ingest -- moe_majors    # only some crawlers (names as in CAREER/<name>/)
 * Upserts are keyed by the official codes, so re-running is idempotent. Seeds (pilot majors,
 * pilot schools) are loaded from CAREER/seeds/*.csv on every run.
 */
import { loadOccupationDisplay } from './display.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { cleanPath } from '../lib/io.js';
import { isMain } from '../lib/main.js';
import { rebuildFts } from '../lib/fts.js';
import { migrate } from './migrate.js';
import { CAREER_DB } from './db.js';
import datasets from './dataset.js';
import type { ParsedCatalog } from './moe_majors/clean.js';
import { LEVEL_NAMES, type Occupation } from './occupations/clean.js';
import type { FetchedDoc } from './fetchdoc.js';
import { ingestCurriculum } from './curriculum/load.js';
import { syncReportSources } from './report_sources.js';
import { loadOccupationSkills } from './match.js';
import { applyAliasRules, loadSkillAliases } from './aliases.js';

const HERE = dirname(fileURLToPath(import.meta.url));
type DocMeta = Omit<FetchedDoc, 'path'>;

function upsert(db: Database.Database, table: string, key: string[], rows: Record<string, unknown>[]): number {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]!);
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})
     ON CONFLICT (${key.join(', ')}) DO UPDATE SET ${cols.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')}`,
  );
  for (const r of rows) stmt.run(r);
  return rows.length;
}

const b = (v: boolean) => (v ? 1 : 0);

/** 只授工学 / 可授工学 + console label (mirrors migration 004). */
export function degreeFields(cats: string[]) {
  const eng = cats.includes('工学');
  const others = cats.filter((c) => c !== '工学');
  return {
    engineering_degree_type: eng ? (others.length ? 'optional' : 'only') : null,
    degree_display: eng
      ? others.length ? `可授工学/${others.join('/')}` : '只授工学'
      : cats.length > 1 ? `可授${cats.join('/')}` : `授${cats[0] ?? ''}`,
  };
}

/** Expert review of the occupation table (2026-10-12): valid while the mirror file is byte-identical. */
const OCC_REVIEW = {
  sha256: 'e2c9eb0ed21981139e33f7ed503dd7b5e851458c9f53b6428737962fb8d3a236',
  note: 'expert 2026-10-12',
  nameSource: 'official-2022 (via mirror:cccac, expert-verified)',
};

function csv(file: string): Record<string, string>[] {
  return csvFile(join(HERE, 'seeds', file));
}

function csvFile(path: string): Record<string, string>[] {
  const [head = '', ...lines] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v.trim()])));
}

function docRow(m: DocMeta) {
  return {
    id: m.doc.id,
    title: m.doc.title,
    publisher: m.doc.publisher,
    edition: m.doc.edition,
    url: m.doc.url,
    fetched_url: m.fetched_url,
    notice_url: m.doc.notice_url ?? null,
    is_official: b(m.doc.is_official),
    sha256: m.sha256,
    bytes: m.bytes,
    fetched_at: m.fetched_at,
    note: m.doc.note ?? null,
  };
}

function ingestMajors(db: Database.Database) {
  const all = JSON.parse(readFileSync(cleanPath('career-moe_majors'), 'utf8')) as ParsedCatalog[];
  const editions = all.sort((a, b) => b.edition - a.edition); // newest first
  const latest = editions[0];
  if (!latest) throw new Error('no catalog editions in clean output');
  const now = new Date().toISOString();
  const prov = (p: ParsedCatalog, page: number | null) => ({
    source_url: p.doc.doc.url,
    source_doc_id: p.doc.doc.id,
    ...(page === null ? {} : { source_page: page }),
    fetched_at: p.doc.fetched_at,
    extraction_method: 'pdf_parse',
    confidence: 1,
    reviewed: 0,
  });
  const earliestWith = (base: string) => {
    let ed: number | null = null;
    for (const p of editions) if (p.majors.some((m) => m.base_code === base)) ed = p.edition;
    return ed;
  };
  let n = 0;
  for (const p of editions) upsert(db, 'source_document', ['id'], [docRow(p.doc)]);
  // latest edition first; older editions only add codes the latest one no longer lists
  for (const p of editions) {
    const isLatest = p === latest;
    const latestCls = new Set(latest.classes.map((c) => c.code));
    const latestMaj = new Set(latest.majors.map((m) => m.base_code));
    const cats = p.categories.filter((c) => isLatest || !latest.categories.some((x) => x.code === c.code));
    upsert(db, 'major_category', ['code'], cats.map((c) => ({ code: c.code, name: c.name, catalog_edition: p.edition, ...prov(p, null) })));
    const cls = p.classes.filter((c) => isLatest || !latestCls.has(c.code));
    upsert(
      db,
      'major_class',
      ['code'],
      cls.map((c) => ({
        code: c.code, name: c.name, category_code: c.category_code,
        status: isLatest ? '在目录' : '已移出目录', catalog_edition: p.edition, ...prov(p, c.page),
      })),
    );
    const majors = p.majors.filter((m) => isLatest || !latestMaj.has(m.base_code));
    n += upsert(
      db,
      'major',
      ['code'],
      majors.map((m) => ({
        code: m.code, base_code: m.base_code, name: m.name,
        category_code: m.category_code, category_name: m.category_name,
        class_code: m.class_code, class_name: m.class_name,
        is_special: b(m.is_special), is_controlled: b(m.is_controlled), is_engineering: b(m.is_engineering),
        ...degreeFields(m.degree_categories),
        degree_categories: m.degree_categories.join('|'), degree_note: m.degree_note, former_code: m.former_code,
        duration_years: null, added_year: null, first_catalog_edition: earliestWith(m.base_code),
        status: isLatest ? '在目录' : '已移出目录', catalog_edition: p.edition,
        ...prov(p, m.page), updated_at: now,
      })),
    );
  }
  console.log(`[career] majors: upserted ${n} (latest edition ${latest.edition}: ${latest.majors.length} 专业 / ${latest.classes.length} 专业类)`);

  // pilot majors: verify against the latest catalog, never "fix" silently
  const pilots = csv('pilot_majors.csv') as { major_code: string; expected_name: string; sort_order: string; source: string }[];
  const byCode = new Map(latest.majors.map((m) => [m.code, m]));
  const problems: string[] = [];
  db.prepare('DELETE FROM pilot_major').run();
  for (const r of pilots) {
    const m = byCode.get(r.major_code);
    if (!m) { problems.push(`${r.major_code} ${r.expected_name}: code not in ${latest.edition} catalog`); continue; }
    if (m.name !== r.expected_name) problems.push(`${r.major_code}: expert "${r.expected_name}" vs catalog "${m.name}"`);
    upsert(db, 'pilot_major', ['major_code'], [{ major_code: r.major_code, sort_order: Number(r.sort_order), expected_name: r.expected_name, source: r.source }]);
  }
  console.log(`[career] pilot majors: ${pilots.length - problems.filter((p) => p.includes('not in')).length}/${pilots.length} loaded; mismatches: ${problems.length ? '\n  ' + problems.join('\n  ') : 'none'}`);
}

function ingestOccupations(db: Database.Database) {
  const c = JSON.parse(readFileSync(cleanPath('career-occupations'), 'utf8')) as { doc: DocMeta; occupations: Occupation[] };
  upsert(db, 'source_document', ['id'], [docRow(c.doc)]);
  const now = new Date().toISOString();
  const reviewedOk = c.doc.sha256 === OCC_REVIEW.sha256;
  if (!reviewedOk) console.warn('[career] occupation source changed since the expert review -> rows marked reviewed=0');
  const diff = csvFile(join(HERE, 'review', 'occupation_name_diff.csv')) as { code: string; decision: string; alias_added: string }[];
  const decided = new Set(diff.filter((r) => r.decision.startsWith('use imported')).map((r) => r.code));
  const rows = [...c.occupations]
    .sort((a, b) => a.level - b.level)
    .map((o) => ({
      code: o.code, level: o.level, level_name: LEVEL_NAMES[o.level], name: o.name, parent_code: o.parent_code,
      gbm_code: o.gbm_code, is_digital: b(o.is_digital), is_green: b(o.is_green),
      edition: c.doc.doc.edition, source_batch: '大典2022', status: '有效',
      source_url: c.doc.doc.url, source_doc_id: c.doc.doc.id, source_page: o.page, fetched_at: c.doc.fetched_at,
      extraction_method: 'pdf_parse', confidence: c.doc.doc.is_official ? 1 : 0.9, updated_at: now,
      name_source: c.doc.doc.is_official ? 'official' : decided.has(o.code) && reviewedOk ? OCC_REVIEW.nameSource : 'mirror:cccac',
      reviewed: reviewedOk ? 1 : 0,
      reviewer_note: reviewedOk ? OCC_REVIEW.note : null,
      digital_flag_source: o.is_digital ? 'mirror:cccac' : null,
      green_flag_source: o.is_green ? 'mirror:cccac' : null,
    }));
  const n = upsert(db, 'occupation', ['code'], rows);
  const by = (l: number) => rows.filter((r) => r.level === l).length;
  console.log(`[career] occupations: upserted ${n} (大类 ${by(1)}, 中类 ${by(2)}, 小类 ${by(3)}, 细类 ${by(4)})`);
  fillFlagsFromDraft(db);
  // 公示稿 old names as aliases (expert 2026-10-12); never point an alias at a code whose current name differs from it elsewhere
  const exists = db.prepare('SELECT code FROM occupation WHERE name = ?');
  let na = 0;
  for (const r of diff.filter((r) => r.alias_added)) {
    const clash = exists.get(r.alias_added) as { code: string } | undefined;
    if (clash) throw new Error(`alias ${r.alias_added} for ${r.code} is the current name of ${clash.code}`);
    na += upsert(db, 'occupation_alias', ['occupation_code', 'alias'], [
      { occupation_code: r.code, alias: r.alias_added, alias_type: '公示稿旧称', source: '公示稿 2022-07 (expert 2026-10-12)' },
    ]);
  }
  db.prepare(`UPDATE occupation SET aliases = (SELECT GROUP_CONCAT(a.alias, '|') FROM occupation_alias a WHERE a.occupation_code = occupation.code)`).run();
  console.log(`[career] occupation aliases: ${na}; reviewed=${reviewedOk ? 1 : 0}`);
}

const DRAFT_URL = 'https://file.m12333.cn/upfile/download/063d5abb-fada-f27f-a1e8-3de63b44d5df.pdf';

/** Expert decision 2026-10-12: the 公示稿 S/L markings are authoritative for filling missing flags. */
function fillFlagsFromDraft(db: Database.Database) {
  const draft = csv('occupation_draft_2022.csv') as { code: string; name: string; flag: string }[];
  upsert(db, 'occupation_draft_2022', ['code'], draft.map((d) => ({ code: d.code, name: d.name, flag: d.flag, source_url: DRAFT_URL, extraction_method: 'pdf_parse', reviewed: 0 })));
  const counts = () => db.prepare(`SELECT SUM(is_digital) s, SUM(is_green) l, SUM(is_digital * is_green) ls FROM occupation WHERE level = 4`).get() as { s: number; l: number; ls: number };
  const before = counts();
  const byName = new Map(draft.map((d) => [d.name, d]));
  const byCode = new Map(draft.map((d) => [d.code, d]));
  const l4 = db.prepare(`SELECT code, name, is_digital, is_green FROM occupation WHERE level = 4`).all() as { code: string; name: string; is_digital: number; is_green: number }[];
  const set = db.prepare(`UPDATE occupation SET is_digital = ?, is_green = ?, digital_flag_source = ?, green_flag_source = ? WHERE code = ?`);
  let filled = 0, matched = 0;
  for (const o of l4) {
    const sc = byCode.get(o.code);
    const d = byName.get(o.name) ?? (sc && sc.name.length >= 6 && o.name.startsWith(sc.name) ? sc : undefined);
    if (!d) continue;
    matched++;
    const dS = d.flag.includes('S'), dL = d.flag.includes('L');
    const src = (mirror: number, draftHas: boolean) => (mirror && draftHas ? 'mirror:cccac+公示稿' : mirror ? 'mirror:cccac' : draftHas ? '公示稿' : null);
    if ((dS && !o.is_digital) || (dL && !o.is_green)) filled++;
    set.run(o.is_digital || dS ? 1 : 0, o.is_green || dL ? 1 : 0, src(o.is_digital, dS), src(o.is_green, dL), o.code);
  }
  const after = counts();
  console.log(`[career] S/L flags (细类): before S=${before.s} L=${before.l} L/S=${before.ls}; 公示稿 matched ${matched}/${l4.length}, filled ${filled}; after S=${after.s} L=${after.l} L/S=${after.ls}`);
}

function ingestSchools(db: Database.Database) {
  const rows = (csv('schools_pilot.csv') as { name: string; tier: string; source: string }[]).map((r) => ({ id: `name:${r.name}`, name: r.name, pilot_tier: r.tier, source: r.source }));
  upsert(db, 'school', ['id'], rows);
  console.log(`[career] pilot schools: ${rows.length}`);
}

export function ingest(only: string[] = []) {
  migrate();
  const db = new Database(CAREER_DB);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    const want = (n: string) => !only.length || only.includes(n);
    db.transaction(() => {
      if (want('moe_majors') && existsSync(cleanPath('career-moe_majors'))) ingestMajors(db);
      if (want('occupations') && existsSync(cleanPath('career-occupations'))) ingestOccupations(db);
      ingestSchools(db);
      if (want('curriculum')) ingestCurriculum(db);
      syncReportSources(db);
      loadSkillAliases(db);
      applyAliasRules(db);
      loadOccupationSkills(db);
      loadOccupationDisplay(db);
    })();
    for (const d of datasets) console.log(`[career] fts ${d.fts.table}: ${rebuildFts(db, d)} rows`);
  } finally {
    db.close();
  }
}

if (isMain(import.meta.url)) ingest(process.argv.slice(2).filter((a) => !a.startsWith('-')));
