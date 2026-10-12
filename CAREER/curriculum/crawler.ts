/**
 * 培养方案 fetcher: for every row of CAREER/seeds/curriculum_sources.csv download the document and
 * extract text per page -> data/raw/career-curriculum.json (+ the original file under data/raw/career/curriculum/).
 *   npm run crawl:career-curriculum                 # all manifest rows
 *   npm run crawl:career-curriculum -- --only=080901 # rows whose major_code / school contains the value
 *   npm run crawl:career-curriculum -- --refresh     # re-download (default: each url is downloaded once and reused)
 * Rows that fail are recorded with their error; the rest continue.
 */
import { rawPath, readJson, writeJson } from '../../lib/io.js';
import { existsSync } from 'node:fs';
import { isMain } from '../../lib/main.js';
import { readManifest, type CurriculumSource } from './manifest.js';
import { fetchFile, type FetchedFile } from './fetch.js';
import { planUnits, type SectionInfo } from './plan.js';
import { extractText, textQuality, type PageText } from './text.js';

export const RAW_NAME = 'career-curriculum';

export interface RawCurriculum {
  scrapedAt: string;
  docs: { source: CurriculumSource; meta?: FetchedFile; pages?: PageText[]; quality?: ReturnType<typeof textQuality>; sections?: SectionInfo[]; error?: string }[];
}

export async function crawl(argv = process.argv.slice(2)): Promise<RawCurriculum> {
  const refresh = argv.includes('--refresh');
  const only = argv.find((a) => a.startsWith('--only='))?.slice(7);
  const rows = readManifest().filter((r) => !only || r.major_code.includes(only) || r.school.includes(only));
  // keep previous results for rows we don't refetch
  const prev = existsSync(rawPath(RAW_NAME)) ? await readJson<RawCurriculum>(rawPath(RAW_NAME)).catch(() => null) : null;
  const out: RawCurriculum = { scrapedAt: new Date().toISOString(), docs: [] };
  const ids = new Set(readManifest().map((r) => r.id));
  for (const d of prev?.docs ?? []) if (ids.has(d.source.id) && !rows.some((r) => r.id === d.source.id)) out.docs.push(d);
  for (const source of rows) {
    try {
      // download once: reuse the stored file (same url, sha256 checked) unless --refresh
      const old = prev?.docs.find((d) => d.source.id === source.id && d.meta);
      const reuse = !refresh && old?.meta && existsSync(old.meta.path) ? old.meta : null;
      const { meta, data } = reuse
        ? await fetchFile(source.id, source.url, source.format, reuse.path).then((r) => ({ ...r, meta: { ...r.meta, content_type: reuse.content_type, fetched_at: reuse.fetched_at } }))
        : await fetchFile(source.id, source.url, source.format);
      if (reuse && reuse.sha256 !== meta.sha256) throw new Error(`stored file for ${source.url} changed on disk (sha256); re-run with --refresh`);
      const pages = await extractText(data, source.format);
      const quality = textQuality(pages);
      const plan = planUnits(source, pages);
      out.docs.push({ source, meta, pages, quality, sections: plan.sections });
      console.log(`[${RAW_NAME}] ${source.school} ${source.major_code}: ${reuse ? 'reused stored file, ' : ''}${meta.bytes} bytes, ${plan.sections.length} major sections, ${quality.pages} pages, ${quality.chars} chars`);
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
