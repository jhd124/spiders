/** data/raw/jobs/upc.json -> data/clean/jobs-upc.json (CleanPosting[]); pure normalization, no network. */
import { existsSync } from 'node:fs';
import { CLEAN_DIR, readJson, writeJson } from '../../lib/io.js';
import { join } from 'node:path';
import { isMain } from '../../lib/main.js';
import { classifyTitle } from '../occupations.js';
import { decodeText, dedupeKey, normChannel, normCity, normEducation, parseSalary } from '../normalize.js';
import type { CleanPosting } from '../types.js';
import { BASE, RAW_FILE, SITE, type UpcRaw, type UpcState } from './crawler.js';

export const CLEAN_FILE = join(CLEAN_DIR, 'jobs-upc.json');

export function cleanOne(r: UpcRaw): CleanPosting | null {
  if (!r.zwid || !r.zwmc) return null;
  const title = decodeText(r.zwmc) ?? r.zwmc.trim();
  const cityRaw = r.gzszxmc || r.gzszsmc || r.gzdz || null;
  const city = normCity(r.gzszxmc || r.gzszsmc) ?? normCity(r.gzdz);
  const sal = parseSalary(r.yxmc);
  const occ = classifyTitle(title);
  const { _keyword, _fetchedAt, ...pub } = r;
  return {
    id: `${SITE}:${r.zwid}`,
    site: SITE,
    channel: normChannel('校招', r.gzlxmc, title),
    title_raw: title,
    company_raw: decodeText(r.dwmc),
    city_raw: cityRaw,
    city,
    salary_raw: r.yxmc ?? null,
    salary_min_month: sal.min,
    salary_max_month: sal.max,
    salary_months: sal.months,
    salary_note: (r.yxmc && !/[kK万千元wW]/.test(r.yxmc) ? 'site unit 元/月; ' : '') + sal.note,
    education_raw: r.xlyqmc ?? null,
    education: normEducation(r.xlyqmc),
    experience_raw: null,
    experience_min_years: 0, // campus-recruiting site: 应届
    industry_raw: r.hyyjmc ?? r.zwlbymc ?? null,
    jd_text: decodeText(r.zwms),
    occupation_code: occ?.code ?? null,
    occupation_confidence: occ?.confidence ?? null,
    search_keyword: _keyword,
    dedupe_key: dedupeKey(r.dwmc ?? null, title, city, r.yxmc ?? null),
    raw_json: JSON.stringify(pub),
    published_at: r.fbrq ?? null,
    source_url: `${BASE}/zwxx/view/${r.zwid}`,
    fetched_at: _fetchedAt,
    extraction_method: 'api',
  };
}

export async function clean() {
  if (!existsSync(RAW_FILE)) throw new Error(`${RAW_FILE} missing; run JOBS/upc/crawler.ts first`);
  const state = await readJson<UpcState>(RAW_FILE);
  const out = Object.values(state.postings).map(cleanOne).filter((x): x is CleanPosting => !!x);
  await writeJson(CLEAN_FILE, out);
  const occ = out.filter((p) => p.occupation_code).length;
  const sal = out.filter((p) => p.salary_min_month != null || p.salary_max_month != null).length;
  console.log(`[jobs:upc] clean: ${out.length} postings, ${occ} matched to a pilot occupation, ${sal} with salary -> ${CLEAN_FILE}`);
  return out;
}

if (isMain(import.meta.url)) await clean();
