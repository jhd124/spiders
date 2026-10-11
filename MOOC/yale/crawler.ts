/**
 * Yale — two public sources:
 *  1. Open Yale Courses (free recorded Yale College lectures): https://oyc.yale.edu/courses
 *     The list page is one HTML table; each course page adds the "About the Course" text.
 *  2. Yale on Coursera: https://www.coursera.org/partners/yale (see lib/coursera.ts)
 * Run: npm run crawl:yale   (add --no-details to skip per-course pages)
 */
import { isMain } from '../../lib/main.js';
import * as cheerio from 'cheerio';
import { politeFetch } from '../../lib/http.js';
import { runSources } from '../../lib/io.js';
import { crawlCourseraPartner } from '../../lib/coursera.js';

const OYC = 'https://oyc.yale.edu';

export interface OycRaw {
  url: string;
  department: string | null;
  courseNumber: string | null;
  title: string;
  professor: string | null;
  semester: string | null;
  about: string | null;
  professorDetail: string | null;
}

const txt = (s: string) => s.replace(/\s+/g, ' ').trim() || null;

export async function crawlOyc(details = !process.argv.includes('--no-details')): Promise<OycRaw[]> {
  const $ = cheerio.load(await politeFetch(`${OYC}/courses`));
  const rows: OycRaw[] = [];
  $('table.views-table tbody tr').each((_, tr) => {
    const td = (cls: string) => $(tr).find(`td.${cls}`);
    const titleA = td('views-field-title-1').find('a').first();
    const href = titleA.attr('href');
    if (!href) return;
    rows.push({
      url: new URL(href, OYC).href,
      department: txt(td('views-field-title').text()),
      courseNumber: txt(td('views-field-field-course-number').text()),
      title: txt(titleA.text()) ?? '',
      professor: txt(td('views-field-field-course-professor-last-name').text()),
      semester: txt(td('views-field-field-semester').text()),
      about: null,
      professorDetail: null,
    });
  });
  if (details) {
    for (const r of rows) {
      try {
        const d = cheerio.load(await politeFetch(r.url));
        const about = d('#quicktabs-tabpage-course_quicktabs-0 .views-field-body .field-content').first();
        about.find('em').remove(); // drop "Please note: captured in 2010" style notes
        r.about = txt(about.text());
        r.professorDetail = txt(d('.views-field-field-course-professor-last-name .field-content').first().text());
      } catch (err) {
        console.warn(`[yale] detail failed ${r.url}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return rows;
}

if (isMain(import.meta.url)) {
  await runSources('yale', {
    'oyc.yale.edu': () => crawlOyc(),
    coursera: () => crawlCourseraPartner('yale'),
  });
}
