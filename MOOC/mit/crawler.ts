/**
 * MIT — public free course listings:
 *  1. MIT OpenCourseWare via MIT Learn's public catalog API (the API behind learn.mit.edu / OCW search):
 *     https://api.learn.mit.edu/api/v1/courses/?platform=ocw  (paginated, limit/offset; no robots.txt on that host,
 *     ocw.mit.edu robots.txt allows everything)
 *  2. MITx (MITx Online + Open Learning Library) from the same API: ?offered_by=mitx
 *     (https://www.edx.org/school/mitx now just redirects to the edX home page — MITx left edX's school
 *     pages — so edX is not used as a source for MIT.)
 * Run: npm run crawl:mit
 */
import { isMain } from '../../lib/main.js';
import { politeFetch } from '../../lib/http.js';
import { runSources } from '../../lib/io.js';

const API = 'https://api.learn.mit.edu/api/v1/courses/';
const PAGE = 100;

/** Subset of a MIT Learn course record kept in raw output. */
export interface OcwRaw {
  id: number;
  readable_id: string;
  /** MIT Learn platform, e.g. ocw / mitxonline / oll */
  platform: string | null;
  platformName: string | null;
  offeredBy: string | null;
  title: string;
  url: string;
  description: string | null;
  free: boolean | null;
  topics: string[];
  ocw_topics: string[];
  departments: string[];
  course_numbers: string[];
  course_feature: string[];
  instructors: string[];
  level: string[];
  semester: string | null;
  year: number | null;
  languages: string[] | null;
  image: string | null;
  pace: string[];
  availability: string | null;
  license_cc: boolean | null;
  views: number | null;
}

interface ApiPage {
  count: number;
  next: string | null;
  results: any[];
}

function reduce(r: any): OcwRaw {
  const run = (r.runs ?? []).find((x: any) => x.id === r.best_run_id) ?? r.runs?.[0] ?? {};
  return {
    id: r.id,
    readable_id: r.readable_id,
    platform: r.platform?.code ?? null,
    platformName: r.platform?.name ?? null,
    offeredBy: r.offered_by?.name ?? null,
    title: r.title,
    url: r.url ?? run.url,
    description: r.description ?? run.description ?? null,
    free: r.free ?? null,
    topics: (r.topics ?? []).map((t: any) => t.name),
    ocw_topics: r.ocw_topics ?? [],
    departments: (r.departments ?? []).map((d: any) => d.name),
    course_numbers: (r.course?.course_numbers ?? []).map((n: any) => n.value),
    course_feature: r.course_feature ?? [],
    instructors: (run.instructors ?? []).map((i: any) => i.full_name).filter(Boolean),
    level: (run.level ?? []).map((l: any) => l.name),
    semester: run.semester ?? null,
    year: run.year ?? null,
    languages: r.languages ?? run.languages ?? null,
    image: r.image?.url ?? null,
    pace: (r.pace ?? []).map((p: any) => p.code),
    availability: r.availability ?? null,
    license_cc: r.license_cc ?? null,
    views: r.views ?? null,
  };
}

/** Page through MIT Learn's course catalog for a filter, e.g. "platform=ocw" or "offered_by=mitx". */
export async function crawlLearn(filter: string): Promise<OcwRaw[]> {
  const out: OcwRaw[] = [];
  let url: string | null = `${API}?${filter}&limit=${PAGE}&offset=0`;
  let total = 0;
  while (url) {
    const page = JSON.parse(await politeFetch(url, { headers: { Accept: 'application/json' } })) as ApiPage;
    total = page.count;
    out.push(...page.results.map(reduce));
    console.log(`[mit] ${filter}: ${out.length}/${total}`);
    url = page.next;
  }
  return out;
}

if (isMain(import.meta.url)) {
  await runSources('mit', {
    ocw: () => crawlLearn('platform=ocw'),
    mitx: () => crawlLearn('offered_by=mitx'),
  });
}
