/**
 * Generic query layer over group datasets (<GROUP>/dataset.ts -> DatasetConfig).
 * Column / table names come from the config and are checked against the live table schema;
 * user-supplied values are always bound parameters.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { ROOT } from '../../lib/io.js';
import { discoverGroups } from '../../lib/discovery.js';
import type { DatasetConfig, DatasetModule } from '../../lib/dataset.js';
import { ensureFts, keywordCondition, registerFunctions, topicCondition } from '../../lib/fts.js';
import type { DatasetView, QueryResult } from '../shared/types.js';
import { HttpError } from './runs.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** All datasets of a group as [id, config]; id is `<GROUP>` or `<GROUP>.<key>` when dataset.ts exports an array. */
async function loadGroupConfigs(group: string): Promise<[string, DatasetConfig][]> {
  const g = discoverGroups().find((x) => x.name === group);
  if (!g?.datasetFile) throw new HttpError(404, `group ${group} has no dataset.ts`);
  const mod = (await import(pathToFileURL(join(ROOT, g.datasetFile)).href)) as { default?: DatasetModule };
  const list = Array.isArray(mod.default) ? mod.default : mod.default ? [mod.default] : [];
  if (!list.length || list.some((c) => c.kind !== 'sqlite'))
    throw new HttpError(500, `${g.datasetFile} must default-export a sqlite DatasetConfig (or an array of them)`);
  if (!Array.isArray(mod.default)) return [[group, list[0]!]];
  return list.map((c) => {
    if (!c.key || !IDENT.test(c.key)) throw new HttpError(500, `${g.datasetFile}: every dataset in the array needs a key`);
    return [`${group}.${c.key}`, c];
  });
}

async function loadConfig(id: string): Promise<DatasetConfig> {
  const group = id.split('.')[0] ?? id;
  const found = (await loadGroupConfigs(group)).find(([k]) => k === id);
  if (!found) throw new HttpError(404, `no dataset ${id}`);
  return found[1];
}

/** Open the dataset DB read-only and return its column list; null if the DB/table doesn't exist yet. */
function open(cfg: DatasetConfig): { db: Database.Database; cols: Set<string> } | null {
  if (!existsSync(cfg.dbPath)) return null;
  if (!IDENT.test(cfg.table)) throw new HttpError(500, `bad table name ${cfg.table}`);
  ensureFts(cfg); // build / refresh the keyword index if ingest hasn't (cheap when fresh)
  const db = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
  registerFunctions(db);
  const cols = new Set((db.prepare(`PRAGMA table_info(${cfg.table})`).all() as { name: string }[]).map((c) => c.name));
  if (!cols.size) {
    db.close();
    return null;
  }
  return { db, cols };
}

function col(cols: Set<string>, name: string): string {
  if (!IDENT.test(name) || !cols.has(name)) throw new HttpError(500, `column ${name} not in table`);
  return name;
}

export async function listDatasets(): Promise<DatasetView[]> {
  const out: DatasetView[] = [];
  for (const g of discoverGroups()) {
    if (!g.datasetFile) continue;
    try {
      for (const [id] of await loadGroupConfigs(g.name)) out.push(await describeDataset(id));
    } catch (err) {
      out.push({
        group: g.name,
        title: g.name,
        available: false,
        reason: err instanceof Error ? err.message : String(err),
        total: 0,
        filters: [],
        topics: [],
        listColumns: [],
        idColumn: 'id',
        titleColumn: 'id',
      });
    }
  }
  return out;
}

export async function describeDataset(group: string): Promise<DatasetView> {
  const cfg = await loadConfig(group);
  const base: DatasetView = {
    group,
    title: cfg.title,
    description: cfg.description,
    available: false,
    total: 0,
    filters: [],
    topics: [],
    listColumns: cfg.listColumns,
    idColumn: cfg.idColumn,
    titleColumn: cfg.titleColumn,
  };
  const o = open(cfg);
  if (!o) return { ...base, reason: `数据库未生成：先运行 ${group} 的 ingest (${cfg.dbPath})` };
  try {
    const { db, cols } = o;
    const total = (db.prepare(`SELECT COUNT(*) n FROM ${cfg.table}`).get() as { n: number }).n;
    const filters = cfg.filters.map((f) => {
      const c = col(cols, f.column);
      const rows = db
        .prepare(`SELECT ${c} v, COUNT(*) n FROM ${cfg.table} WHERE ${c} IS NOT NULL GROUP BY ${c} ORDER BY n DESC`)
        .all() as { v: unknown; n: number }[];
      const options = rows.map((r) => {
        const value = String(r.v);
        const label = f.type === 'boolean' ? (value === '1' ? '是' : '否') : (f.labels?.[value] ?? value);
        return { value, label, count: r.n };
      });
      return { key: f.key, label: f.label, type: f.type, options };
    });
    const topics = (cfg.topics ?? []).map((tp) => {
      const cond = topicCondition(cfg, tp);
      const n = (db.prepare(`SELECT COUNT(*) n FROM ${cfg.table} t WHERE ${cond.sql}`).get(...cond.params) as { n: number }).n;
      return { key: tp.key, label: tp.label, count: n };
    });
    return { ...base, available: true, total, filters, topics };
  } finally {
    o.db.close();
  }
}

function parseRow(cfg: DatasetConfig, row: Record<string, unknown>): Record<string, unknown> {
  for (const c of cfg.jsonColumns ?? []) {
    const v = row[c];
    if (typeof v === 'string') {
      try {
        row[c] = JSON.parse(v);
      } catch {
        /* keep text */
      }
    }
  }
  return row;
}

export async function queryDataset(group: string, params: URLSearchParams): Promise<QueryResult> {
  const cfg = await loadConfig(group);
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.get('pageSize') ?? 20) || 20));
  const o = open(cfg);
  if (!o) return { total: 0, page, pageSize, items: [] };
  try {
    const { db, cols } = o;
    const where: string[] = [];
    const args: unknown[] = [];
    const q = params.get('q')?.trim();
    if (q) {
      const kw = keywordCondition(cfg, q);
      if (kw) {
        where.push(kw.sql);
        args.push(...kw.params);
      }
    }
    const topicKey = params.get('topic');
    if (topicKey) {
      const tp = cfg.topics?.find((x) => x.key === topicKey);
      if (!tp) throw new HttpError(400, `unknown topic ${topicKey}`);
      const cond = topicCondition(cfg, tp);
      where.push(cond.sql);
      args.push(...cond.params);
    }
    for (const f of cfg.filters) {
      const vals = params.getAll(f.key).filter((v) => v !== '');
      if (!vals.length) continue;
      const c = col(cols, f.column);
      if (f.type === 'boolean') {
        const v = vals[0];
        if (v === 'null') where.push(`${c} IS NULL`);
        else {
          where.push(`${c} = ?`);
          args.push(v === '1' || v === 'true' ? 1 : 0);
        }
      } else {
        where.push(`${c} IN (${vals.map(() => '?').join(',')})`);
        args.push(...vals);
      }
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortParam = params.get('sort');
    const sortCol = col(cols, sortParam && cols.has(sortParam) ? sortParam : (cfg.defaultSort ?? cfg.idColumn));
    const dir = params.get('dir') === 'desc' ? 'DESC' : 'ASC';
    const total = (db.prepare(`SELECT COUNT(*) n FROM ${cfg.table} t ${w}`).get(...args) as { n: number }).n;
    const items = (
      db
        .prepare(`SELECT t.* FROM ${cfg.table} t ${w} ORDER BY t.${sortCol} ${dir}, t.${col(cols, cfg.idColumn)} LIMIT ? OFFSET ?`)
        .all(...args, pageSize, (page - 1) * pageSize) as Record<string, unknown>[]
    ).map((r) => parseRow(cfg, r));
    return { total, page, pageSize, items };
  } finally {
    o.db.close();
  }
}

export async function getItem(group: string, id: string): Promise<Record<string, unknown>> {
  const cfg = await loadConfig(group);
  const o = open(cfg);
  if (!o) throw new HttpError(404, 'dataset not ingested yet');
  try {
    const row = o.db.prepare(`SELECT * FROM ${cfg.table} WHERE ${col(o.cols, cfg.idColumn)} = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new HttpError(404, `no item ${id}`);
    return parseRow(cfg, row);
  } finally {
    o.db.close();
  }
}
