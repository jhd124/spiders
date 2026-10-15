import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.SPIDERS_DATA_DIR ?? join(ROOT, 'data');
export const RAW_DIR = join(DATA_DIR, 'raw');
export const CLEAN_DIR = join(DATA_DIR, 'clean');

/** Raw dump written by every crawler: one array of untouched records per source. */
export interface RawDump {
  school: string;
  scrapedAt: string;
  sources: Record<string, unknown[]>;
  errors?: Record<string, string>;
}

export const rawPath = (school: string) => join(RAW_DIR, `${school}.json`);
export const cleanPath = (school: string) => join(CLEAN_DIR, `${school}.json`);

export async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** Run each named source; a failing source is logged and recorded instead of aborting the whole crawl. */
export async function runSources(
  school: string,
  sources: Record<string, () => Promise<unknown[]>>,
): Promise<RawDump> {
  const { withCrawlRun } = await import('./crawllog.js');
  return withCrawlRun(school, async (run) => {
    const dump: RawDump = { school, scrapedAt: new Date().toISOString(), sources: {} };
    for (const [name, fn] of Object.entries(sources)) {
      try {
        const items = await fn();
        dump.sources[name] = items;
        for (const it of items) run.record(it, 'fetched', { source: name });
        console.log(`[${school}] ${name}: ${items.length} records`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${school}] ${name} failed: ${msg}`);
        run.fail(msg, { source: name });
        (dump.errors ??= {})[name] = msg;
        dump.sources[name] = [];
      }
    }
    await writeJson(rawPath(school), dump);
    console.log(`[${school}] raw -> ${rawPath(school)}`);
    return dump;
  });
}
