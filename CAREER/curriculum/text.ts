/** Text extraction with page numbers: PDF (unpdf, one entry per page), HTML (cheerio), DOCX (mammoth). */
import * as cheerio from 'cheerio';
import { pdfLines } from '../../lib/pdf.js';
import type { DocFormat } from './manifest.js';

export interface PageText {
  page: number; // 1-based PDF page; 1 for HTML/DOCX (no pagination)
  text: string;
}

export async function extractText(bytes: Uint8Array, format: DocFormat): Promise<PageText[]> {
  if (format === 'pdf') {
    const { pages, lines } = await pdfLines(bytes, ' | ');
    const out: PageText[] = [];
    for (let p = 1; p <= pages; p++) out.push({ page: p, text: lines.filter((l) => l.page === p).map((l) => l.text).join('\n') });
    return out;
  }
  if (format === 'html') return [{ page: 1, text: htmlText(bytes) }];
  if (format === 'docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return [{ page: 1, text: r.value.replace(/\n\s*\n+/g, '\n').trim() }];
  }
  throw new Error('legacy .doc (Word 97-2003) is not supported: ask for a PDF/DOCX link, or convert and use --file');
}

/** charset from <meta charset> / content-type meta (gbk/gb2312 pages are common on school sites); default utf-8 */
export function htmlCharset(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.slice(0, 4096)).toString('latin1');
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i);
  const cs = (m?.[1] ?? 'utf-8').toLowerCase();
  return /^(gb2312|gbk|gb18030)$/.test(cs) ? 'gb18030' : cs;
}

/** Main text of an HTML page. Tables are kept as one line per <tr>, cells joined by ' | ' (same row format as the PDF
 *  extractor, so table segmentation and course-row detection work unchanged); nested layout tables are flattened. */
export function htmlText(bytes: Uint8Array): string {
  let html: string;
  try { html = new TextDecoder(htmlCharset(bytes)).decode(bytes); } catch { html = Buffer.from(bytes).toString('utf8'); }
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, header, footer, iframe').remove();
  // prefer the article body of common school CMSs; fall back to <body>
  const main = ['#vsb_content', '.v_news_content', '.wp_articlecontent', '.article', '.content', 'article', 'body'].map((q) => $(q).first()).find((x) => x.length && x.text().trim().length > 200) ?? $('body');
  main.find('br').replaceWith('\n');
  main.find('tr').each((_, tr) => {
    const cells = $(tr).children('td, th').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    $(tr).replaceWith(`\n${cells.join(' | ')}\n`);
  });
  main.find('p, div, li, h1, h2, h3, h4, h5, h6, table, section').each((_, el) => { $(el).append('\n'); });
  return main.text().replace(/[ \u00a0\u3000]+/g, ' ').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Rough quality signal for the report: share of CJK characters and of replacement characters. */
export function textQuality(pages: PageText[]) {
  const all = pages.map((p) => p.text).join('\n');
  const cjk = (all.match(/\p{Script=Han}/gu) ?? []).length;
  const bad = (all.match(/\uFFFD/g) ?? []).length;
  return { pages: pages.length, chars: all.length, cjk, replacementChars: bad, emptyPages: pages.filter((p) => !p.text.trim()).length };
}
