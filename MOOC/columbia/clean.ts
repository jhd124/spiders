/** Columbia raw -> Course[]. Run: npm run clean:columbia */
import { isMain } from '../../lib/main.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { normalizeCoursera, type CourseraRaw } from '../../lib/coursera.js';
import { normalizeEdx, type EdxRecord } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  const raw = await loadRaw('columbia');
  await writeClean('columbia', [
    ...((raw.sources['coursera'] ?? []) as CourseraRaw[]).map((r) => normalizeCoursera('columbia', r, raw.scrapedAt)),
    ...((raw.sources['edx'] ?? []) as EdxRecord[]).map((r) => normalizeEdx('columbia', r, raw.scrapedAt)),
  ]);
}
