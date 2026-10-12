/** MIT raw (OpenCourseWare + MITx, both from MIT Learn) -> Course[]. Run: npm run clean:mit */
import { isMain } from '../../lib/main.js';
import { makeCourse, type Course } from '../schema.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { cleanText, uniq } from '../../lib/text.js';
import type { OcwRaw } from './crawler.js';

/** "Prof. George Haller" -> "George Haller" */
const stripTitle = (n: string) => n.replace(/^(Prof\.|Professor|Dr\.)\s+/i, '');

export function cleanLearn(items: OcwRaw[], platform: 'MIT OpenCourseWare' | 'MITx', scrapedAt: string): Course[] {
  return items
    .filter((r) => r.url && r.title)
    .map((r) =>
      makeCourse(
        { school: 'mit', title: cleanText(r.title) ?? r.readable_id, url: r.url, platform, sourceId: r.readable_id, scrapedAt },
        {
          provider: platform === 'MITx' ? (r.platformName ?? 'MITx') : uniq(r.departments).join(', ') || 'MIT OpenCourseWare',
          description: cleanText(r.description),
          instructors: uniq(r.instructors.map(stripTitle)),
          subjects: uniq(r.topics),
          tags: uniq([...r.ocw_topics, ...r.course_feature]),
          courseCode: r.course_numbers.join(', ') || null,
          // OCW levels are Undergraduate / Graduate / High School, which don't map onto the schema's difficulty enum
          level: null,
          languages: uniq(r.languages ?? []),
          isFree: r.free,
          price: r.free ? 0 : null,
          pace: r.pace.includes('self_paced') ? 'self-paced' : null,
          termText: [r.semester, r.year, r.level.length ? `(${r.level.join('/')})` : null].filter(Boolean).join(' ') || null,
          status: r.availability === 'anytime' ? 'active' : null,
          imageUrl: r.image,
        },
      ),
    );
}

if (isMain(import.meta.url)) {
  const raw = await loadRaw('mit');
  await writeClean('mit', [
    ...cleanLearn((raw.sources['ocw'] ?? []) as OcwRaw[], 'MIT OpenCourseWare', raw.scrapedAt),
    ...cleanLearn((raw.sources['mitx'] ?? []) as OcwRaw[], 'MITx', raw.scrapedAt),
  ]);
}
