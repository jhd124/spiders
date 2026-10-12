/**
 * Dry run for ONE document, without touching the manifest or the database:
 *   npm run career:curriculum:try -- --url=<培养方案 url> --format=pdf --school=山东大学 --major=080901 [--file=local.pdf]
 * Fetches (politely), extracts text, runs extraction (mock unless LLM_* env is set; in-memory cache only),
 * and writes data/tmp/curriculum-try.json. Nothing is ingested.
 */
import { DATA_DIR, writeJson } from '../../lib/io.js';
import { join } from 'node:path';
import { providerFromEnv } from '../../lib/llm.js';
import { MemoryCache } from './cache.js';
import { extractCourses, mockProvider, chunkPages, RELEVANT } from './extract.js';
import { fetchFile } from './fetch.js';
import { sourceId, type DocFormat } from './manifest.js';
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
const chunks = chunkPages(pages);
console.log(`[try] chunks ${chunks.length}, relevant (would be sent to the LLM) ${chunks.filter((c) => RELEVANT.test(c.text)).length}, ~${Math.round(chunks.filter((c) => RELEVANT.test(c.text)).reduce((n, c) => n + c.text.length, 0) / 1.5)} input tokens est.`);
const provider = providerFromEnv(mockProvider());
const r = await extractCourses(pages, { school, majorCode: major, majorName: major }, provider, new MemoryCache());
console.log(`[try] provider ${provider.model}${provider.isMock ? ' (MOCK — not real data)' : ''}: ${r.courses.length} courses`);
for (const c of r.courses) console.log(`  p${c.page} [${c.course_type}] ${c.name}${c.credits != null ? ` ${c.credits}学分` : ''}  «${c.snippet}»`);
const outPath = join(DATA_DIR, 'tmp', 'curriculum-try.json');
await writeJson(outPath, { url, meta, quality, result: r, pages });
console.log(`[try] -> ${outPath}`);
