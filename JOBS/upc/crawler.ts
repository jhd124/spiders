/**
 * 中国石油大学（华东）智慧就业网 — public 职位信息 search (易就业 platform), https://career.upc.edu.cn/career/zwxx
 *
 * Why this source: no login for the listing the site shows anonymously, no captcha/signature, and every position
 * carries a monthly salary range (元/月), work location, education and the full JD. Employers are national but
 * skew to 山东 (济南/青岛) and campus hiring, so channel = 校招 unless the job is an internship.
 *
 * Politeness / limits (do NOT loosen):
 *  - exactly the request the site's own anonymous UI sends: POST /career/zwxx/search/{page}/10 with form field dwmc=<keyword>
 *    (page size 10 = the UI's). No cookies, no login.
 *  - a page answered with code 403 ("需要登录查看") is login-gated: it is logged and skipped, never retried another way.
 *  - lib/http politeFetch: honest UA, robots.txt check, >= 2 s between requests (SPIDERS_DELAY_MS can only raise it).
 *  - resumable: state in data/raw/jobs/upc.json (pages already fetched are skipped unless --fresh).
 * Flags: --max-pages=N (per keyword, default 10) --keywords=a,b --fresh --budget=N (max requests this run, default 400)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { politeFetch } from '../../lib/http.js';
import { RAW_DIR, readJson, writeJson } from '../../lib/io.js';
import { isMain } from '../../lib/main.js';
import { OCCUPATION_RULES } from '../occupations.js';

export const SITE = 'upc';
export const BASE = 'https://career.upc.edu.cn/career';
export const PAGE_SIZE = 10;
export const RAW_FILE = join(RAW_DIR, 'jobs', 'upc.json');
const DELAY_MS = Math.max(2000, Number(process.env.SPIDERS_DELAY_MS ?? 0));

/** public fields kept from a 职位 record (contact e-mails/phones are dropped on purpose) */
export const KEEP = ['zwid', 'zwmc', 'dwmc', 'gzlxmc', 'zwlbymc', 'zwlbemc', 'gzszssmc', 'gzszsmc', 'gzszxmc', 'gzdz', 'yxmc', 'zwms', 'xqrsmc', 'xlyqmc', 'zyyqmc', 'fbrq', 'hyyjmc'] as const;
export type UpcRaw = Partial<Record<(typeof KEEP)[number], string | null>> & { _keyword: string; _fetchedAt: string };

export interface UpcState {
  site: string;
  updatedAt: string;
  /** 'keyword|page' -> 'ok' | 'gated' | 'empty' */
  pages: Record<string, string>;
  postings: Record<string, UpcRaw>;
}

export function pickPublic(rec: Record<string, unknown>, keyword: string, fetchedAt: string): UpcRaw {
  const out: UpcRaw = { _keyword: keyword, _fetchedAt: fetchedAt };
  for (const k of KEEP) {
    const v = rec[k];
    out[k] = v == null ? null : String(v);
  }
  return out;
}

interface SearchResp { code: number; message?: string; data?: { total: string | number; list: Record<string, unknown>[] } }

export async function fetchPage(keyword: string, page: number): Promise<SearchResp> {
  const body = new URLSearchParams({ dwmc: keyword }).toString();
  const txt = await politeFetch(`${BASE}/zwxx/search/${page}/${PAGE_SIZE}`, {
    method: 'POST',
    body,
    delayMs: DELAY_MS,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  });
  return JSON.parse(txt) as SearchResp;
}

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

export async function crawl(opts: { keywords?: string[]; maxPages?: number; fresh?: boolean; budget?: number } = {}) {
  const keywords = opts.keywords ?? [...new Set(OCCUPATION_RULES.flatMap((r) => r.keywords))];
  const maxPages = opts.maxPages ?? 10;
  let budget = opts.budget ?? 400;
  const state: UpcState =
    !opts.fresh && existsSync(RAW_FILE) ? await readJson<UpcState>(RAW_FILE) : { site: SITE, updatedAt: '', pages: {}, postings: {} };
  let fetched = 0, gated = 0, added = 0;
  const save = async () => { state.updatedAt = new Date().toISOString(); await writeJson(RAW_FILE, state); };
  outer: for (const kw of keywords) {
    for (let page = 1; page <= maxPages; page++) {
      const key = `${kw}|${page}`;
      if (state.pages[key] === 'empty') break;
      if (state.pages[key]) continue;
      if (budget-- <= 0) { console.log('[jobs:upc] request budget reached; re-run to resume'); break outer; }
      let r: SearchResp;
      try {
        r = await fetchPage(kw, page);
      } catch (e) {
        console.error(`[jobs:upc] ${kw} p${page} failed: ${e instanceof Error ? e.message : e}`);
        break;
      }
      fetched++;
      if (r.code === 403) { state.pages[key] = 'gated'; gated++; console.log(`[jobs:upc] ${kw} p${page}: login-gated, skipped`); continue; }
      if (r.code !== 200 || !r.data) { console.error(`[jobs:upc] ${kw} p${page}: code ${r.code} ${r.message ?? ''}`); break; }
      const now = new Date().toISOString();
      for (const rec of r.data.list) {
        const p = pickPublic(rec, kw, now);
        if (!p.zwid) continue;
        if (!state.postings[p.zwid]) added++;
        state.postings[p.zwid] = { ...p, _keyword: state.postings[p.zwid]?._keyword ?? kw };
      }
      const total = Number(r.data.total) || 0;
      state.pages[key] = r.data.list.length ? 'ok' : 'empty';
      console.log(`[jobs:upc] ${kw} p${page}/${Math.ceil(total / PAGE_SIZE)}: ${r.data.list.length} rows (total ${total})`);
      await save();
      if (!r.data.list.length || page * PAGE_SIZE >= total) { state.pages[`${kw}|${page + 1}`] = 'empty'; break; }
    }
  }
  await save();
  console.log(`[jobs:upc] requests=${fetched} gated=${gated} new=${added} stored=${Object.keys(state.postings).length} -> ${RAW_FILE}`);
  return state;
}

if (isMain(import.meta.url)) {
  const kws = arg('keywords')?.split(',').filter(Boolean);
  await crawl({
    keywords: kws,
    maxPages: arg('max-pages') ? Number(arg('max-pages')) : undefined,
    budget: arg('budget') ? Number(arg('budget')) : undefined,
    fresh: process.argv.includes('--fresh'),
  });
}
