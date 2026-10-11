/**
 * Princeton — public MOOC listings:
 *  - Coursera partner page https://www.coursera.org/partners/princeton (+ each /learn/<slug> page)
 *  - edX school page https://www.edx.org/school/princetonx (records owned by PrincetonX)
 * Run: npm run crawl:princeton   (add --no-details to skip Coursera course pages)
 */
import { isMain } from '../../lib/main.js';
import { runSources } from '../../lib/io.js';
import { crawlCourseraPartner } from '../../lib/coursera.js';
import { crawlEdxSchool } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  await runSources('princeton', {
    coursera: () => crawlCourseraPartner('princeton'),
    edx: () => crawlEdxSchool('princetonx', 'PrincetonX'),
  });
}
