/** Yale raw (Open Yale Courses + Coursera) -> Course[]. Run: npm run clean:yale */
import { isMain } from '../../lib/main.js';
import { makeCourse, type Course } from '../schema.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { normalizeCoursera, type CourseraRaw } from '../../lib/coursera.js';
import { cleanText, uniq } from '../../lib/text.js';
import type { OycRaw } from './crawler.js';

export function cleanOyc(items: OycRaw[], scrapedAt: string): Course[] {
  return items.map((r) => {
    const path = new URL(r.url).pathname.replace(/^\//, '');
    const year = /\b(19|20)\d{2}\b/.exec(r.semester ?? '')?.[0];
    return makeCourse(
      { school: 'yale', title: cleanText(r.title) ?? path, url: r.url, platform: 'Open Yale Courses', sourceId: path, scrapedAt },
      {
        provider: 'Open Yale Courses',
        description: cleanText(r.about),
        instructors: uniq([r.professor]),
        subjects: uniq([r.department]),
        courseCode: cleanText(r.courseNumber),
        languages: ['English'],
        // oyc.yale.edu: "Open Yale Courses provides free and open access to a selection of introductory courses"
        isFree: true,
        price: 0,
        pace: 'self-paced',
        termText: cleanText(r.semester) ?? (year ?? null),
        status: 'active', // recorded lectures, available any time
      },
    );
  });
}

if (isMain(import.meta.url)) {
  const raw = await loadRaw('yale');
  await writeClean('yale', [
    ...cleanOyc((raw.sources['oyc.yale.edu'] ?? []) as OycRaw[], raw.scrapedAt),
    ...((raw.sources['coursera'] ?? []) as CourseraRaw[]).map((r) => normalizeCoursera('yale', r, raw.scrapedAt)),
  ]);
}
