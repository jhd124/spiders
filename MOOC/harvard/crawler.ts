/**
 * Harvard — official catalog of free courses: https://pll.harvard.edu/catalog/free
 * (Harvard Online Learning / "Professional & Lifelong Learning"). Server-rendered Drupal view,
 * paginated via rel="next". Each teaser card carries a hidden `.datalayer-values` element with
 * structured attributes (platform, school, price, pace, difficulty, language…), which we keep as-is.
 * Run: npm run crawl:harvard
 */
import { isMain } from '../../lib/main.js';
import * as cheerio from 'cheerio';
import { politeFetch } from '../../lib/http.js';
import { runSources } from '../../lib/io.js';

const START = 'https://pll.harvard.edu/catalog/free';

export interface HarvardRaw {
  url: string;
  title: string;
  summary: string | null;
  subjects: string[];
  modality: string | null;
  priceText: string | null;
  durationText: string | null;
  registrationText: string | null;
  imageUrl: string | null;
  /** all data-* attributes of .datalayer-values, without the "data-" prefix */
  datalayer: Record<string, string>;
  /** from the course page (null when --no-details) */
  description: string | null;
  instructors: string[];
  /** "Learn More" link to the hosting platform (edX etc.) */
  externalUrl: string | null;
}

const txt = (s: string) => s.replace(/\s+/g, ' ').trim() || null;

export async function crawlHarvard(
  maxPages = 50,
  details = !process.argv.includes('--no-details'),
): Promise<HarvardRaw[]> {
  const out: HarvardRaw[] = [];
  let url: string | null = START;
  for (let page = 0; url && page < maxPages; page++) {
    const html = await politeFetch(url);
    const $ = cheerio.load(html);
    $('article.content-type--course-instance').each((_, el) => {
      const a = $(el);
      const link = a.find('.field--name-title a').first();
      const href = link.attr('href');
      if (!href) return;
      const dl: Record<string, string> = {};
      const dlEl = a.find('.datalayer-values').get(0) as { attribs?: Record<string, string> } | undefined;
      for (const [k, v] of Object.entries(dlEl?.attribs ?? {})) if (k.startsWith('data-')) dl[k.slice(5)] = v.trim();
      const img = a.find('.field--name-field-media img').attr('src');
      out.push({
        url: new URL(href, START).href,
        title: txt(link.text()) ?? '',
        summary: txt(a.find('.field--name-field-summary').text()),
        subjects: a.find('.topics--teaser a').map((_, s) => $(s).text().trim()).get(),
        modality: txt(a.find('.field--name-field-modality').text()),
        priceText: txt(a.find('.field--name-extra-field-pll-extra-field-price .field__item').text()),
        durationText: txt(a.find('.field--name-extra-field-pll-extra-field-duration .field__item').text()),
        registrationText: txt(a.find('.field--name-extra-field-pll-extra-field-registration-date .field__item').text()),
        imageUrl: img ? new URL(img, START).href : null,
        datalayer: dl,
        description: null,
        instructors: [],
        externalUrl: null,
      });
    });
    const next = $('a[rel="next"]').attr('href');
    url = next ? new URL(next, url).href : null;
    console.log(`[harvard] page ${page + 1}: total ${out.length}`);
  }
  if (details) {
    for (const [i, r] of out.entries()) {
      try {
        const $ = cheerio.load(await politeFetch(r.url));
        const body = $('.group-course-description .field--name-body').first();
        body.find('.field__label').remove(); // "Course description" heading
        r.description = txt(body.text());
        r.instructors = $('.field--name-field-faculty .content-type--faculty .field--name-title')
          .map((_, el) => $(el).text().trim())
          .get()
          .filter(Boolean);
        const more = $('a').filter((_, a) => /learn more/i.test($(a).text()) && /^https?:/.test($(a).attr('href') ?? '')).first();
        r.externalUrl = more.attr('href') ?? null;
      } catch (err) {
        console.warn(`[harvard] detail failed ${r.url}: ${err instanceof Error ? err.message : err}`);
      }
      if ((i + 1) % 25 === 0) console.log(`[harvard] details ${i + 1}/${out.length}`);
    }
  }
  return out;
}

if (isMain(import.meta.url)) {
  await runSources('harvard', { 'pll.harvard.edu': () => crawlHarvard() });
}
