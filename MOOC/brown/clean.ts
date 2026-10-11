/** Brown raw -> Course[]. Run: npm run clean:brown */
import { isMain } from '../../lib/main.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { normalizeEdx, type EdxRecord } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  const raw = await loadRaw('brown');
  await writeClean('brown', [
    ...((raw.sources['edx'] ?? []) as EdxRecord[]).map((r) => normalizeEdx('brown', r, raw.scrapedAt)),
  ]);
}
