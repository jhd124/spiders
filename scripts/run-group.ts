/**
 * 按分组一键跑：依次 crawl -> clean 组内每个爬虫，最后调用 <GROUP>/ingest.ts 入库。
 *   tsx scripts/run-group.ts MOOC                    # whole group
 *   tsx scripts/run-group.ts MOOC yale brown         # some crawlers
 *   tsx scripts/run-group.ts MOOC --no-details       # flags are passed to every crawler
 * Then <GROUP>/post_ingest.ts if present (CAREER: course -> skill tagging).
 * Crawlers run sequentially so per-host rate limits stay polite.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/io.js';
import { discoverGroups } from '../lib/discovery.js';

const [group, ...rest] = process.argv.slice(2);
if (!group) throw new Error('usage: run-group.ts <GROUP> [crawler...] [--flags]');
const g = discoverGroups().find((x) => x.name === group);
if (!g) throw new Error(`unknown group ${group}`);
const flags = rest.filter((a) => a.startsWith('-'));
const picked = rest.filter((a) => !a.startsWith('-'));
const unknown = picked.filter((p) => !g.crawlers.some((c) => c.name === p));
if (unknown.length) throw new Error(`unknown crawler(s) in ${group}: ${unknown.join(', ')}`);
const crawlers = g.crawlers.filter((c) => !picked.length || picked.includes(c.name));

const run = (file: string, args: string[] = []) => {
  console.log(`\n=== ${file} ${args.join(' ')}`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, file), ...args], { stdio: 'inherit', cwd: ROOT });
  return r.status === 0;
};

const ok: string[] = [];
const failed: string[] = [];
for (const c of crawlers) {
  const success = run(c.crawlerFile, flags) && (!c.cleanFile || run(c.cleanFile));
  (success ? ok : failed).push(c.name);
}
if (g.ingestFile && ok.length && existsSync(join(ROOT, g.ingestFile))) {
  if (!run(g.ingestFile, ok)) failed.push('ingest');
  // optional <GROUP>/post_ingest.ts (e.g. CAREER course -> skill tagging) runs after a successful ingest
  else if (existsSync(join(ROOT, group, 'post_ingest.ts')) && !run(join(group, 'post_ingest.ts'))) failed.push('post_ingest');
}
console.log(`\n[run-group] ${group}: ok=${ok.join(',') || '-'} failed=${failed.join(',') || '-'}`);
if (failed.length) process.exit(1);
