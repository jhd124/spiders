/**
 * Coursera source.
 *
 * robots.txt on coursera.org disallows /api/ for every UA, so we do NOT use the
 * catalog API. Instead we read the server-rendered Apollo state embedded in:
 *   1. the partner page   https://www.coursera.org/partners/<shortName>  (lists every course of the partner)
 *   2. each course page   https://www.coursera.org/learn/<slug>          (description, level, instructors, skills…)
 * Both paths are allowed by robots.txt.
 */
import { politeFetch } from './http.js';
import { extractApolloState } from './extract.js';
import { cleanText, normalizeLevel, toIsoDate, uniq } from './text.js';
import { makeCourse, type Course, type SchoolKey } from '../MOOC/schema.js';

const BASE = 'https://www.coursera.org';

export interface CourseraCard {
  id: string;
  slug: string;
  name: string;
  launchedAt: string | null;
  plannedLaunchDate: string | null;
  primaryLanguageCodes: string[];
  promoPhotoUrl: string | null;
  rating: number | null;
  reviewCount: number | null;
}

export interface CourseraDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  difficultyLevel: string | null;
  estimatedWorkload: string | null;
  totalDuration: string | null;
  primaryLanguages: string[];
  domains: { domainName?: string; subdomainName?: string }[];
  skills: string[];
  instructors: { fullName: string; title?: string | null; department?: string | null }[];
  partners: string[];
  faqs: { question: string | null; answer: string | null }[];
  courseStatus: string | null;
  courseType: string | null;
  totalEnrollmentCount: number | null;
  rating: number | null;
  launchedAt: string | null;
  photoUrl: string | null;
}

export interface CourseraRaw {
  partner: string;
  url: string;
  card: CourseraCard;
  detail: CourseraDetail | null;
  detailError?: string;
}

const deref = (state: Record<string, any>, v: any) => (v && typeof v === 'object' && '__ref' in v ? state[v.__ref] : v);

/** List every course card on a partner page. */
export async function fetchPartnerCards(shortName: string): Promise<CourseraCard[]> {
  const html = await politeFetch(`${BASE}/partners/${shortName}`);
  const state = extractApolloState(html);
  if (!state) throw new Error(`no Apollo state on partner page ${shortName}`);
  const cards = new Map<string, CourseraCard>();
  for (const [key, val] of Object.entries(state)) {
    if (!key.startsWith('ProductCardQueries')) continue;
    for (const list of Object.values(val as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const pc of list) {
        if (pc?.canonicalType !== 'COURSE') continue;
        const attrs = deref(state, pc.productTypeAttributes);
        const c = deref(state, attrs?.canonical);
        if (!c?.id || !c?.slug) continue;
        cards.set(c.id, {
          id: c.id,
          slug: c.slug,
          name: c.name,
          launchedAt: c.launchedAt ?? null,
          plannedLaunchDate: c.plannedLaunchDate ?? null,
          primaryLanguageCodes: c.primaryLanguageCodes ?? [],
          promoPhotoUrl: c.promoPhotoUrl ?? null,
          rating: typeof attrs?.rating === 'number' && attrs.rating > 0 ? attrs.rating : null,
          reviewCount: attrs?.reviewCount ?? null,
        });
      }
    }
  }
  return [...cards.values()];
}

/** Fetch & reduce a /learn/<slug> page to the fields we care about. */
export async function fetchCourseDetail(slug: string): Promise<CourseraDetail | null> {
  const html = await politeFetch(`${BASE}/learn/${slug}`);
  const state = extractApolloState(html);
  if (!state) return null;
  const page = Object.values(state).find((v: any) => v?.__typename === 'DescriptionPage_CoursePage' && v.slug === slug) as
    | Record<string, any>
    | undefined;
  if (!page) return null;
  const refs = (arr: any[] | null | undefined) => (arr ?? []).map((r) => deref(state, r)).filter(Boolean);
  return {
    id: page.id,
    slug: page.slug,
    name: page.name,
    description: page.description ?? null,
    difficultyLevel: page.difficultyLevel ?? null,
    estimatedWorkload: page.estimatedWorkload ?? null,
    totalDuration: page.material?.totalDuration ?? null,
    primaryLanguages: page.primaryLanguages ?? [],
    domains: (page.domains ?? []).map((d: any) => ({ domainName: d.domainName, subdomainName: d.subdomainName })),
    skills: refs(page.skillTags).map((s: any) => s.name),
    instructors: refs(page.instructors).map((i: any) => ({
      fullName: i.fullName,
      title: i.title ?? null,
      department: i.department ?? null,
    })),
    partners: refs(page.partners).map((p: any) => p.name).filter(Boolean),
    faqs: refs(page.cmlFaqs).map((f: any) => ({
      question: cleanText(f.question?.cmlValue ?? f.question ?? null),
      answer: cleanText(f.answer?.cmlValue ?? null),
    })),
    courseStatus: page.courseStatus ?? null,
    courseType: page.courseType ?? null,
    totalEnrollmentCount: page.totalEnrollmentCount ?? null,
    rating: page.ratings?.averageFiveStarRating ?? null,
    launchedAt: page.launchedAt ?? null,
    photoUrl: page.photoUrl ?? null,
  };
}

/** Crawl one Coursera partner: cards + (optionally) each course page. */
export async function crawlCourseraPartner(
  shortName: string,
  opts: { details?: boolean; limit?: number } = {},
): Promise<CourseraRaw[]> {
  const details = opts.details ?? !process.argv.includes('--no-details');
  let cards = await fetchPartnerCards(shortName);
  if (opts.limit) cards = cards.slice(0, opts.limit);
  console.log(`[coursera:${shortName}] ${cards.length} courses on partner page${details ? ', fetching course pages…' : ''}`);
  const out: CourseraRaw[] = [];
  let i = 0;
  for (const card of cards) {
    const url = `${BASE}/learn/${card.slug}`;
    const rec: CourseraRaw = { partner: shortName, url, card, detail: null };
    if (details) {
      try {
        rec.detail = await fetchCourseDetail(card.slug);
      } catch (err) {
        rec.detailError = err instanceof Error ? err.message : String(err);
      }
      if (++i % 20 === 0) console.log(`[coursera:${shortName}] ${i}/${cards.length}`);
    }
    out.push(rec);
  }
  return out;
}

/* ---------------- normalize ---------------- */

/** ISO-8601 duration (PT12H27M37S) -> "12h 27m" */
function isoDurationToText(d: string | null): string | null {
  if (!d) return null;
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(d);
  if (!m) return null;
  const h = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0);
  const min = Number(m[3] ?? 0);
  if (!h && !min) return null;
  return `${h ? `${h}h ` : ''}${min}m of content`.trim();
}

export function normalizeCoursera(school: SchoolKey, raw: CourseraRaw, scrapedAt: string): Course {
  const { card, detail } = raw;
  const freeFaq = detail?.faqs.find((f) => /need to pay/i.test(f.question ?? ''));
  const isFree = freeFaq?.answer ? (/available for free/i.test(freeFaq.answer) ? true : null) : null;
  const launched = detail?.launchedAt ?? card.launchedAt;
  return makeCourse(
    { school, title: cleanText(detail?.name ?? card.name) ?? card.slug, url: raw.url, platform: 'Coursera', sourceId: card.id, scrapedAt },
    {
      provider: detail?.partners.length ? detail.partners.join(', ') : null,
      description: cleanText(detail?.description),
      instructors: uniq(detail?.instructors.map((i) => i.fullName) ?? []),
      subjects: uniq((detail?.domains ?? []).flatMap((d) => [d.domainName, d.subdomainName])),
      tags: uniq(detail?.skills ?? []),
      level: normalizeLevel(detail?.difficultyLevel),
      languages: uniq(detail?.primaryLanguages.length ? detail.primaryLanguages : card.primaryLanguageCodes),
      duration: isoDurationToText(detail?.totalDuration ?? null),
      effort: cleanText(detail?.estimatedWorkload),
      isFree,
      price: isFree ? 0 : null,
      startDate: toIsoDate(launched),
      status: detail?.courseStatus === 'LAUNCHED' ? 'active' : detail?.courseStatus === 'PRELAUNCH' ? 'upcoming' : null,
      imageUrl: detail?.photoUrl ?? card.promoPhotoUrl,
      enrollmentCount: detail?.totalEnrollmentCount ?? null,
      rating: detail?.rating ? Math.round(detail.rating * 100) / 100 : card.rating ? Math.round(card.rating * 100) / 100 : null,
    },
  );
}
