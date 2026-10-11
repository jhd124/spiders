/**
 * Brown — public MOOC listings:
 *  - edX school page https://www.edx.org/school/brownx (records owned by BrownX)
 * Run: npm run crawl:brown
 */
import { isMain } from '../../lib/main.js';
import { runSources } from '../../lib/io.js';
import { crawlEdxSchool } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  await runSources('brown', {
    edx: () => crawlEdxSchool('brownx', 'BrownX'),
  });
}
