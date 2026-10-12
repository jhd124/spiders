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
  if (format === 'html') {
    const $ = cheerio.load(Buffer.from(bytes).toString('utf8'));
    $('script, style, noscript, nav, header, footer').remove();
    $('br').replaceWith('\n');
    $('p, div, li, tr, h1, h2, h3, h4, h5, h6, table').each((_, el) => {
      $(el).append('\n');
    });
    $('td, th').each((_, el) => {
      $(el).append('\t');
    });
    const text = $('body').text().replace(/[ \u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return [{ page: 1, text }];
  }
  if (format === 'docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return [{ page: 1, text: r.value.replace(/\n\s*\n+/g, '\n').trim() }];
  }
  throw new Error('legacy .doc (Word 97-2003) is not supported: ask for a PDF/DOCX link, or convert and use --file');
}

/** Rough quality signal for the report: share of CJK characters and of replacement characters. */
export function textQuality(pages: PageText[]) {
  const all = pages.map((p) => p.text).join('\n');
  const cjk = (all.match(/\p{Script=Han}/gu) ?? []).length;
  const bad = (all.match(/\uFFFD/g) ?? []).length;
  return { pages: pages.length, chars: all.length, cjk, replacementChars: bad, emptyPages: pages.filter((p) => !p.text.trim()).length };
}
