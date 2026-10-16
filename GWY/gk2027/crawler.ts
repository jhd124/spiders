/**
 * 国考 2027年度 职位表 (招考简章.zip from http://bm.scs.gov.cn/kl2027 → 相关下载).
 * Input: --file=<zip|xlsx|xls>, else data/civil-service/gk2027_zhaokaojianzhang.zip, else one polite attempt at the
 * official 专题网站 to find a .zip link (the site is not reachable from every network and its downloads are
 * rendered by JS — when that fails, put the official zip at the default path and re-run; nothing is bypassed).
 * Output: data/civil-service/gk2027_positions.json (every row, all columns verbatim) for GWY/ingest.ts.
 *   npm run crawl:gwy-gk2027 [-- --file=/path/to/招考简章.zip]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { politeFetch, politeFetchBytes } from '../../lib/http.js';
import { withCrawlRun } from '../../lib/crawllog.js';
import { isMain } from '../../lib/main.js';
import { DATA_DIR } from '../../lib/io.js';
import { GK2027, GWY_DIR } from '../sources.js';
import { positionRows, workbooksFrom, type PositionRow } from '../parse.js';

export const OUT_FILE = () => join(GWY_DIR, 'gk2027_positions.json');
export interface PositionsDump { notice_id: string; source: string; file: string; sha256: string; parsed_at: string; workbooks: string[]; skipped: string[]; rows: PositionRow[] }

/** relative paths resolve against the data dir (data/… or civil-service/…) first, then the cwd */
export function resolveInput(p: string): string {
  if (p.startsWith('/')) return p;
  for (const base of [join(DATA_DIR, '..'), DATA_DIR, process.cwd()]) if (existsSync(join(base, p))) return join(base, p);
  return resolve(p);
}

async function fetchOfficial(): Promise<{ data: Uint8Array; source: string }> {
  const html = await politeFetch(GK2027.url, { retries: 1 });
  const href = [...html.matchAll(/href=["']([^"']+\.zip)["']/gi)].map((m) => new URL(m[1]!, GK2027.url).href)[0];
  if (!href) throw new Error(`no .zip link in ${GK2027.url} (downloads are loaded by JS); put 招考简章.zip at ${GK2027.default_file}`);
  const { bytes } = await politeFetchBytes(href, { retries: 1 });
  return { data: bytes, source: href };
}

export async function crawl(argv = process.argv.slice(2)): Promise<PositionsDump> {
  return withCrawlRun('gwy-gk2027', async (run) => {
    const arg = argv.find((a) => a.startsWith('--file='))?.slice(7);
    let path = arg ? resolveInput(arg) : GK2027.default_file;
    let data: Uint8Array, source: string;
    if (existsSync(path)) { data = new Uint8Array(readFileSync(path)); source = `file:${path}`; }
    else if (arg) throw new Error(`--file not found: ${path}`);
    else {
      try { ({ data, source } = await fetchOfficial()); } catch (e) {
        const msg = `official site not usable from here: ${e instanceof Error ? e.message : String(e)}`;
        run.fail(msg, { url: GK2027.url });
        throw new Error(`${msg}\n  → download 招考简章.zip from ${GK2027.url} (相关下载) to ${GK2027.default_file} and re-run`);
      }
      mkdirSync(GWY_DIR, { recursive: true });
      writeFileSync(path, data);
    }
    const books = await workbooksFrom(basename(path), data);
    if (!books.length) throw new Error(`no .xls/.xlsx in ${path}`);
    const rows: PositionRow[] = [];
    const skipped: string[] = [];
    for (const wb of books) {
      const r = positionRows(wb);
      rows.push(...r.rows); skipped.push(...r.skipped);
      console.log(`[gwy-gk2027] ${wb.name}: ${r.rows.length} rows${r.ignored.length ? ` (ignored empty/headerless sheets: ${r.ignored.join(', ')})` : ''}`);
    }
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r.cols.dept_code}/${r.cols.position_code}`;
      run.record(r.raw, seen.has(k) ? 'duplicate' : 'fetched', { key: k, sheet: r.sheet });
      seen.add(k);
    }
    for (const s of skipped) run.fail(s);
    const dump: PositionsDump = { notice_id: GK2027.id, source, file: basename(path), sha256: createHash('sha256').update(data).digest('hex'), parsed_at: new Date().toISOString(), workbooks: books.map((b) => b.name), skipped, rows };
    mkdirSync(GWY_DIR, { recursive: true });
    writeFileSync(OUT_FILE(), JSON.stringify(dump));
    console.log(`[gwy-gk2027] ${rows.length} positions (${seen.size} unique 部门代码/职位代码) -> ${OUT_FILE()}`);
    return dump;
  });
}

if (isMain(import.meta.url)) {
  try { await crawl(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
