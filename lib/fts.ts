/**
 * Generic SQLite FTS5 support for datasets (see DatasetConfig.fts / topics).
 *
 * - Index: a plain FTS5 table `<fts.table>(<idColumn> UNINDEXED, <fts.columns>...)`, tokenizer unicode61
 *   (case-insensitive, diacritics folded, punctuation = separator), no stemming.
 *   Rebuilt by ingest (`rebuildFts`) and lazily by the web server when missing/stale (`ensureFts`).
 * - Keyword syntax (`parseKeywordQuery`): words are ANDed and matched as whole words;
 *   "double quotes" = phrase; a trailing * = prefix (`learn*`); `OR` between terms = or.
 *   Short all-caps acronyms typed by the user (AI, NLP, LLM…) are additionally required to appear
 *   in that exact case as a whole word (regexp check), so "AI" doesn't match Italian "ai".
 */
import { existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { DatasetConfig, TopicDef } from './dataset.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`bad identifier ${s}`);
  return s;
};

/** Escape one term/phrase as an FTS5 string ("..." with doubled quotes). */
export const ftsPhrase = (t: string) => `"${t.replace(/"/g, '""')}"`;

function signature(db: Database.Database, cfg: DatasetConfig): string {
  const upd = cfg.fts.updatedColumn ? `, MAX(${ident(cfg.fts.updatedColumn)}) AS u` : '';
  const r = db.prepare(`SELECT COUNT(*) AS n${upd} FROM ${ident(cfg.table)}`).get() as { n: number; u?: string | null };
  return `${r.n}|${r.u ?? ''}`;
}

/** (Re)build the FTS table from the source table. Needs a writable connection. */
export function rebuildFts(db: Database.Database, cfg: DatasetConfig): number {
  const t = ident(cfg.fts.table);
  const cols = cfg.fts.columns.map(ident);
  const id = ident(cfg.idColumn);
  db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.exec(`CREATE VIRTUAL TABLE ${t} USING fts5(${id} UNINDEXED, ${cols.join(', ')}, tokenize = 'unicode61 remove_diacritics 2')`);
  db.exec(`CREATE TABLE IF NOT EXISTS _fts_meta (fts_table TEXT PRIMARY KEY, signature TEXT NOT NULL, built_at TEXT NOT NULL)`);
  const n = db.transaction(() => {
    const info = db
      .prepare(`INSERT INTO ${t} (${id}, ${cols.join(', ')}) SELECT ${id}, ${cols.map((c) => `COALESCE(${c}, '')`).join(', ')} FROM ${ident(cfg.table)}`)
      .run();
    db.prepare(`INSERT OR REPLACE INTO _fts_meta VALUES (?, ?, ?)`).run(t, signature(db, cfg), new Date().toISOString());
    return info.changes;
  })();
  return n;
}

function isFresh(db: Database.Database, cfg: DatasetConfig): boolean {
  try {
    const m = db.prepare(`SELECT signature FROM _fts_meta WHERE fts_table = ?`).get(cfg.fts.table) as { signature: string } | undefined;
    return !!m && m.signature === signature(db, cfg);
  } catch {
    return false;
  }
}

const checked = new Map<string, number>();

/** Make sure the FTS index exists and matches the source table; rebuilds it if not. Cheap when fresh. */
export function ensureFts(cfg: DatasetConfig): void {
  if (!existsSync(cfg.dbPath)) return;
  const st = statSync(cfg.dbPath);
  const wal = existsSync(cfg.dbPath + '-wal') ? statSync(cfg.dbPath + '-wal').mtimeMs : 0;
  const stamp = Math.max(st.mtimeMs, wal);
  const key = `${cfg.dbPath}#${cfg.fts.table}`;
  if (checked.get(key) === stamp) return;
  const ro = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
  let fresh: boolean;
  try {
    fresh = isFresh(ro, cfg);
  } finally {
    ro.close();
  }
  if (!fresh) {
    const rw = new Database(cfg.dbPath);
    try {
      const n = rebuildFts(rw, cfg);
      console.log(`[fts] rebuilt ${cfg.fts.table} (${n} rows) in ${cfg.dbPath}`);
    } finally {
      rw.close();
    }
  }
  const st2 = statSync(cfg.dbPath);
  const wal2 = existsSync(cfg.dbPath + '-wal') ? statSync(cfg.dbPath + '-wal').mtimeMs : 0;
  checked.set(key, Math.max(st2.mtimeMs, wal2));
}

/* ---------------- query building ---------------- */

/** Register helper SQL functions on a connection: re_cs(pattern, text) -> 1/0 (JS RegExp, case-sensitive). */
export function registerFunctions(db: Database.Database): void {
  const cache = new Map<string, RegExp>();
  db.function('re_cs', { deterministic: true }, (pattern: unknown, text: unknown) => {
    if (typeof pattern !== 'string' || typeof text !== 'string') return 0;
    let re = cache.get(pattern);
    if (!re) cache.set(pattern, (re = new RegExp(pattern, 'u')));
    return re.test(text) ? 1 : 0;
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** whole-word, case-sensitive pattern for a literal token/phrase */
export const wordPattern = (term: string) =>
  `(?<![\\p{L}\\p{N}])${term.trim().split(/\s+/).map(escapeRe).join('[^\\p{L}\\p{N}]+')}(?![\\p{L}\\p{N}])`;

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

const ACRONYM = /^[A-Z][A-Z0-9]{1,4}$/;

/**
 * Parse a user keyword string into an FTS5 MATCH expression (+ case-sensitive acronym checks).
 * Returns null for an empty query.
 */
export function parseKeywordQuery(q: string): { match: string; acronyms: string[] } | null {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  const acronyms: string[] = [];
  while ((m = re.exec(q))) {
    if (m[1] !== undefined) {
      const phrase = m[1].trim();
      if (phrase) tokens.push(ftsPhrase(phrase));
      continue;
    }
    let w = m[2]!;
    if (w === 'OR' || w === '|') {
      if (tokens.length && tokens[tokens.length - 1] !== 'OR') tokens.push('OR');
      continue;
    }
    const prefix = w.endsWith('*');
    w = w.replace(/\*+$/, '');
    // drop characters that the tokenizer would treat as separators at the edges
    const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!core) continue;
    if (!prefix && ACRONYM.test(core)) acronyms.push(core);
    tokens.push(ftsPhrase(core) + (prefix ? '*' : ''));
  }
  while (tokens[0] === 'OR') tokens.shift();
  while (tokens[tokens.length - 1] === 'OR') tokens.pop();
  if (!tokens.length) return null;
  // implicit AND between adjacent terms (FTS5 default), explicit OR kept
  return { match: tokens.join(' '), acronyms };
}

/** WHERE fragment for a keyword query on dataset `cfg` (source table must be aliased as `t`). */
export function keywordCondition(cfg: DatasetConfig, q: string): SqlFragment | null {
  const parsed = parseKeywordQuery(q);
  if (!parsed) return null;
  const id = ident(cfg.idColumn);
  const fts = ident(cfg.fts.table);
  const parts = [`t.${id} IN (SELECT ${id} FROM ${fts} WHERE ${fts} MATCH ?)`];
  const params: unknown[] = [parsed.match];
  // only enforce acronym case when the query has no OR (otherwise semantics get murky)
  if (!parsed.match.includes(' OR ')) {
    for (const a of parsed.acronyms) {
      parts.push(`(${cfg.fts.columns.map((c) => `re_cs(?, t.${ident(c)})`).join(' OR ')})`);
      params.push(...cfg.fts.columns.map(() => wordPattern(a)));
    }
  }
  return { sql: parts.join(' AND '), params };
}

/** WHERE fragment for a topic preset (source table aliased as `t`). */
export function topicCondition(cfg: DatasetConfig, topic: TopicDef): SqlFragment {
  const id = ident(cfg.idColumn);
  const fts = ident(cfg.fts.table);
  const cols = (topic.columns ?? cfg.fts.columns).map(ident);
  for (const c of cols) if (!cfg.fts.columns.includes(c)) throw new Error(`topic ${topic.key}: column ${c} is not in fts.columns`);
  const scope = cols.length === cfg.fts.columns.length ? '' : `{${cols.join(' ')}} : `;
  const or: string[] = [];
  const params: unknown[] = [];
  if (topic.terms.length) {
    or.push(`t.${id} IN (SELECT ${id} FROM ${fts} WHERE ${fts} MATCH ?)`);
    params.push(`${scope}(${topic.terms.map(ftsPhrase).join(' OR ')})`);
  }
  for (const term of topic.caseSensitiveTerms ?? []) {
    // FTS narrows candidates (case-insensitive), the regexp enforces exact case + word boundaries
    or.push(
      `(t.${id} IN (SELECT ${id} FROM ${fts} WHERE ${fts} MATCH ?) AND (${cols.map((c) => `re_cs(?, t.${c})`).join(' OR ')}))`,
    );
    params.push(`${scope}${ftsPhrase(term)}`, ...cols.map(() => wordPattern(term)));
  }
  return { sql: `(${or.join(' OR ')})`, params };
}
