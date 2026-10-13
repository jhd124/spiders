/**
 * Dry run for ONE document, without touching the manifest or the database:
 *   npm run career:curriculum:try -- --url=<培养方案 url> --format=pdf --school=山东大学 --major=080901|*|080901|080902 [--file=local.pdf]
 * Fetches (politely), extracts text, runs extraction (mock unless LLM_* env is set; in-memory cache only),
 * and writes data/tmp/curriculum-try.json. Nothing is ingested.
 */
import { DATA_DIR, writeJson } from '../../lib/io.js';
import { join } from 'node:path';
import { providerFromEnv } from '../../lib/llm.js';
import { MemoryCache } from './cache.js';
import { extractCourses, mockProvider, planChunks } from './extract.js';
import { fetchFile } from './fetch.js';
import { sourceId, type DocFormat } from './manifest.js';
import { planUnits } from './plan.js';
import { extractText, textQuality } from './text.js';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const url = arg('url');
const format = (arg('format') ?? 'pdf') as DocFormat;
const school = arg('school') ?? '?';
const major = arg('major') ?? '?';
if (!url) throw new Error('usage: --url=<url> [--format=pdf|html|docx] [--school=] [--major=] [--file=local]');
const { meta, data } = await fetchFile('try-' + sourceId(url), url, format, arg('file'));
const pages = await extractText(data, format);
const quality = textQuality(pages);
console.log(`[try] ${meta.bytes} bytes sha256 ${meta.sha256.slice(0, 12)}…`, JSON.stringify(quality));
const chunks = planChunks(pages);
console.log(`[try] LLM units ${chunks.length} (${chunks.map((c) => c.kind).join(',')}), ~${Math.round(chunks.reduce((n, c) => n + c.text.length, 0) / 1.5)} input tokens est.`);
const provider = providerFromEnv(mockProvider());
const plan = planUnits({ major_code: major }, pages);
console.log(`[try] major sections found: ${plan.sections.length}`);
for (const sec of plan.sections) console.log(`  ${sec.major_code} ${sec.major_name}${sec.variant ? `（${sec.variant}）` : ''}  PDF p${sec.page_start}-${sec.page_end}${sec.printed_pages ? ` (printed ·${sec.printed_pages}·)` : ''}  ${sec.pilot ? 'PILOT' : 'not pilot'}${sec.extracted ? '  -> extract' : sec.variant ? '  (class variant: notes only)' : ''}`);
if (plan.missing.length) console.log(`[try] requested but not found: ${plan.missing.join(', ')}`);
const results = [];
for (const u of plan.units) {
  const r = await extractCourses(u.pages, { school, majorCode: u.major_code, majorName: u.section?.major_name ?? u.major_code }, provider, new MemoryCache());
  results.push({ major_code: u.major_code, section: u.section, ...r });
  console.log(`[try] ${u.major_code}${u.section ? ` p${u.section.page_start}-${u.section.page_end}` : ''}: provider ${provider.model}${provider.isMock ? ' (MOCK — not real data)' : ''}: ${r.courses.length} courses, chunks ${r.stats.sent}/${r.stats.chunks} sent`);
  for (const c of r.courses) console.log(`  p${c.page} [${c.block ?? '-'}/${c.course_type ?? '-'}${c.core_in_section ? '/四核心' : ''}] ${c.name}${c.credits != null ? ` ${c.credits}学分` : ''}  «${c.snippet}»`);
}
const outPath = join(DATA_DIR, 'tmp', 'curriculum-try.json');
await writeJson(outPath, { url, meta, quality, sections: plan.sections, results, pages });
console.log(`[try] -> ${outPath}`);
