/**
 * Crawler run logs (lib/crawllog.ts): admin only (behind nginx auth; not under /api/public).
 *   GET /api/crawl-runs?crawler=&limit=           runs, newest first
 *   GET /api/crawl-runs/:id                        summary (run.json) + failures
 *   GET /api/crawl-runs/:id/requests?offset&limit&errors=1
 *   GET /api/crawl-runs/:id/records?offset&limit&outcome=new|updated|duplicate|skipped|fetched
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { CAREER_DB } from '../../CAREER/db.js';
import { HttpError } from './runs.js';

const ro = <T>(f: (db: Database.Database) => T): T => {
  if (!existsSync(CAREER_DB)) throw new HttpError(404, 'career.db not found');
  const db = new Database(CAREER_DB, { readonly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'crawl_run'").get()) throw new HttpError(404, 'no crawl logs yet (migration 029 not applied)');
    return f(db);
  } finally { db.close(); }
};
const int = (v: string | undefined, d: number, max = 1000) => Math.min(max, Math.max(0, Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d));

export const crawlLogs = new Hono();
crawlLogs.onError((err, c) => err instanceof HttpError ? c.json({ error: err.message }, err.status) : c.json({ error: err.message }, 500));
crawlLogs.get('/', (c) => c.json(ro((db) => ({
  crawlers: (db.prepare('SELECT crawler, count(*) runs, max(started_at) last FROM crawl_run GROUP BY crawler ORDER BY crawler').all()),
  runs: db.prepare(`SELECT id, crawler, web_run_id, started_at, ended_at, duration_ms, status, requests, request_errors, pages, bytes, records, new_records, updated, duplicate, skipped, failures, error
    FROM crawl_run ${c.req.query('crawler') ? 'WHERE crawler = ?' : ''} ORDER BY started_at DESC LIMIT ?`).all(...(c.req.query('crawler') ? [c.req.query('crawler')] : []), int(c.req.query('limit'), 100)),
}))));

const runOr404 = (db: Database.Database, id: string) => {
  const r = db.prepare('SELECT * FROM crawl_run WHERE id = ?').get(id) as { summary_json: string; dir: string } | undefined;
  if (!r) throw new HttpError(404, `no crawl run ${id}`);
  return r;
};
crawlLogs.get('/:id', (c) => c.json(ro((db) => {
  const r = runOr404(db, c.req.param('id'));
  return { ...JSON.parse(r.summary_json), files_present: existsSync(join(r.dir, 'records.jsonl')) || existsSync(join(r.dir, 'run.json')) };
})));
crawlLogs.get('/:id/requests', (c) => c.json(ro((db) => {
  const id = c.req.param('id'); runOr404(db, id);
  const where = c.req.query('errors') ? 'AND (error IS NOT NULL OR status >= 400)' : '';
  return {
    total: (db.prepare(`SELECT count(*) n FROM crawl_request WHERE run_id = ? ${where}`).get(id) as { n: number }).n,
    rows: db.prepare(`SELECT seq, at, method, url, keyword, page, status, bytes, elapsed_ms, attempt, error FROM crawl_request WHERE run_id = ? ${where} ORDER BY seq LIMIT ? OFFSET ?`)
      .all(id, int(c.req.query('limit'), 100), int(c.req.query('offset'), 0, 1e9)),
  };
})));
crawlLogs.get('/:id/records', async (c) => {
  const dir = ro((db) => runOr404(db, c.req.param('id')).dir);
  const file = join(dir, 'records.jsonl');
  if (!existsSync(file)) return c.json({ total: 0, rows: [], pruned: true });
  const offset = int(c.req.query('offset'), 0, 1e9), limit = int(c.req.query('limit'), 20, 200), outcome = c.req.query('outcome');
  const rows: unknown[] = [];
  let total = 0;
  for await (const line of createInterface({ input: createReadStream(file, 'utf8') })) {
    if (!line) continue;
    if (outcome && !line.includes(`"outcome":"${outcome}"`)) continue;
    if (total >= offset && rows.length < limit) rows.push(JSON.parse(line));
    total++;
  }
  return c.json({ total, rows, pruned: false });
});
