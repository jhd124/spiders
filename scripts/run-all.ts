/**
 * 一键：依次 crawl -> clean 每所学校，最后入库。
 *   npm run all                       # all 8 schools
 *   npm run all -- yale brown         # some schools
 *   npm run all -- --no-details       # faster: skip Coursera / OYC per-course pages
 * Schools run sequentially so per-host rate limits stay polite.
 */
import { spawnSync } from 'node:child_process';
import { SCHOOLS, type SchoolKey } from '../MOOC/schema.js';

const flags = process.argv.slice(2).filter((a) => a.startsWith('-'));
const picked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const schools = (picked.length ? picked : Object.keys(SCHOOLS)) as SchoolKey[];

const run = (file: string, args: string[] = []) => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', file, ...args], { stdio: 'inherit' });
  return r.status === 0;
};

const failed: string[] = [];
for (const s of schools) {
  if (!(s in SCHOOLS)) throw new Error(`unknown school ${s}`);
  if (!run(`MOOC/${s}/crawler.ts`, flags) || !run(`MOOC/${s}/clean.ts`)) failed.push(s);
}
run('MOOC/ingest.ts', schools.filter((s) => !failed.includes(s)));
if (failed.length) {
  console.error(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
