/**
 * Stanford — public free course listings:
 *  1. Stanford Engineering Everywhere (official, free CC-licensed courses): https://see.stanford.edu/Course
 *     + each /Course/<code> page for description & instructor.
 *  2. Coursera partner page https://www.coursera.org/partners/stanford (+ each /learn/<slug> page)
 *  3. edX school page https://www.edx.org/school/stanfordonline (records owned by StanfordOnline)
 *
 * TODO: Stanford Online's own catalog (https://online.stanford.edu/free-courses) answers 403 to
 * non-browser clients (even /robots.txt) for our honest bot User-Agent. We don't spoof a browser UA,
 * so it is not crawled; revisit if they publish a feed/API or allow-list bots.
 *
 * Run: npm run crawl:stanford   (add --no-details to skip per-course pages)
 */
import { isMain } from '../../lib/main.js';
import * as cheerio from 'cheerio';
import { politeFetch } from '../../lib/http.js';
import { runSources } from '../../lib/io.js';
import { crawlCourseraPartner } from '../../lib/coursera.js';
import { crawlEdxSchool } from '../../lib/edx.js';

const SEE = 'https://see.stanford.edu';

export interface SeeRaw {
  url: string;
  code: string;
  title: string;
  category: string | null;
  instructorListed: string | null;
  description: string | null;
  instructors: string[];
  externalUrl: string | null;
}

const txt = (s: string | undefined | null): string | null => (s ?? '').replace(/\s+/g, ' ').trim() || null;

export async function crawlSee(details = !process.argv.includes('--no-details')): Promise<SeeRaw[]> {
  const $ = cheerio.load(await politeFetch(`${SEE}/Course`));
  const out: SeeRaw[] = [];
  // <div class="heading"><h2>Category</h2></div> followed by <ul class="channels-overview-list"><li>…</li></ul>
  $('ul.channels-overview-list').each((_, ul) => {
    const category = txt($(ul).prevAll('.heading').first().find('h2').text());
    $(ul).children('li').each((_, li) => {
      const a = $(li).find('.channel-overview-title a').first();
      const href = a.attr('href');
      if (!href) return;
      const details = $(li).find('.channel-overview-details li').map((_, x) => txt($(x).text())).get();
      const abs = new URL(href, SEE).href;
      const ext = !abs.startsWith(SEE);
      out.push({
        url: abs,
        code: details[0] ?? href.split('/').pop() ?? href,
        title: txt(a.text().replace('⬈', '')) ?? '',
        category,
        instructorListed: details[1] ?? null,
        description: null,
        instructors: details[1] ? [details[1]] : [],
        externalUrl: ext ? abs : null,
      });
    });
  });
  if (details) {
    for (const r of out) {
      if (r.externalUrl) continue; // Intro to Logic lives on another site (not CC licensed, see SEE note)
      try {
        const d = cheerio.load(await politeFetch(r.url));
        const panel = (name: RegExp) =>
          d('.panel').filter((_, el) => name.test(d(el).find('.panel-heading').first().text())).first();
        r.description = txt(panel(/course description/i).find('.panel-content').first().text());
        const name = txt(panel(/^\s*instructors?\s*$/i).find('.media p').first().text());
        if (name) r.instructors = [name];
      } catch (err) {
        console.warn(`[stanford] SEE detail failed ${r.url}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return out;
}

if (isMain(import.meta.url)) {
  await runSources('stanford', {
    'see.stanford.edu': () => crawlSee(),
    coursera: () => crawlCourseraPartner('stanford'),
    edx: () => crawlEdxSchool('stanfordonline', 'StanfordOnline'),
  });
}
