/** UPenn raw -> Course[]. Run: npm run clean:upenn */
import { isMain } from '../../lib/main.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { normalizeCoursera, type CourseraRaw } from '../../lib/coursera.js';
import { normalizeEdx, type EdxRecord } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  const raw = await loadRaw('upenn');
  await writeClean('upenn', [
    ...((raw.sources['coursera'] ?? []) as CourseraRaw[]).map((r) => normalizeCoursera('upenn', r, raw.scrapedAt)),
    ...((raw.sources['edx'] ?? []) as EdxRecord[]).map((r) => normalizeEdx('upenn', r, raw.scrapedAt)),
  ]);
}
