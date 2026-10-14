/**
 * salary_stat aggregator (expert rules 2026-10-14).
 *  - Salary window: only postings published in the last JOBS_SALARY_MONTHS months (default 24), counted from the start
 *    of the quarter that contains (run date − 24 months); run on 2026-10-14 -> since 2024-10-01 (2024Q4).
 *    JOBS_SALARY_SINCE=YYYY-MM-DD fixes the cutoff instead. Date = published_at (fetched_at when missing).
 *  - Excluded: 面议 / daily / hourly pay (no monthly figure), multi-role titles, unclassified postings, reposts (dedupe_key).
 *  - Rows: per occupation × city (TARGET_CITIES + '全国') × channel ('全部' + each) × education ('全部' + each), for
 *      quarter '2026Q3' (each quarter inside the window) and quarter '<from>-<to>' (the whole window, e.g. '2024Q4-2026Q4').
 *    The default display is the window row at city '全国', channel '全部' -> occupation × education (view salary_overview).
 *  - Cells with sample_size < JOBS_MIN_SAMPLE (default 30) keep the count only; p25/p50/p75 are NULL.
 *  - The table is rebuilt from scratch on every run, so it mirrors postings + current rules.
 * Run: npm run jobs:stats
 */
import Database from 'better-sqlite3';
import { CAREER_DB } from '../CAREER/db.js';
import { migrate } from '../CAREER/migrate.js';
import { isMain } from '../lib/main.js';
import { STAT_METHOD, quarterOf, statMonthly } from './normalize.js';
import { TARGET_CITIES } from './occupations.js';

export const MIN_SAMPLE = Number(process.env.JOBS_MIN_SAMPLE ?? 30);
export const SALARY_MONTHS = Number(process.env.JOBS_SALARY_MONTHS ?? 24);

/** linear-interpolated percentile (same as numpy default) */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/** cutoff date (inclusive, YYYY-MM-DD): fixed `since`, else start of the quarter containing (now − months) */
export function salaryWindowStart(now: Date = new Date(), months = SALARY_MONTHS, since = process.env.JOBS_SALARY_SINCE): string {
  if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) return since;
  const y = now.getFullYear(), m = now.getMonth() - months; // month index may go negative
  const d = new Date(y, m, 1);
  const qm = Math.floor(d.getMonth() / 3) * 3 + 1;
  return `${d.getFullYear()}-${String(qm).padStart(2, '0')}-01`;
}

export function computeSalaryStats(db: Database.Database, opts: { minSample?: number; since?: string; now?: Date; log?: (s: string) => void } = {}) {
  const min = opts.minSample ?? MIN_SAMPLE;
  const log = opts.log ?? console.log;
  const now = opts.now ?? new Date();
  const since = opts.since ?? salaryWindowStart(now);
  const winLabel = `${quarterOf(since)}-${quarterOf(now.toISOString().slice(0, 10))}`;
  // one row per dedupe_key (reposts / same job found by several keywords or sites count once; latest fetch wins)
  const rows = db.prepare(`SELECT occupation_code occ, city, channel, education, salary_min_month mn, salary_max_month mx, salary_months months,
        coalesce(published_at, fetched_at) d
      FROM job_posting p
      WHERE occupation_code IS NOT NULL AND multi_role = 0 AND (salary_min_month IS NOT NULL OR salary_max_month IS NOT NULL)
        AND coalesce(salary_note, '') <> '面议' AND coalesce(salary_raw, '') NOT LIKE '%面议%'
        AND fetched_at = (SELECT max(fetched_at) FROM job_posting q WHERE q.dedupe_key = p.dedupe_key)
      GROUP BY dedupe_key`).all() as { occ: string; city: string | null; channel: string | null; education: string | null; mn: number | null; mx: number | null; months: number | null; d: string }[];
  const groups = new Map<string, number[]>();
  const add = (k: string, v: number) => { let a = groups.get(k); if (!a) groups.set(k, (a = [])); a.push(v); };
  let inWindow = 0, outside = 0;
  for (const r of rows) {
    const v = statMonthly(r.mn, r.mx, r.months);
    const q = quarterOf(r.d);
    if (v == null || !q) continue;
    if (r.d.slice(0, 10) < since) { outside++; continue; }
    inWindow++;
    const cities = ['全国', ...(r.city && TARGET_CITIES.includes(r.city) ? [r.city] : [])];
    const channels = [r.channel ?? '社招', ...(r.channel === '实习' ? [] : ['全部'])];
    const edus = ['全部', ...(r.education ? [r.education] : [])];
    for (const per of [q, winLabel]) for (const c of cities) for (const ch of channels) for (const e of edus) add([r.occ, c, per, ch, e].join('\t'), v);
  }
  const computed = new Date().toISOString();
  const note = `${STAT_METHOD}; window ${since}..${now.toISOString().slice(0, 10)} (${winLabel}); multi-role titles excluded; min sample ${min} (below: count only)`;
  const ins = db.prepare(`INSERT INTO salary_stat (occupation_code, city, quarter, channel, education, sample_size, p25_month, p50_month, p75_month, method_note, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let written = 0, countOnly = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM salary_stat').run();
    for (const [k, vals] of groups) {
      const [occ, city, q, ch, e] = k.split('\t') as [string, string, string, string, string];
      if (vals.length < min) {
        ins.run(occ, city, q, ch, e, vals.length, null, null, null, note, computed);
        countOnly++;
      } else {
        const s = [...vals].sort((a, b) => a - b);
        const r = (p: number) => Math.round(percentile(s, p));
        ins.run(occ, city, q, ch, e, s.length, r(0.25), r(0.5), r(0.75), note, computed);
      }
      written++;
    }
  })();
  log(`[jobs] salary_stat: ${written} rows (${written - countOnly} with percentiles, ${countOnly} count-only < ${min}); window ${winLabel} from ${since}: ${inWindow} postings in, ${outside} older skipped`);
  return { written, countOnly, withPercentiles: written - countOnly, inWindow, outside, window: winLabel, since, postings: rows.length };
}

if (isMain(import.meta.url)) {
  migrate();
  const db = new Database(CAREER_DB);
  try { computeSalaryStats(db); } finally { db.close(); }
}
