/**
 * Split a multi-major 培养方案 汇编 into major sections by headings such as
 *   计算机科学与技术专业培养方案（080901）   电子商务专业培养方案（120801）
 *   计算机科学与技术专业（菁英班）培养方案（080901）   <- class variant of the same MOE major
 * A section runs from its heading line to the next heading. Variants (菁英班/实验班/拔尖班/…) are not separate
 * MOE majors: they are reported (notes) but not extracted as the major unless no main section exists.
 */
import type { PageText } from './text.js';

export interface MajorSection {
  major_code: string;
  title: string;          // heading as printed
  major_name: string;     // name before 专业
  variant: string | null; // e.g. 菁英班, 人工智能实验班
  page_start: number;
  page_end: number;
  printed_pages: string | null; // printed page labels (·129·) when present
  pages: PageText[];
}

const HEADING = /^\s*([\u4e00-\u9fa5A-Za-z（）()]{2,40}?)专业\s*(?:[（(]([^（）()]*?(?:班|方向|实验|试点|拔尖|英才|卓越)[^（）()]*)[)）])?\s*(?:本科)?(?:人才)?培养方案\s*[（(]\s*(\d{6}[TK]{0,2})\s*[)）]\s*$/;
const VARIANT_IN_NAME = /(实验班|菁英班|拔尖班|英才班|卓越班|强基|试点班)/;

export function findSections(pages: PageText[]): MajorSection[] {
  const heads: { page: number; line: number; code: string; title: string; name: string; variant: string | null }[] = [];
  for (const p of pages) {
    p.text.split('\n').forEach((l, line) => {
      const m = l.replace(/ \| /g, '').match(HEADING);
      if (!m) return;
      let name = m[1]!.trim();
      let variant = m[2]?.trim() ?? null;
      const v = name.match(VARIANT_IN_NAME);
      if (!variant && v) { variant = v[1]!; name = name.replace(VARIANT_IN_NAME, ''); }
      heads.push({ page: p.page, line, code: m[3]!, title: l.trim(), name, variant });
    });
  }
  return heads.map((h, i) => {
    const next = heads[i + 1];
    const out: PageText[] = [];
    for (const p of pages) {
      // a next heading at the very top of a page (only a running header above it) ends this section on the page before
      const lastPage = next ? (next.line <= 2 ? next.page - 1 : next.page) : Infinity;
      if (p.page < h.page || p.page > lastPage) continue;
      const all = p.text.split('\n');
      const lines = all.slice(p.page === h.page ? h.line : 0, next && p.page === next.page ? next.line : all.length);
      if (lines.join('').trim()) out.push({ page: p.page, text: lines.join('\n') });
    }
    const printed = out.map((p) => p.text.match(/·\s*(\d+)\s*·/)?.[1]).filter(Boolean) as string[];
    return {
      major_code: h.code, title: h.title, major_name: h.name, variant: h.variant,
      page_start: out[0]?.page ?? h.page, page_end: out.at(-1)?.page ?? h.page,
      printed_pages: printed.length ? `${printed[0]}-${printed.at(-1)}` : null,
      pages: out,
    };
  });
}

/**
 * Pick the section to extract for each wanted major: the main (non-variant) section; variants are listed as notes.
 * wanted = null means every code in `pilot`.
 */
export function selectSections(sections: MajorSection[], wanted: string[] | null, pilot: Set<string>) {
  const targets = new Set(wanted ?? pilot);
  const chosen = new Map<string, MajorSection>();
  for (const s of sections) {
    if (!targets.has(s.major_code)) continue;
    const cur = chosen.get(s.major_code);
    if (!cur || (cur.variant && !s.variant)) chosen.set(s.major_code, s);
  }
  const notes = sections.map((s) => `${s.major_code}${s.variant ? `（${s.variant}）` : ''} p${s.page_start}-${s.page_end}${pilot.has(s.major_code) ? '' : ' 非试点'}${chosen.get(s.major_code) === s ? ' ✓抽取' : s.variant && chosen.has(s.major_code) ? ' 班级变体，仅记录' : ''}`);
  const missing = [...targets].filter((c) => !chosen.has(c) && wanted);
  return { chosen: [...chosen.values()], notes, missing };
}
