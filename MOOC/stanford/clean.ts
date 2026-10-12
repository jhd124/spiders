/** Stanford raw (SEE + Coursera + edX) -> Course[]. Run: npm run clean:stanford */
import { isMain } from '../../lib/main.js';
import { makeCourse, type Course } from '../schema.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { normalizeCoursera, type CourseraRaw } from '../../lib/coursera.js';
import { normalizeEdx, type EdxRecord } from '../../lib/edx.js';
import { cleanText, uniq } from '../../lib/text.js';
import type { SeeRaw } from './crawler.js';

/** SEE lists people as "Last, First" -> "First Last" */
const flipName = (n: string) => (/^[^,]+,\s*[^,]+$/.test(n) ? n.split(',').map((s) => s.trim()).reverse().join(' ') : n);

export function cleanSee(items: SeeRaw[], scrapedAt: string): Course[] {
  return items.map((r) =>
    makeCourse(
      { school: 'stanford', title: cleanText(r.title) ?? r.code, url: r.url, platform: 'Stanford Engineering Everywhere', sourceId: r.code, scrapedAt },
      {
        provider: 'Stanford Engineering Everywhere',
        description: cleanText(r.description),
        instructors: uniq(r.instructors.map(flipName)),
        subjects: uniq([r.category]),
        courseCode: r.externalUrl ? null : cleanText(r.code),
        languages: ['English'],
        // SEE: free online courses (lectures, handouts, assignments, exams) — see.stanford.edu
        isFree: true,
        price: 0,
        pace: 'self-paced',
        status: 'active',
      },
    ),
  );
}

if (isMain(import.meta.url)) {
  const raw = await loadRaw('stanford');
  await writeClean('stanford', [
    ...cleanSee((raw.sources['see.stanford.edu'] ?? []) as SeeRaw[], raw.scrapedAt),
    ...((raw.sources['coursera'] ?? []) as CourseraRaw[]).map((r) => normalizeCoursera('stanford', r, raw.scrapedAt)),
    ...((raw.sources['edx'] ?? []) as EdxRecord[]).map((r) => normalizeEdx('stanford', r, raw.scrapedAt)),
  ]);
}
