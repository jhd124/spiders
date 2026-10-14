/**
 * salary_stat aggregator: quarterly p25/p50/p75 of monthly pay per occupation × city (TARGET_CITIES + '全国')
 * × channel ('全部' = 社招+校招, plus each channel incl. 实习) × education ('全部' + each level).
 * A row is written only when sample_size >= MIN_SAMPLE (default 5, env JOBS_MIN_SAMPLE). Quarters present in
 * job_posting are recomputed from scratch (delete + insert), so the table always mirrors the postings.
 * Run: npm run jobs:stats
 */
import Database from 'better-sqlite3';
import { CAREER_DB } from '../CAREER/db.js';
import { migrate } from '../CAREER/migrate.js';
import { isMain } from '../lib/main.js';
import { STAT_METHOD, quarterOf, statMonthly } from './normalize.js';
import { TARGET_CITIES } from './occupations.js';

export const MIN_SAMPLE = Number(process.env.JOBS_MIN_SAMPLE ?? 5);

/** linear-interpolated percentile (same as numpy default) */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export function computeSalaryStats(db: Database.Database, opts: { minSample?: number; log?: (s: string) => void } = {}) {
  const min = opts.minSample ?? MIN_SAMPLE;
  const log = opts.log ?? console.log;
  // one row per dedupe_key (reposts / same job found by several keywords or sites count once; latest fetch wins)
  const rows = db.prepare(`SELECT occupation_code occ, city, channel, education, salary_min_month mn, salary_max_month mx, salary_months months,
        coalesce(published_at, fetched_at) d
      FROM job_posting p
      WHERE occupation_code IS NOT NULL AND (salary_min_month IS NOT NULL OR salary_max_month IS NOT NULL)
        AND fetched_at = (SELECT max(fetched_at) FROM job_posting q WHERE q.dedupe_key = p.dedupe_key)
      GROUP BY dedupe_key`).all() as { occ: string; city: string | null; channel: string | null; education: string | null; mn: number | null; mx: number | null; months: number | null; d: string }[];
  const groups = new Map<string, number[]>();
  const add = (k: string, v: number) => { let a = groups.get(k); if (!a) groups.set(k, (a = [])); a.push(v); };
  const quarters = new Set<string>();
  for (const r of rows) {
    const v = statMonthly(r.mn, r.mx, r.months);
    const q = quarterOf(r.d);
    if (v == null || !q) continue;
    quarters.add(q);
    const cities = ['全国', ...(r.city && TARGET_CITIES.includes(r.city) ? [r.city] : [])];
    const channels = [r.channel ?? '社招', ...(r.channel === '实习' ? [] : ['全部'])];
    const edus = ['全部', ...(r.education ? [r.education] : [])];
    for (const c of cities) for (const ch of channels) for (const e of edus) add([r.occ, c, q, ch, e].join('\t'), v);
  }
  const now = new Date().toISOString();
  const del = db.prepare('DELETE FROM salary_stat WHERE quarter = ?');
  const ins = db.prepare(`INSERT INTO salary_stat (occupation_code, city, quarter, channel, education, sample_size, p25_month, p50_month, p75_month, method_note, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let written = 0, skipped = 0;
  db.transaction(() => {
    for (const q of quarters) del.run(q);
    for (const [k, vals] of groups) {
      if (vals.length < min) { skipped++; continue; }
      const [occ, city, q, ch, e] = k.split('\t') as [string, string, string, string, string];
      const s = [...vals].sort((a, b) => a - b);
      const r = (p: number) => Math.round(percentile(s, p));
      ins.run(occ, city, q, ch, e, s.length, r(0.25), r(0.5), r(0.75), `${STAT_METHOD}; min sample ${min}`, now);
      written++;
    }
  })();
  log(`[jobs] salary_stat: ${written} rows written (${[...quarters].sort().join(',') || '-'}), ${skipped} groups below min sample ${min}; ${rows.length} distinct salaried postings`);
  return { written, skipped, postings: rows.length };
}

if (isMain(import.meta.url)) {
  migrate();
  const db = new Database(CAREER_DB);
  try { computeSalaryStats(db); } finally { db.close(); }
}
