/**
 * PDF helpers (pure JS via unpdf/pdf.js — no poppler needed on the server).
 *   pdfItems(): every text run with page number and x/y position (y grows upwards).
 *   pdfLines(): runs grouped into visual lines per page, left-to-right.
 */
import { getDocumentProxy } from 'unpdf';

export interface PdfItem {
  page: number;
  x: number;
  y: number;
  str: string;
  w?: number; // run width (pdf units)
}

export async function pdfItems(data: Uint8Array): Promise<{ pages: number; items: PdfItem[] }> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const items: PdfItem[] = [];
  for (let page = 1; page <= pdf.numPages; page++) {
    const tc = await (await pdf.getPage(page)).getTextContent();
    for (const it of tc.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      items.push({ page, x: Math.round(it.transform[4] * 10) / 10, y: Math.round(it.transform[5] * 10) / 10, str: it.str, w: Math.round((it.width ?? 0) * 10) / 10 });
    }
  }
  return { pages: pdf.numPages, items };
}

/** Group items into lines (same page, |dy| < tol), sorted top-to-bottom, text joined left-to-right. */
export function toLines(items: PdfItem[], tol = 3, cellSep?: string): { page: number; y: number; text: string }[] {
  const out: { page: number; y: number; text: string }[] = [];
  const byPage = new Map<number, PdfItem[]>();
  for (const it of items) (byPage.get(it.page) ?? byPage.set(it.page, []).get(it.page)!).push(it);
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const lines: { y: number; parts: PdfItem[] }[] = [];
    for (const it of byPage.get(page)!) {
      let l = lines.find((x) => Math.abs(x.y - it.y) < tol);
      if (!l) lines.push((l = { y: it.y, parts: [] }));
      l.parts.push(it);
    }
    for (const l of lines.sort((a, b) => b.y - a.y))
      out.push({ page, y: l.y, text: joinParts(l.parts.sort((a, b) => a.x - b.x), cellSep) });
  }
  return out;
}

/** Join runs of one line; with cellSep, runs separated by a visible gap (table cells) get the separator. */
function joinParts(parts: PdfItem[], cellSep?: string): string {
  if (cellSep === undefined) return parts.map((p) => p.str).join('');
  let out = '';
  let end = -Infinity;
  for (const p of parts) {
    if (out && p.w !== undefined && p.x - end > 4) out += cellSep;
    out += p.str;
    end = p.x + (p.w ?? 0);
  }
  return out;
}

export async function pdfLines(data: Uint8Array, cellSep?: string) {
  const { pages, items } = await pdfItems(data);
  return { pages, lines: toLines(items, 3, cellSep) };
}
