/** Dartmouth raw -> Course[]. Run: npm run clean:dartmouth */
import { isMain } from '../../lib/main.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { normalizeCoursera, type CourseraRaw } from '../../lib/coursera.js';
import { normalizeEdx, type EdxRecord } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  const raw = await loadRaw('dartmouth');
  await writeClean('dartmouth', [
    ...((raw.sources['coursera'] ?? []) as CourseraRaw[]).map((r) => normalizeCoursera('dartmouth', r, raw.scrapedAt)),
    ...((raw.sources['edx'] ?? []) as EdxRecord[]).map((r) => normalizeEdx('dartmouth', r, raw.scrapedAt)),
  ]);
}
