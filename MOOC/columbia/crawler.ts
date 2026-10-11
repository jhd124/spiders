/**
 * Columbia — public MOOC listings:
 *  - Coursera partner page https://www.coursera.org/partners/columbia (+ each /learn/<slug> page)
 *  - edX school page https://www.edx.org/school/columbiax (records owned by ColumbiaX)
 * Run: npm run crawl:columbia   (add --no-details to skip Coursera course pages)
 */
import { isMain } from '../../lib/main.js';
import { runSources } from '../../lib/io.js';
import { crawlCourseraPartner } from '../../lib/coursera.js';
import { crawlEdxSchool } from '../../lib/edx.js';

if (isMain(import.meta.url)) {
  await runSources('columbia', {
    coursera: () => crawlCourseraPartner('columbia'),
    edx: () => crawlEdxSchool('columbiax', 'ColumbiaX'),
  });
}
