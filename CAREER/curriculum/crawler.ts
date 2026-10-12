/**
 * 培养方案 fetcher: for every row of CAREER/seeds/curriculum_sources.csv download the document and
 * extract text per page -> data/raw/career-curriculum.json (+ the original file under data/raw/career/curriculum/).
 *   npm run crawl:career-curriculum                 # all manifest rows
 *   npm run crawl:career-curriculum -- --only=080901 # rows whose major_code / school contains the value
 * Rows that fail are recorded with their error; the rest continue.
 */
import { rawPath, readJson, writeJson } from '../../lib/io.js';
import { existsSync } from 'node:fs';
import { isMain } from '../../lib/main.js';
import { readManifest, type CurriculumSource } from './manifest.js';
import { fetchFile, type FetchedFile } from './fetch.js';
import { extractText, textQuality, type PageText } from './text.js';

export const RAW_NAME = 'career-curriculum';

export interface RawCurriculum {
  scrapedAt: string;
  docs: { source: CurriculumSource; meta?: FetchedFile; pages?: PageText[]; quality?: ReturnType<typeof textQuality>; error?: string }[];
}

export async function crawl(argv = process.argv.slice(2)): Promise<RawCurriculum> {
  const only = argv.find((a) => a.startsWith('--only='))?.slice(7);
  const rows = readManifest().filter((r) => !only || r.major_code.includes(only) || r.school.includes(only));
  // keep previous results for rows we don't refetch
  const prev = existsSync(rawPath(RAW_NAME)) ? await readJson<RawCurriculum>(rawPath(RAW_NAME)).catch(() => null) : null;
  const out: RawCurriculum = { scrapedAt: new Date().toISOString(), docs: [] };
  const ids = new Set(readManifest().map((r) => r.id));
  for (const d of prev?.docs ?? []) if (ids.has(d.source.id) && !rows.some((r) => r.id === d.source.id)) out.docs.push(d);
  for (const source of rows) {
    try {
      const { meta, data } = await fetchFile(source.id, source.url, source.format);
      const pages = await extractText(data, source.format);
      const quality = textQuality(pages);
      out.docs.push({ source, meta, pages, quality });
      console.log(`[${RAW_NAME}] ${source.school} ${source.major_code}: ${meta.bytes} bytes, ${quality.pages} pages, ${quality.chars} chars`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.docs.push({ source, error });
      console.error(`[${RAW_NAME}] ${source.school} ${source.major_code} failed: ${error}`);
    }
  }
  console.log(`[${RAW_NAME}] manifest: ${out.docs.length} records`);
  await writeJson(rawPath(RAW_NAME), out);
  return out;
}

if (isMain(import.meta.url)) await crawl();
