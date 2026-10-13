/**
 * LLM stage: extract every course (table + 核心课程 paragraph) from each fetched 培养方案 -> data/clean/career-curriculum.json.
 * Uses the real provider when LLM_BASE_URL / LLM_API_KEY / LLM_MODEL are set, otherwise the offline mock
 * (results flagged mock=true; ingest skips them). Responses are cached in career.db (llm_cache).
 *   npm run clean:career-curriculum [-- --max-calls=50] [-- --refresh]   # cap on paid calls; --refresh ignores cached responses
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { cleanPath, rawPath, readJson, writeJson } from '../../lib/io.js';
import { isMain } from '../../lib/main.js';
import { providerFromEnv } from '../../lib/llm.js';
import { migrate } from '../migrate.js';
import { CAREER_DB } from '../db.js';
import { SqliteLlmCache } from './cache.js';
import { extractCourses, mockProvider, type ExtractionResult } from './extract.js';
import { RAW_NAME, type RawCurriculum } from './crawler.js';
import { planUnits, type ExtractUnit } from './plan.js';
import { isMultiMajor } from './manifest.js';

export interface CleanCurriculum {
  extractedAt: string;
  results: ({ source_id: string; school: string; major_code: string; section: ExtractUnit['section']; doc_sha256: string; url: string } & ExtractionResult)[];
}

export async function clean(argv = process.argv.slice(2)) {
  const refresh = argv.includes('--refresh');
  const maxCalls = Number(argv.find((a) => a.startsWith('--max-calls='))?.slice(12) ?? process.env.LLM_MAX_CALLS ?? 200);
  if (!existsSync(rawPath(RAW_NAME))) {
    console.log(`[${RAW_NAME}] nothing fetched yet`);
    await writeJson(cleanPath(RAW_NAME), { extractedAt: new Date().toISOString(), results: [] });
    console.log(`[${RAW_NAME}] clean: 0 records`);
    return;
  }
  const raw = await readJson<RawCurriculum>(rawPath(RAW_NAME));
  migrate(CAREER_DB, () => {});
  const db = new Database(CAREER_DB);
  const majorName = (code: string) => (db.prepare('SELECT name FROM major WHERE code = ?').get(code) as { name: string } | undefined)?.name;
  const provider = providerFromEnv(mockProvider());
  console.log(`[${RAW_NAME}] provider: ${provider.isMock ? 'MOCK (no LLM_* env) — output will not be ingested' : provider.model}`);
  const cache = new SqliteLlmCache(db);
  const out: CleanCurriculum = { extractedAt: new Date().toISOString(), results: [] };
  let calls = 0;
  try {
    for (const d of raw.docs) {
      if (!d.pages || !d.meta) continue;
      const plan = planUnits(d.source, d.pages);
      if (plan.sections.length > 1 || isMultiMajor(d.source)) console.log(`[${RAW_NAME}] ${d.source.school}: sections ${plan.notes.join('; ') || 'none found'}${plan.missing.length ? `; not found: ${plan.missing.join(',')}` : ''}`);
      for (const u of plan.units) {
        const name = majorName(u.major_code);
        if (!name) { console.error(`[${RAW_NAME}] unknown major_code ${u.major_code} (not in major table)`); continue; }
        if (!provider.isMock && calls >= maxCalls) { console.warn(`[${RAW_NAME}] --max-calls=${maxCalls} reached, stopping`); break; }
        const r = await extractCourses(u.pages, { school: d.source.school, majorCode: u.major_code, majorName: name }, provider, cache, { refresh });
        calls += r.stats.llm_calls;
        out.results.push({ source_id: d.source.id, school: d.source.school, major_code: u.major_code, section: u.section, doc_sha256: d.meta.sha256, url: d.source.url, ...r });
        console.log(`[${RAW_NAME}] ${d.source.school} ${u.major_code}${u.section ? ` (p${u.section.page_start}-${u.section.page_end})` : ''}: ${r.courses.length} courses (chunks ${r.stats.sent}/${r.stats.chunks} sent, ${r.stats.cached} cached, ${r.stats.llm_calls} calls, ${r.stats.dropped_unverified} unverified dropped, tokens ${r.stats.prompt_tokens}+${r.stats.completion_tokens})`);
      }
    }
  } finally {
    db.close();
  }
  await writeJson(cleanPath(RAW_NAME), out);
  console.log(`[${RAW_NAME}] clean: ${out.results.reduce((n, r) => n + r.courses.length, 0)} records${provider.isMock ? ' (mock)' : ''}`);
}

if (isMain(import.meta.url)) await clean();
