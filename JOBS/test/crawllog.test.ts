/** lib/crawllog.ts: run record, request log via lib/http, record outcomes, failures, files, DB index, retention, admin API. No network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'crawllog-'));
process.env.SPIDERS_DATA_DIR = TMP;
process.env.CAREER_DB = join(TMP, 'career.db');
process.env.SPIDERS_DELAY_MS = '0';
process.env.SPIDERS_CRAWL_RECORDS_CAP = '3';

// mock network: robots.txt 404, /ok 200, /flaky 503 then 200, /gone 404; upc search returns 2 postings
let flaky = 0;
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
  if (url.includes('/ok')) return new Response('hello', { status: 200 });
  if (url.includes('/flaky')) return flaky++ === 0 ? new Response('busy', { status: 503, headers: { 'retry-after': '0.001' } }) : new Response('fine!', { status: 200 });
  if (url.includes('/gone')) return new Response('x', { status: 404 });
  if (url.includes('/zwxx/search/')) return new Response(JSON.stringify({ code: 200, data: { total: 2, list: [
    { zwid: 'A1', zwmc: '嵌入式软件工程师', dwmc: '甲公司', lxdh: '13800000000' }, { zwid: 'A2', zwmc: '电气工程师', dwmc: '乙公司' }] } }), { status: 200 });
  throw new Error(`unexpected ${url}`);
}) as typeof fetch;

const { withCrawlRun, setRunSink, pruneRunDirs, CRAWL_LOG_DIR } = await import('../../lib/crawllog.js');
const { politeFetch } = await import('../../lib/http.js');
const { indexRun } = await import('../../lib/crawllog_db.js');
const Database = (await import('better-sqlite3')).default;

test('a run logs every request attempt (status, bytes, keyword/page, retry, error), records with outcomes, failures, summary files', async () => {
  const sunk: unknown[] = [];
  setRunSink((s, reqs) => { sunk.push({ s, reqs }); });
  const s = await withCrawlRun('unit', async (run) => {
    await politeFetch('https://example.test/ok', { delayMs: 0, log: { keyword: 'Java', page: 1 } });
    await politeFetch('https://example.test/flaky', { delayMs: 0, retries: 1 });
    await assert.rejects(politeFetch('https://example.test/gone', { delayMs: 0 }), /HTTP 404/);
    run.fail('page 3 gone', { page: 3 });
    run.record({ id: 1 }, 'new', { key: '1' }); run.record({ id: 2 }, 'duplicate'); run.record({ id: 3 }, 'updated'); run.record({ id: 4 }, 'skipped');
    return run.summary;
  });
  assert.equal(s.status, 'partial');
  assert.equal(s.requests, 4); assert.equal(s.retries, 1); assert.equal(s.request_errors, 2); assert.equal(s.pages, 2); assert.equal(s.bytes, 10);
  assert.deepEqual(s.outcomes, { new: 1, updated: 1, duplicate: 1, skipped: 1, fetched: 0 });
  assert.equal(s.records_saved, 3); assert.equal(s.records_truncated, true, 'snapshot capped, counts exact');
  const reqs = readFileSync(join(s.dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(reqs.map((r) => [r.url.replace('https://example.test', ''), r.status, r.attempt, r.keyword, r.page]),
    [['/ok', 200, 0, 'Java', 1], ['/flaky', 503, 0, null, null], ['/flaky', 200, 1, null, null], ['/gone', 404, 0, null, null]]);
  assert.equal(reqs[3].error, 'HTTP 404');
  const run = JSON.parse(readFileSync(join(s.dir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'partial'); assert.equal(run.failures[0].reason, 'page 3 gone'); assert.ok(run.duration_ms >= 0);
  assert.equal(readFileSync(join(s.dir, 'records.jsonl'), 'utf8').trim().split('\n').length, 3);
  assert.equal(sunk.length, 1);
});

test('a crawl that throws is recorded as failed and the error is kept', async () => {
  setRunSink(() => {});
  let dir = '';
  await assert.rejects(withCrawlRun('unit', async (run) => { dir = run.summary.dir; throw new Error('boom'); }), /boom/);
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'failed'); assert.equal(run.error, 'boom');
});

test('JOBS upc crawler: keyword/page on requests, new vs duplicate postings, contact fields not in the snapshot', async () => {
  const runs: any[] = [];
  setRunSink((s) => { runs.push(s); });
  const { crawl } = await import('../upc/crawler.js');
  await crawl({ keywords: ['电气'], maxPages: 1, fresh: true });
  await crawl({ keywords: ['电气'], maxPages: 1, fresh: false }); // pages cached: no request
  const [a] = runs;
  assert.equal(a.crawler, 'jobs-upc'); assert.equal(a.status, 'success');
  assert.deepEqual(a.outcomes, { new: 2, updated: 0, duplicate: 0, skipped: 0, fetched: 0 });
  const req = JSON.parse(readFileSync(join(a.dir!, 'requests.jsonl'), 'utf8').trim().split('\n')[0]!);
  assert.equal(req.method, 'POST'); assert.equal(req.keyword, '电气'); assert.equal(req.page, 1); assert.equal(req.status, 200);
  const rec = readFileSync(join(a.dir!, 'records.jsonl'), 'utf8');
  assert.match(rec, /"key":"A1"/); assert.doesNotMatch(rec, /13800000000/);
  assert.equal(runs[1].requests, 0);
});

test('DB index (migration 029) + retention: newest N runs kept, dirs pruned; admin API lists runs, requests, records', async () => {
  let n = 0;
  setRunSink((s, reqs) => indexRun(s, reqs, process.env.CAREER_DB!, 2));
  for (let i = 0; i < 3; i++) await withCrawlRun('keep', async (run) => { await politeFetch('https://example.test/ok', { delayMs: 0 }); run.record({ i }, 'new', { key: String(i) }); n++; });
  const db = new Database(process.env.CAREER_DB!, { readonly: true });
  const rows = db.prepare("SELECT id, requests, new_records FROM crawl_run WHERE crawler = 'keep' ORDER BY started_at").all() as { id: string; requests: number; new_records: number }[];
  assert.equal(rows.length, 2, 'DB keeps the newest 2');
  assert.equal((db.prepare('SELECT count(*) n FROM crawl_request WHERE run_id NOT IN (SELECT id FROM crawl_run)').get() as { n: number }).n, 0);
  db.close();
  assert.equal(pruneRunDirs('keep', 2).length, 1, 'oldest of 3 dirs dropped');
  pruneRunDirs('keep', 1);
  assert.equal(readdirSync(join(CRAWL_LOG_DIR(), 'keep')).length, 1);

  const { crawlLogs } = await import('../../web/server/crawllogs.js');
  const list = await (await crawlLogs.request('/?crawler=keep')).json() as any;
  assert.equal(list.runs.length, 2);
  const last = list.runs[0].id;
  const det = await (await crawlLogs.request(`/${last}`)).json() as any;
  assert.equal(det.outcomes.new, 1);
  const rq = await (await crawlLogs.request(`/${last}/requests`)).json() as any;
  assert.equal(rq.total, 1); assert.equal(rq.rows[0].status, 200);
  const rc = await (await crawlLogs.request(`/${last}/records`)).json() as any;
  assert.equal(rc.total, 1); assert.equal(rc.rows[0].outcome, 'new');
  const older = list.runs[1].id; // its dir was pruned above: records reported as pruned, summary still in DB
  assert.equal((await (await crawlLogs.request(`/${older}/records`)).json() as any).pruned, true);
  assert.equal((await crawlLogs.request('/nope')).status, 404);
  assert.ok(existsSync(TMP));
});
