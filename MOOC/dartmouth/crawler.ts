/**
 * Dartmouth — public MOOC listings:
 *  - Coursera partner page https://www.coursera.org/partners/dartmouth (+ each /learn/<slug> page)
 *  - edX school page https://www.edx.org/school/dartmouthx (records owned by DartmouthX)
 * Run: npm run crawl:dartmouth   (add --no-details to skip Coursera course pages)
 */
import { isMain } from '../../lib/main.js';
import { runSources } from '../../lib/io.js';
import { crawlCourseraPartner } from '../../lib/coursera.js';
import { crawlEdxSchool } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  await runSources('dartmouth', {
    coursera: () => crawlCourseraPartner('dartmouth'),
    edx: () => crawlEdxSchool('dartmouthx', 'DartmouthX'),
  });
}
