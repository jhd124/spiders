/**
 * JOBS ingest: data/clean/jobs-<source>.json -> career.db job_posting (upsert), then JD skill tagging, then salary_stat.
 *   tsx JOBS/ingest.ts [source...] [--retag] [--force] [--llm]
 *   --force (= --retag): re-run term tagging on every posting and, with --llm, re-send every zero-skill posting to the LLM.
 *   --llm alone sends zero-skill postings never tried by the LLM (llm_attempted_at NULL).
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
import { EMBEDDED_CODE, SOFTWARE_CODE, classifyPosting, embeddedEvidence } from './occupations.js';
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
      skills_extracted_at = CASE WHEN job_posting.jd_text IS excluded.jd_text AND job_posting.title_raw = excluded.title_raw THEN job_posting.skills_extracted_at END,
      llm_attempted_at = CASE WHEN job_posting.jd_text IS excluded.jd_text AND job_posting.title_raw = excluded.title_raw THEN job_posting.llm_attempted_at END`;
  const up = db.prepare(sql);
  let n = 0;
  db.transaction(() => {
    for (const p of postings) {
      const c = classifyPosting(p.title_raw); // current rules win over what clean.ts stored; reclassifyAll sets the flags
      const code = c.code && (occKnown.size === 0 || occKnown.has(c.code)) ? c.code : null;
      up.run({ ...p, occupation_code: code, occupation_confidence: code ? c.confidence : null });
      n++;
    }
  })();
  reclassifyAll(db);
  return n;
}

/**
 * Re-apply the current JOBS/occupations.ts rules to EVERY stored posting (not only the ones in this run's clean file),
 * so a rule change takes effect on the server with a plain `npm run jobs:ingest` (or `npm run jobs:reclassify`).
 */
export function reclassifyAll(db: Database.Database) {
  const occKnown = new Set((db.prepare('SELECT code FROM occupation').all() as { code: string }[]).map((r) => r.code));
  const rows = db.prepare('SELECT id, title_raw, occupation_code, multi_role, classify_reason FROM job_posting').all() as { id: string; title_raw: string; occupation_code: string | null; multi_role: number; classify_reason: string | null }[];
  const upd = db.prepare(`UPDATE job_posting SET occupation_code = ?, occupation_confidence = ?, multi_role = ?, classify_reason = ?,
      skills_extracted_at = CASE WHEN ? THEN NULL ELSE skills_extracted_at END WHERE id = ?`);
  let changed = 0;
  const reasons: Record<string, number> = {};
  db.transaction(() => {
    for (const r of rows) {
      const c = classifyPosting(r.title_raw);
      const code = c.code && (occKnown.size === 0 || occKnown.has(c.code)) ? c.code : null;
      const mr = c.multiRole ? 1 : 0;
      reasons[c.reason] = (reasons[c.reason] ?? 0) + 1;
      // a C/C++ posting already moved to 嵌入式 by its JD stays there; applyEmbeddedRule re-checks it after tagging
      if (c.reason === 'cpp' && r.classify_reason === 'cpp_embedded' && code === SOFTWARE_CODE) { reasons.cpp_embedded = (reasons.cpp_embedded ?? 0) + 1; reasons.cpp = (reasons.cpp ?? 1) - 1; continue; }
      const moved = code !== r.occupation_code || mr !== r.multi_role;
      if (moved) changed++;
      // newly in scope for skill tagging (classified or multi-role) -> make sure it gets tagged
      const rescan = moved && (code != null || mr === 1) && r.occupation_code == null && r.multi_role === 0;
      upd.run(code, code ? c.confidence : null, mr, c.reason, rescan ? 1 : 0, r.id);
    }
  })();
  return { total: rows.length, changed, reasons };
}

/**
 * Post-extraction rule (expert 2026-10-14): C/C++ titles are 软件工程 by title; if the JD or the extracted skills
 * mention 单片机 / RTOS / 驱动 … (EMBEDDED_TERMS, env JOBS_EMBEDDED_TERMS) the posting moves to 嵌入式
 * (classify_reason 'cpp_embedded'), otherwise it is (back) in 软件工程 ('cpp'). Run after tagPostings.
 */
export function applyEmbeddedRule(db: Database.Database) {
  const rows = db.prepare(`SELECT p.id, p.jd_text, p.classify_reason, group_concat(coalesce(s.name, '') || ' ' || k.skill_id || ' ' || coalesce(k.matched_text, ''), ' ') sk
      FROM job_posting p LEFT JOIN job_posting_skill k ON k.posting_id = p.id LEFT JOIN skill s ON s.id = k.skill_id
      WHERE p.classify_reason IN ('cpp', 'cpp_embedded') GROUP BY p.id`).all() as { id: string; jd_text: string | null; classify_reason: string; sk: string | null }[];
  const upd = db.prepare('UPDATE job_posting SET occupation_code = ?, classify_reason = ? WHERE id = ?');
  let embedded = 0, software = 0, moved = 0;
  db.transaction(() => {
    for (const r of rows) {
      const hit = embeddedEvidence(`${r.jd_text ?? ''}\n${r.sk ?? ''}`);
      const reason = hit ? 'cpp_embedded' : 'cpp';
      if (hit) embedded++; else software++;
      if (reason !== r.classify_reason) moved++;
      upd.run(hit ? EMBEDDED_CODE : SOFTWARE_CODE, reason, r.id);
    }
  })();
  return { cpp: rows.length, embedded, software, moved };
}

export async function ingest(sources: string[], opts: { retag?: boolean; force?: boolean; llm?: boolean; log?: (s: string) => void } = {}) {
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
    const rc = reclassifyAll(db);
    log(`[jobs] reclassified ${rc.total} stored postings with current rules: ${rc.changed} changed; ${Object.entries(rc.reasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const llm = opts.llm && llmConfigured() ? providerFromEnv(new MockProvider(() => '{"skills":[]}')) : null;
    if (opts.llm && !llm) log('[jobs] --llm given but LLM_* env not configured; LLM fallback skipped');
    await tagPostings(db, { all: opts.retag || opts.force, llm, log });
    const em = applyEmbeddedRule(db);
    log(`[jobs] C/C++ postings: ${em.cpp}; ${em.embedded} -> 嵌入式 by JD/skills (单片机/RTOS/驱动…), ${em.software} stay 软件工程; ${em.moved} changed`);
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
  // --no-sources: skip the clean files; just re-classify stored postings, tag, and rebuild salary_stat
  await ingest(args.includes('--no-sources') ? [] : sources.length ? sources : ['upc'], { retag: args.includes('--retag'), force: args.includes('--force'), llm: args.includes('--llm') });
}
