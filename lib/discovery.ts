/**
 * Discover crawler groups from the filesystem:
 *   <GROUP>/<name>/crawler.ts   -> a crawler (required)
 *   <GROUP>/<name>/clean.ts     -> its cleaning step (optional)
 *   <GROUP>/ingest.ts           -> group ingest, accepts crawler names as args (optional)
 *   <GROUP>/dataset.ts          -> query config for the web UI (optional, default export DatasetConfig or DatasetConfig[])
 *   <GROUP>/migrate.ts          -> schema migrations (optional, exports migrate()); run on web server start
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './io.js';

export interface CrawlerInfo {
  group: string;
  name: string;
  /** paths relative to repo root */
  crawlerFile: string;
  cleanFile: string | null;
}
export interface GroupInfo {
  name: string;
  crawlers: CrawlerInfo[];
  ingestFile: string | null;
  datasetFile: string | null;
  migrateFile: string | null;
}

const SKIP = new Set(['node_modules', 'lib', 'scripts', 'web', 'data', 'dist']);

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function discoverGroups(root = ROOT): GroupInfo[] {
  const groups: GroupInfo[] = [];
  for (const g of readdirSync(root).sort()) {
    if (g.startsWith('.') || SKIP.has(g) || !isDir(join(root, g))) continue;
    const crawlers: CrawlerInfo[] = [];
    for (const n of readdirSync(join(root, g)).sort()) {
      const dir = join(root, g, n);
      if (n.startsWith('.') || !isDir(dir) || !existsSync(join(dir, 'crawler.ts'))) continue;
      crawlers.push({
        group: g,
        name: n,
        crawlerFile: `${g}/${n}/crawler.ts`,
        cleanFile: existsSync(join(dir, 'clean.ts')) ? `${g}/${n}/clean.ts` : null,
      });
    }
    if (!crawlers.length) continue;
    groups.push({
      name: g,
      crawlers,
      ingestFile: existsSync(join(root, g, 'ingest.ts')) ? `${g}/ingest.ts` : null,
      datasetFile: existsSync(join(root, g, 'dataset.ts')) ? `${g}/dataset.ts` : null,
      migrateFile: existsSync(join(root, g, 'migrate.ts')) ? `${g}/migrate.ts` : null,
    });
  }
  return groups;
}
