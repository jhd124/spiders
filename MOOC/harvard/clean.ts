/** Harvard raw (pll.harvard.edu) -> Course[]. Run: npm run clean:harvard */
import { isMain } from '../../lib/main.js';
import { makeCourse, type Course, type Platform } from '../schema.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { cleanText, normalizeLevel, toNumber, uniq } from '../../lib/text.js';
import type { HarvardRaw } from './crawler.js';

function platformOf(p: string | undefined): Platform {
  if (!p) return 'Harvard Online Learning';
  if (/edx/i.test(p)) return 'edX';
  if (/coursera/i.test(p)) return 'Coursera';
  return 'Harvard Online Learning';
}

export function cleanHarvard(items: HarvardRaw[], scrapedAt: string): Course[] {
  return items.map((r) => {
    const d = r.datalayer;
    const price = toNumber(d['course-price'] ?? d['price']);
    const pace = (d['course-pace'] ?? '').toLowerCase();
    const slug = new URL(r.url).pathname.replace(/^\/course\//, '');
    return makeCourse(
      { school: 'harvard', title: cleanText(r.title) ?? slug, url: r.url, platform: platformOf(d['course-platform']), sourceId: slug, scrapedAt },
      {
        provider: cleanText(d['course-school'] ?? d['item-brand']),
        description: cleanText(r.description?.replace(/^\s*Course description\s*/i, '')) ?? cleanText(r.summary),
        instructors: uniq(r.instructors ?? []),
        subjects: uniq([...r.subjects, d['item-category'], d['item-category2']]),
        level: normalizeLevel(d['course-difficulty']),
        languages: uniq([d['course-language']]),
        duration: cleanText(r.durationText),
        weeks: toNumber(/(\d+(?:\.\d+)?)\s*weeks?/i.exec(r.durationText ?? '')?.[1]),
        isFree: price === 0 || /^free/i.test(r.priceText ?? '') ? true : price ? false : null,
        price,
        certificatePrice: toNumber(d['course-certificate-price']),
        currency: cleanText(d['currency']),
        pace: /self/.test(pace) ? 'self-paced' : /instructor|cohort/.test(pace) ? 'instructor-paced' : null,
        termText: cleanText(d['program-dates'] ?? r.registrationText),
        status: /available now|anytime/i.test(`${r.registrationText} ${d['program-dates']}`) ? 'active' : null,
        imageUrl: r.imageUrl,
      },
    );
  });
}

if (isMain(import.meta.url)) {
  const raw = await loadRaw('harvard');
  await writeClean('harvard', cleanHarvard((raw.sources['pll.harvard.edu'] ?? []) as HarvardRaw[], raw.scrapedAt));
}
