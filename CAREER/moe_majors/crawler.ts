/**
 * MOE《普通高等学校本科专业目录》(latest = 2026, plus 2025 for diffing): download the official PDFs
 * and dump their text lines (page + text) to data/raw/career-moe_majors.json. Parsing happens in clean.ts.
 *   npm run crawl:career-majors [-- --file=moe-major-catalog-2026=/path/to.pdf]
 */
import { runSources } from '../../lib/io.js';
import { pdfLines } from '../../lib/pdf.js';
import { isMain } from '../../lib/main.js';
import { MOE_CATALOGS } from '../sources.js';
import { fetchDoc } from '../fetchdoc.js';

export const RAW_NAME = 'career-moe_majors';

export async function crawl() {
  const sources: Record<string, () => Promise<unknown[]>> = {};
  for (const doc of MOE_CATALOGS) {
    sources[doc.id] = async () => {
      const { meta, data } = await fetchDoc(doc);
      const { pages, lines } = await pdfLines(data);
      console.log(`[${RAW_NAME}] ${doc.id}: ${meta.bytes} bytes, ${pages} pages, ${lines.length} lines from ${meta.fetched_url}`);
      return [{ ...meta, pages, lines: lines.map((l) => [l.page, l.text]) }];
    };
  }
  return runSources(RAW_NAME, sources);
}

if (isMain(import.meta.url)) {
  const dump = await crawl();
  if (dump.errors?.['moe-major-catalog-2026']) process.exit(1);
}
