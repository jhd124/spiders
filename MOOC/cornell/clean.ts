/** Cornell raw -> Course[]. Run: npm run clean:cornell */
import { isMain } from '../../lib/main.js';
import { loadRaw, writeClean } from '../../lib/finalize.js';
import { normalizeEdx, type EdxRecord } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  const raw = await loadRaw('cornell');
  await writeClean('cornell', [
    ...((raw.sources['edx'] ?? []) as EdxRecord[]).map((r) => normalizeEdx('cornell', r, raw.scrapedAt)),
  ]);
}
