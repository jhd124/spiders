/**
 * 《职业分类大典（2022年版）》分类体系表: download the PDF and dump positioned text runs
 * (page, x, y, text) to data/raw/career-occupations.json; the table layout is rebuilt in clean.ts.
 *   npm run crawl:career-occupations [-- --file=osta-occupation-2022-table=/path/to/official.pdf]
 */
import { runSources } from '../../lib/io.js';
import { pdfItems } from '../../lib/pdf.js';
import { isMain } from '../../lib/main.js';
import { OCCUPATION_TABLE } from '../sources.js';
import { fetchDoc } from '../fetchdoc.js';

export const RAW_NAME = 'career-occupations';

export async function crawl() {
  return runSources(RAW_NAME, {
    [OCCUPATION_TABLE.id]: async () => {
      const { meta, data } = await fetchDoc(OCCUPATION_TABLE);
      const { pages, items } = await pdfItems(data);
      console.log(`[${RAW_NAME}] ${meta.bytes} bytes, ${pages} pages, ${items.length} text runs from ${meta.fetched_url}`);
      return [{ ...meta, pages, items: items.map((i) => [i.page, i.x, i.y, i.str]) }];
    },
  });
}

if (isMain(import.meta.url)) {
  const dump = await crawl();
  if (dump.errors) process.exit(1);
}
