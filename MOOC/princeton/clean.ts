/** Princeton raw -> Course[]. Run: npm run clean:princeton */
import { isMain } from '../../lib/main.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { normalizeCoursera, type CourseraRaw } from '../../lib/coursera.js';
import { normalizeEdx, type EdxRecord } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  const raw = await loadRaw('princeton');
  await writeClean('princeton', [
    ...((raw.sources['coursera'] ?? []) as CourseraRaw[]).map((r) => normalizeCoursera('princeton', r, raw.scrapedAt)),
    ...((raw.sources['edx'] ?? []) as EdxRecord[]).map((r) => normalizeEdx('princeton', r, raw.scrapedAt)),
  ]);
}
