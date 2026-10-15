/**
 * Uniform crawler run log (boss 2026-10-15: "crawlers should have logs, including the data fetched and how each crawl went").
 *
 *   await withCrawlRun('jobs-upc', async (run) => { ... run.record(rec, 'new', { key }) ... run.fail('reason', ctx) ... });
 *
 * Per run: id, crawler, start/end, duration, status (success | partial = finished with failures | failed = threw).
 * Per request: lib/http.ts reports every attempt to the active run (url, method, keyword/page from opts.log, HTTP status,
 *   bytes, elapsed, attempt/retry, error). Per record: outcome new | updated | duplicate | skipped | fetched (+ the record).
 * Files: data/logs/crawl/<crawler>/<run_id>/run.json (summary), requests.jsonl, records.jsonl (raw snapshot, capped at
 *   SPIDERS_CRAWL_RECORDS_CAP records per run, default 2000; counts stay exact). DB (career.db, migration 029): crawl_run,
 *   crawl_request, crawl_failure. Retention: the newest SPIDERS_CRAWL_KEEP runs per crawler (default 30); older dirs + rows are deleted.
 * Logging never breaks a crawl: write errors are reported to stderr and ignored.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DATA_DIR } from './io.js';

export const CRAWL_LOG_DIR = () => join(process.env.SPIDERS_DATA_DIR ?? DATA_DIR, 'logs', 'crawl');
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const RECORDS_CAP = () => num(process.env.SPIDERS_CRAWL_RECORDS_CAP, 2000);
export const KEEP_RUNS = () => num(process.env.SPIDERS_CRAWL_KEEP, 30);

export type RecordOutcome = 'new' | 'updated' | 'duplicate' | 'skipped' | 'fetched';
export type RunStatus = 'running' | 'success' | 'partial' | 'failed';
export interface RequestLog { seq: number; at: string; method: string; url: string; keyword?: string | null; page?: number | null; status: number | null; bytes: number | null; elapsed_ms: number; attempt: number; error?: string | null }
export interface FailureLog { seq: number; at: string; reason: string; context?: Record<string, unknown> }
export interface RunSummary {
  id: string; crawler: string; web_run_id: number | null; started_at: string; ended_at: string | null; duration_ms: number | null; status: RunStatus;
  requests: number; request_errors: number; retries: number; pages: number; bytes: number;
  records: number; outcomes: Record<RecordOutcome, number>; records_saved: number; records_truncated: boolean;
  failures: FailureLog[]; error: string | null; dir: string; extra: Record<string, unknown>;
}
/** request metadata a crawler passes through politeFetch(opts.log) */
export interface RequestMeta { keyword?: string; page?: number }

const safe = (f: () => void) => { try { f(); } catch (e) { console.error(`[crawllog] ${e instanceof Error ? e.message : e}`); } };
const sanitize = (s: string) => s.replace(/[^\w.-]+/g, '_');

export class CrawlRun {
  readonly summary: RunSummary;
  private reqSeq = 0;
  private reqFile: string; private recFile: string;
  readonly requests: RequestLog[] = [];

  constructor(crawler: string, now = new Date()) {
    const id = `${now.toISOString().replace(/[-:]/g, '')}-${randomBytes(2).toString('hex')}`;
    const dir = join(CRAWL_LOG_DIR(), sanitize(crawler), id);
    this.summary = { id, crawler, web_run_id: process.env.SPIDERS_WEB_RUN_ID ? Number(process.env.SPIDERS_WEB_RUN_ID) : null, started_at: now.toISOString(), ended_at: null, duration_ms: null,
      status: 'running', requests: 0, request_errors: 0, retries: 0, pages: 0, bytes: 0, records: 0,
      outcomes: { new: 0, updated: 0, duplicate: 0, skipped: 0, fetched: 0 }, records_saved: 0, records_truncated: false, failures: [], error: null, dir, extra: {} };
    this.reqFile = join(dir, 'requests.jsonl'); this.recFile = join(dir, 'records.jsonl');
    safe(() => { mkdirSync(dir, { recursive: true }); this.writeRun(); });
  }

  /** called by lib/http for every attempt */
  request(r: Omit<RequestLog, 'seq' | 'at'>) {
    const row: RequestLog = { seq: ++this.reqSeq, at: new Date().toISOString(), ...r };
    const s = this.summary;
    s.requests++;
    if (r.attempt > 0) s.retries++;
    if (r.error || (r.status != null && r.status >= 400)) s.request_errors++;
    else s.pages++;
    s.bytes += r.bytes ?? 0;
    this.requests.push(row);
    safe(() => appendFileSync(this.reqFile, JSON.stringify(row) + '\n'));
  }

  /** one fetched record and what happened to it */
  record(data: unknown, outcome: RecordOutcome = 'fetched', meta: Record<string, unknown> = {}) {
    const s = this.summary;
    s.records++; s.outcomes[outcome]++;
    if (s.records_saved >= RECORDS_CAP()) { s.records_truncated = true; return; }
    s.records_saved++;
    safe(() => appendFileSync(this.recFile, JSON.stringify({ n: s.records, outcome, ...meta, data }) + '\n'));
  }

  /** a failure the crawl recovered from (failed page, document, source) */
  fail(reason: string, context: Record<string, unknown> = {}) {
    this.summary.failures.push({ seq: this.summary.failures.length + 1, at: new Date().toISOString(), reason, context });
    safe(() => this.writeRun());
  }

  /** free-form numbers for the summary (e.g. gated pages) */
  note(key: string, value: unknown) { this.summary.extra[key] = value; }

  finish(error?: unknown): RunSummary {
    const s = this.summary;
    s.ended_at = new Date().toISOString();
    s.duration_ms = Date.parse(s.ended_at) - Date.parse(s.started_at);
    s.error = error == null ? null : error instanceof Error ? error.message : String(error);
    s.status = error != null ? 'failed' : s.failures.length ? 'partial' : 'success';
    safe(() => this.writeRun());
    const o = s.outcomes;
    console.log(`[crawllog] ${s.crawler} run ${s.id}: ${s.status}, ${s.requests} requests (${s.request_errors} errors, ${s.retries} retries), ${s.records} records (new ${o.new}, updated ${o.updated}, duplicate ${o.duplicate}, skipped ${o.skipped}, fetched ${o.fetched}), ${s.failures.length} failures, ${Math.round((s.duration_ms ?? 0) / 1000)}s -> ${s.dir}`);
    return s;
  }

  private writeRun() { writeFileSync(join(this.summary.dir, 'run.json'), JSON.stringify(this.summary, null, 2) + '\n'); }
}

let active: CrawlRun | null = null;
/** the run lib/http reports requests to (one crawler per process; nested withCrawlRun reuses the outer run) */
export const activeRun = () => active;

export type RunSink = (s: RunSummary, requests: RequestLog[]) => void | Promise<void>;
/** default sink: index the run in career.db (migration 029) and prune old runs. Tests replace it. */
let sink: RunSink = async (s, reqs) => {
  const { indexRun } = await import('./crawllog_db.js');
  indexRun(s, reqs);
};
export const setRunSink = (f: RunSink) => { sink = f; };

export async function withCrawlRun<T>(crawler: string, fn: (run: CrawlRun) => Promise<T>): Promise<T> {
  if (active) return fn(active);
  const run = new CrawlRun(crawler);
  active = run;
  let err: unknown = undefined, out: T;
  try {
    out = await fn(run);
    return out;
  } catch (e) {
    err = e ?? new Error('crawl failed');
    throw e;
  } finally {
    active = null;
    const s = run.finish(err);
    try { await sink(s, run.requests); } catch (e) { console.error(`[crawllog] index failed: ${e instanceof Error ? e.message : e}`); }
    safe(() => pruneRunDirs(crawler));
  }
}

/** keep the newest KEEP_RUNS run dirs of a crawler (run ids sort by time) */
export function pruneRunDirs(crawler: string, keep = KEEP_RUNS()): string[] {
  const root = join(CRAWL_LOG_DIR(), sanitize(crawler));
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root).sort();
  const drop = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const d of drop) rmSync(join(root, d), { recursive: true, force: true });
  return drop;
}
