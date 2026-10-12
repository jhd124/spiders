/**
 * Versioned SQL migrations for CAREER (CAREER/migrations/NNN_name.sql, applied in order).
 * Applied versions are recorded in `schema_migrations`; re-running is a no-op (idempotent).
 * Runs automatically on web server start, and via `npm run career:migrate`.
 * The SQL itself is kept Postgres-portable; this runner is SQLite-only for now.
 */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { isMain } from '../lib/main.js';
import { CAREER_DB } from './db.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function migrate(dbPath = CAREER_DB, log: (s: string) => void = console.log): string[] {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const done = new Map(
      (db.prepare('SELECT version, checksum FROM schema_migrations').all() as { version: string; checksum: string }[]).map((r) => [
        r.version,
        r.checksum,
      ]),
    );
    const applied: string[] = [];
    for (const f of readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()) {
      const version = f.slice(0, 3);
      const sql = readFileSync(join(DIR, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      if (done.has(version)) {
        if (done.get(version) !== sum) log(`[migrate] WARNING ${f} changed after it was applied (never edit applied migrations; add a new one)`);
        continue;
      }
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
          version,
          f,
          sum,
          new Date().toISOString(),
        );
      })();
      applied.push(f);
      log(`[migrate] applied ${f}`);
    }
    if (!applied.length) log(`[migrate] ${dbPath} up to date`);
    return applied;
  } finally {
    db.close();
  }
}

if (isMain(import.meta.url)) migrate();
