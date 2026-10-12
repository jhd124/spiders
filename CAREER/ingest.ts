/**
 * CAREER ingest: apply migrations, then upsert cleaned master data into data/career.db.
 *   npm run career:ingest                  # everything that has cleaned output
 *   npm run career:ingest -- moe_majors    # only some crawlers (names as in CAREER/<name>/)
 * Upserts are keyed by the official codes, so re-running is idempotent. Seeds (pilot majors,
 * pilot schools) are loaded from CAREER/seeds/*.csv on every run.
 */
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

function csv(file: string): Record<string, string>[] {
  const [head = '', ...lines] = readFileSync(join(HERE, 'seeds', file), 'utf8').trim().split(/\r?\n/);
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
  const rows = [...c.occupations]
    .sort((a, b) => a.level - b.level)
    .map((o) => ({
      code: o.code, level: o.level, level_name: LEVEL_NAMES[o.level], name: o.name, parent_code: o.parent_code,
      gbm_code: o.gbm_code, is_digital: b(o.is_digital), is_green: b(o.is_green),
      edition: c.doc.doc.edition, source_batch: '大典2022', status: '有效',
      source_url: c.doc.doc.url, source_doc_id: c.doc.doc.id, source_page: o.page, fetched_at: c.doc.fetched_at,
      extraction_method: 'pdf_parse', confidence: c.doc.doc.is_official ? 1 : 0.9, reviewed: 0, updated_at: now,
    }));
  const n = upsert(db, 'occupation', ['code'], rows);
  const by = (l: number) => rows.filter((r) => r.level === l).length;
  console.log(`[career] occupations: upserted ${n} (大类 ${by(1)}, 中类 ${by(2)}, 小类 ${by(3)}, 细类 ${by(4)})`);
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
    })();
    for (const d of datasets) console.log(`[career] fts ${d.fts.table}: ${rebuildFts(db, d)} rows`);
  } finally {
    db.close();
  }
}

if (isMain(import.meta.url)) ingest(process.argv.slice(2).filter((a) => !a.startsWith('-')));
