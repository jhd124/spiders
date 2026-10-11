/**
 * UPenn — public MOOC listings:
 *  - Coursera partner page https://www.coursera.org/partners/penn (+ each /learn/<slug> page)
 *  - edX school page https://www.edx.org/school/pennx (records owned by PennX)
 * Run: npm run crawl:upenn   (add --no-details to skip Coursera course pages)
 */
import { isMain } from '../../lib/main.js';
import { runSources } from '../../lib/io.js';
import { crawlCourseraPartner } from '../../lib/coursera.js';
import { crawlEdxSchool } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  await runSources('upenn', {
    coursera: () => crawlCourseraPartner('penn'),
    edx: () => crawlEdxSchool('pennx', 'PennX'),
  });
}
