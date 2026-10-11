/**
 * edX source.
 *
 * The school page https://www.edx.org/school/<orgx> is a Next.js app-router page whose
 * React Server Components payload embeds the same product records edX's search index
 * (Algolia) returns. We decode that payload and keep records owned by the org.
 * robots.txt allows /school/ and asks for Crawl-delay: 10, which politeFetch honours.
 */
import { politeFetch } from './http.js';
import { extractNextFlight, findObjectsWithKey } from './extract.js';
import { cleanText, normalizeLevel, slugToName, toNumber, uniq } from './text.js';
import { makeCourse, type Course, type SchoolKey } from '../MOOC/schema.js';

const BASE = 'https://www.edx.org';

/** Subset of the edX search record we keep in raw output. */
export interface EdxRecord {
  objectID: string;
  productUuid?: string;
  productName: string;
  productSlug: string;
  productType: string;
  partner?: string[];
  partnerKeys?: string[];
  shortDescription?: string | null;
  productOverview?: string | null;
  attributes?: string[];
  skills?: string[];
  staff?: string[];
  level?: string | null;
  language?: string[];
  availability?: string[];
  flexibility?: string | null;
  weeksToComplete?: number | null;
  minHoursEffortPerWeek?: number | null;
  maxHoursEffortPerWeek?: number | null;
  listPrice?: number | null;
  currencyCode?: string | null;
  activeRunKey?: string | null;
  isActive?: boolean;
  onlyArchivedCourseRuns?: boolean;
  enrollmentCount?: number | null;
  productImageUrl?: string | null;
  goLiveDate?: string | number | null;
  externalUrl?: string | null;
  [k: string]: unknown;
}

const KEEP: (keyof EdxRecord)[] = [
  'objectID', 'productUuid', 'productName', 'productSlug', 'productType', 'partner', 'partnerKeys',
  'shortDescription', 'productOverview', 'attributes', 'skills', 'staff', 'level', 'language',
  'availability', 'flexibility', 'weeksToComplete', 'minHoursEffortPerWeek', 'maxHoursEffortPerWeek',
  'listPrice', 'currencyCode', 'activeRunKey', 'isActive', 'onlyArchivedCourseRuns', 'enrollmentCount',
  'productImageUrl', 'goLiveDate', 'externalUrl',
];

/**
 * Crawl https://www.edx.org/school/<orgSlug> and return course records whose partnerKeys include `orgKey`.
 * @param orgSlug e.g. "brownx"   @param orgKey e.g. "BrownX"
 */
export async function crawlEdxSchool(orgSlug: string, orgKey: string, opts: { includePrograms?: boolean } = {}): Promise<EdxRecord[]> {
  const html = await politeFetch(`${BASE}/school/${orgSlug}`);
  const flight = extractNextFlight(html);
  if (!flight) throw new Error(`no RSC payload on ${BASE}/school/${orgSlug}`);
  const recs = findObjectsWithKey(flight, 'objectID') as EdxRecord[];
  return recs
    .filter((r) => r.productName && r.productSlug && (r.partnerKeys ?? []).includes(orgKey))
    .filter((r) => opts.includePrograms || r.productType === 'Course')
    .map((r) => {
      const o: Record<string, unknown> = {};
      for (const k of KEEP) if (k in r) o[k] = r[k];
      // RSC sometimes replaces long strings with "$<ref>" placeholders; drop those.
      for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && /^\$[0-9a-f]+$/i.test(v)) o[k] = null;
      return o as EdxRecord;
    });
}

/* ---------------- normalize ---------------- */

export function normalizeEdx(school: SchoolKey, r: EdxRecord, scrapedAt: string): Course {
  const url = r.externalUrl || `${BASE}/${r.productSlug.replace(/^\//, '')}`;
  const avail = (r.availability ?? []).map((a) => a.toLowerCase());
  const minH = toNumber(r.minHoursEffortPerWeek);
  const maxH = toNumber(r.maxHoursEffortPerWeek);
  const weeks = toNumber(r.weeksToComplete);
  const effort = minH || maxH ? `${minH ?? maxH}${maxH && maxH !== minH ? `–${maxH}` : ''} hours/week` : null;
  return makeCourse(
    { school, title: cleanText(r.productName) ?? r.productSlug, url, platform: 'edX', sourceId: r.productUuid ?? r.objectID, scrapedAt },
    {
      provider: r.partnerKeys?.join(', ') ?? null,
      description: cleanText(r.shortDescription) ?? cleanText(r.productOverview),
      instructors: uniq((r.staff ?? []).map(slugToName)),
      subjects: uniq(r.attributes ?? []),
      tags: uniq(r.skills ?? []),
      level: normalizeLevel(r.level),
      languages: uniq(r.language ?? []),
      duration: weeks ? `${weeks} weeks` : null,
      effort,
      weeks,
      // edX lists the verified-certificate price; auditing is generally free but the record doesn't state it.
      certificatePrice: toNumber(r.listPrice),
      currency: r.currencyCode ?? null,
      pace: r.flexibility === 'self_paced' ? 'self-paced' : r.flexibility === 'instructor_paced' ? 'instructor-paced' : null,
      termText: r.availability?.join(', ') ?? null,
      status: r.onlyArchivedCourseRuns || avail.includes('archived') && avail.length === 1
        ? 'archived'
        : avail.some((a) => a.includes('upcoming')) && !avail.some((a) => a.includes('available now'))
          ? 'upcoming'
          : r.isActive || avail.some((a) => a.includes('available now')) ? 'active' : null,
      imageUrl: r.productImageUrl ?? null,
      enrollmentCount: toNumber(r.enrollmentCount),
    },
  );
}
