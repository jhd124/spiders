/**
 * 研究生教育学科专业目录（2022年）, official MOE PDF → text lines in data/raw/gwy-grad_catalog.json (parsed in GWY/ingest.ts).
 *   npm run crawl:gwy-grad [-- --file=moe-grad-catalog-2022=/path/to.pdf]
 */
import { runSources } from '../../lib/io.js';
import { pdfLines } from '../../lib/pdf.js';
import { isMain } from '../../lib/main.js';
import { fetchDoc } from '../../CAREER/fetchdoc.js';
import { GRAD_CATALOG } from '../sources.js';

export const RAW_NAME = 'gwy-grad_catalog';

export async function crawl() {
  return runSources(RAW_NAME, {
    [GRAD_CATALOG.id]: async () => {
      const { meta, data } = await fetchDoc(GRAD_CATALOG);
      const { pages, lines } = await pdfLines(data);
      console.log(`[${RAW_NAME}] ${meta.bytes} bytes, ${pages} pages, ${lines.length} lines from ${meta.fetched_url}`);
      return [{ ...meta, pages, lines: lines.map((l) => l.text) }];
    },
  });
}

if (isMain(import.meta.url)) {
  const dump = await crawl();
  if (dump.errors) process.exit(1);
}
