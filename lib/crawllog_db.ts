/** DB index for lib/crawllog.ts runs (career.db, CAREER migration 029). Separate module so the crawler hot path stays file-only. */
import Database from 'better-sqlite3';
import { CAREER_DB } from '../CAREER/db.js';
import { migrate } from '../CAREER/migrate.js';
import { KEEP_RUNS, type RequestLog, type RunSummary } from './crawllog.js';

export function indexRun(s: RunSummary, reqs: RequestLog[], dbPath = process.env.CAREER_DB ?? CAREER_DB, keep = KEEP_RUNS()) {
  migrate(dbPath, () => {});
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  try {
    db.transaction(() => {
      const o = s.outcomes;
      db.prepare(`INSERT OR REPLACE INTO crawl_run (id, crawler, web_run_id, started_at, ended_at, duration_ms, status, requests, request_errors, pages, bytes, records,
          new_records, updated, duplicate, skipped, failures, error, dir, summary_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(s.id, s.crawler, s.web_run_id, s.started_at, s.ended_at, s.duration_ms, s.status, s.requests, s.request_errors, s.pages, s.bytes, s.records,
          o.new, o.updated, o.duplicate, o.skipped, s.failures.length, s.error, s.dir, JSON.stringify(s));
      const rq = db.prepare(`INSERT OR REPLACE INTO crawl_request (run_id, seq, at, method, url, keyword, page, status, bytes, elapsed_ms, attempt, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of reqs) rq.run(s.id, r.seq, r.at, r.method, r.url, r.keyword ?? null, r.page ?? null, r.status, r.bytes, r.elapsed_ms, r.attempt, r.error ?? null);
      const fl = db.prepare(`INSERT OR REPLACE INTO crawl_failure (run_id, seq, at, reason, context_json) VALUES (?,?,?,?,?)`);
      for (const f of s.failures) fl.run(s.id, f.seq, f.at, f.reason, JSON.stringify(f.context ?? {}));
      const old = db.prepare(`SELECT id FROM crawl_run WHERE crawler = ? ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?`).all(s.crawler, keep) as { id: string }[];
      for (const r of old) {
        db.prepare('DELETE FROM crawl_request WHERE run_id = ?').run(r.id);
        db.prepare('DELETE FROM crawl_failure WHERE run_id = ?').run(r.id);
        db.prepare('DELETE FROM crawl_run WHERE id = ?').run(r.id);
      }
    })();
  } finally { db.close(); }
}
