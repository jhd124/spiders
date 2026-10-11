/**
 * Cornell — public MOOC listings:
 *  - edX school page https://www.edx.org/school/cornellx (records owned by CornellX)
 * Run: npm run crawl:cornell
 */
import { isMain } from '../../lib/main.js';
import { runSources } from '../../lib/io.js';
import { crawlEdxSchool } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  await runSources('cornell', {
    edx: () => crawlEdxSchool('cornellx', 'CornellX'),
  });
}
