/**
 * JOBS ingest: data/clean/jobs-<source>.json -> career.db job_posting (upsert), then JD skill tagging, then salary_stat.
 *   tsx JOBS/ingest.ts [source...] [--retag] [--llm]
 * Called by scripts/run-group.ts JOBS with the crawlers that succeeded. Re-classifies occupation with the current
 * JOBS/occupations.ts rules on every run. --llm enables the LLM fallback (server only; needs LLM_* env).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CAREER_DB } from '../CAREER/db.js';
import { migrate } from '../CAREER/migrate.js';
import { CLEAN_DIR } from '../lib/io.js';
import { MockProvider, llmConfigured, providerFromEnv } from '../lib/llm.js';
import { isMain } from '../lib/main.js';
import { classifyTitle } from './occupations.js';
import { tagPostings } from './skills.js';
import { computeSalaryStats } from './stats.js';
import type { CleanPosting } from './types.js';

const COLS = ['id', 'site', 'channel', 'title_raw', 'company_raw', 'city_raw', 'city', 'salary_raw', 'salary_min_month', 'salary_max_month', 'salary_months', 'salary_note',
  'education_raw', 'education', 'experience_raw', 'experience_min_years', 'industry_raw', 'jd_text', 'occupation_code', 'occupation_confidence', 'search_keyword',
  'dedupe_key', 'raw_json', 'published_at', 'source_url', 'fetched_at', 'extraction_method'] as const;

export function upsertPostings(db: Database.Database, postings: CleanPosting[]) {
  const occKnown = new Set((db.prepare('SELECT code FROM occupation').all() as { code: string }[]).map((r) => r.code));
  const sql = `INSERT INTO job_posting (${COLS.join(', ')}, last_seen_at) VALUES (${COLS.map((c) => '@' + c).join(', ')}, @fetched_at)
    ON CONFLICT (id) DO UPDATE SET ${COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}, last_seen_at = excluded.last_seen_at,
      skills_extracted_at = CASE WHEN job_posting.jd_text IS excluded.jd_text AND job_posting.title_raw = excluded.title_raw THEN job_posting.skills_extracted_at END`;
  const up = db.prepare(sql);
  let n = 0;
  db.transaction(() => {
    for (const p of postings) {
      const occ = classifyTitle(p.title_raw); // current rules win over what clean.ts stored
      const code = occ && (occKnown.size === 0 || occKnown.has(occ.code)) ? occ.code : null;
      up.run({ ...p, occupation_code: code, occupation_confidence: code ? occ!.confidence : null });
      n++;
    }
  })();
  return n;
}

export async function ingest(sources: string[], opts: { retag?: boolean; llm?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  migrate(CAREER_DB, log);
  const db = new Database(CAREER_DB);
  db.pragma('foreign_keys = OFF'); // occupation rows may not be loaded on a fresh DB; codes are validated above when present
  try {
    for (const s of sources) {
      const f = join(CLEAN_DIR, `jobs-${s}.json`);
      if (!existsSync(f)) { log(`[jobs] ${f} missing, skipped`); continue; }
      const postings = JSON.parse(readFileSync(f, 'utf8')) as CleanPosting[];
      log(`[jobs] ${s}: upserted ${upsertPostings(db, postings)} postings`);
    }
    const llm = opts.llm && llmConfigured() ? providerFromEnv(new MockProvider(() => '{"skills":[]}')) : null;
    if (opts.llm && !llm) log('[jobs] --llm given but LLM_* env not configured; LLM fallback skipped');
    await tagPostings(db, { all: opts.retag, llm, log });
    computeSalaryStats(db, { log });
    const c = db.prepare(`SELECT count(*) n, count(occupation_code) occ, count(salary_min_month) sal FROM job_posting`).get() as { n: number; occ: number; sal: number };
    log(`[jobs] job_posting: ${c.n} rows, ${c.occ} with a pilot occupation, ${c.sal} with salary`);
  } finally {
    db.close();
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const sources = args.filter((a) => !a.startsWith('-'));
  await ingest(sources.length ? sources : ['upc'], { retag: args.includes('--retag'), llm: args.includes('--llm') });
}
