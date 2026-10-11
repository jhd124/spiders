/**
 * 入库脚本：读取 data/clean/<school>.json，校验后 upsert 到数据库。
 * Ingest cleaned course JSON into a database (SQLite by default: data/courses.db).
 *
 *   npm run ingest                 # all schools that have cleaned output
 *   npm run ingest -- yale brown   # only some schools
 *   SPIDERS_DB=/path/to/x.db npm run ingest
 *
 * To use another database implement `CourseStore` (e.g. PostgresStore) and return it from `openStore()`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { ARRAY_FIELDS, COURSE_COLUMNS, SCHOOLS, validateCourse, type Course, type SchoolKey } from './schema.js';
import { CLEAN_DIR, DATA_DIR, cleanPath, readJson } from '../lib/io.js';
import { isMain } from '../lib/main.js';

export interface CourseStore {
  init(): void | Promise<void>;
  /** Insert or update by primary key `id`; returns number of rows written. */
  upsert(courses: Course[]): number | Promise<number>;
  close(): void | Promise<void>;
}

const SQL_TYPE = { TEXT: 'TEXT', INTEGER: 'INTEGER', REAL: 'REAL', JSON: 'TEXT', BOOLEAN: 'INTEGER' } as const;
const COLS = Object.keys(COURSE_COLUMNS) as (keyof Course)[];
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/** SQLite implementation. Table + columns are derived from COURSE_COLUMNS in schema.ts. */
export class SqliteStore implements CourseStore {
  private db: Database.Database;
  constructor(path: string, private table = 'courses') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
  }

  init(): void {
    const defs = COLS.map((c) => `${snake(c)} ${SQL_TYPE[COURSE_COLUMNS[c]]}${c === 'id' ? ' PRIMARY KEY' : ''}`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (\n  ${defs.join(',\n  ')},\n  ingested_at TEXT NOT NULL\n)`);
    // add columns that were introduced to the schema after the table was created
    const existing = new Set((this.db.prepare(`PRAGMA table_info(${this.table})`).all() as { name: string }[]).map((r) => r.name));
    for (const c of COLS) {
      if (!existing.has(snake(c))) this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN ${snake(c)} ${SQL_TYPE[COURSE_COLUMNS[c]]}`);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${this.table}_school_url ON ${this.table}(school, url)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${this.table}_platform ON ${this.table}(platform)`);
  }

  upsert(courses: Course[]): number {
    const cols = COLS.map(snake);
    const stmt = this.db.prepare(
      `INSERT INTO ${this.table} (${cols.join(', ')}, ingested_at) VALUES (${cols.map((c) => '@' + c).join(', ')}, @ingested_at)
       ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}, ingested_at = excluded.ingested_at`,
    );
    const delByUrl = this.db.prepare(`DELETE FROM ${this.table} WHERE school = ? AND url = ? AND id <> ?`);
    const now = new Date().toISOString();
    const tx = this.db.transaction((rows: Course[]) => {
      for (const c of rows) {
        delByUrl.run(c.school, c.url, c.id); // keep (school,url) unique if a source changed its id
        const row: Record<string, unknown> = { ingested_at: now };
        for (const k of COLS) {
          const v = c[k];
          row[snake(k)] = (ARRAY_FIELDS as readonly string[]).includes(k)
            ? JSON.stringify(v)
            : typeof v === 'boolean'
              ? Number(v)
              : (v ?? null);
        }
        stmt.run(row);
      }
      return rows.length;
    });
    return tx(courses);
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(): CourseStore {
  return new SqliteStore(process.env.SPIDERS_DB ?? join(DATA_DIR, 'courses.db'));
}

export async function ingest(schools: SchoolKey[]): Promise<void> {
  const store = openStore();
  await store.init();
  let total = 0;
  try {
    for (const school of schools) {
      const path = cleanPath(school);
      if (!existsSync(path)) {
        console.warn(`[ingest] ${school}: no cleaned file (${path}), skipping`);
        continue;
      }
      const courses = await readJson<unknown[]>(path);
      const valid = courses.filter((c): c is Course => {
        const errs = validateCourse(c);
        if (errs.length) console.warn(`[ingest] ${school}: skip invalid record: ${errs.join('; ')}`);
        return errs.length === 0;
      });
      const n = await store.upsert(valid);
      total += n;
      console.log(`[ingest] ${school}: upserted ${n}`);
    }
  } finally {
    await store.close();
  }
  console.log(`[ingest] done, ${total} rows`);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const all = existsSync(CLEAN_DIR)
    ? readdirSync(CLEAN_DIR).map((f) => f.replace(/\.json$/, '')).filter((s): s is SchoolKey => s in SCHOOLS)
    : [];
  const bad = args.filter((a) => !(a in SCHOOLS));
  if (bad.length) throw new Error(`unknown school(s): ${bad.join(', ')}; known: ${Object.keys(SCHOOLS).join(', ')}`);
  await ingest(args.length ? (args as SchoolKey[]) : all);
}
