/**
 * Structure-aware chunking for 培养方案 PDFs (text from unpdf, cells joined by " | ").
 *  - findCoreSection: the "四、核心课程设置 / 主干课程 …" paragraph (up to the next 一、二、… heading)
 *  - segmentTableBlocks: the 课程设置及学时分配表 split into one chunk per 课程类别 block. A block ends at its
 *    "应修小计 / 应修说明" rows. Every chunk carries the table title + column header, and the vertical
 *    类别 label fragments (e.g. 学科/平台/基础/课程, which the PDF interleaves with rows) are collected into a
 *    label hint so the LLM can name the block for each row.
 * Pure functions (unit-tested); no LLM.
 */
import type { PageText } from './text.js';

export interface TableBlock {
  table_title: string | null; // e.g. （二）专业培养计划--专业教育课程
  label_hint: string; // concatenated 类别 fragments, e.g. 学科平台基础课程
  pages: number[];
  text: string; // with [[第N页]] markers
  header: string; // column header lines of the table
  rows: string[]; // course row lines (approximate; for counts / tests)
}

const HEADING = /^\s*[一二三四五六七八九十]+、/;
const CORE_HEADING = /^\s*[一二三四五六七八九十]+、.{0,12}?(核心课程|主干课程|核心课|学位课)/;
const TABLE_START = /课程设置及学时分配表|课程设置与学时分配表|教学进程(计划)?表|课程设置一览表/;
const TABLE_TITLE = /^\s*[（(][一二三四五六七八九十]+[）)]/;
const isFragment = (l: string) => !l.includes('|') && /^[\p{Script=Han}]{1,6}$/u.test(l.trim());
const isSubtotal = (l: string) => /^\s*(应修小计|应修说明|小计|合计)/.test(l) || /课程合计|计划合计/.test(l);
/** a course row: has cells and a credit-like number, and is not a subtotal/explanation row */
export const isCourseRow = (l: string) => l.includes('|') && /(^|\|)\s*\d+(\.\d+)?\s*(\||$)/.test(l) && !isSubtotal(l) && !/学分比例|学分数/.test(l);

interface Line { page: number; text: string }
const linesOf = (pages: PageText[]): Line[] => pages.flatMap((p) => p.text.split('\n').map((text) => ({ page: p.page, text })));

/** a sub-list label inside a section: "专业基础课程：…", "主干学科：…", "专业核心课程：…" */
const SUB_LABEL = /^\s*([\p{Script=Han}（）()]{2,16})[:：]/u;
/**
 * Expert rule: only the 核心课程 list is core. A heading that names 核心课程 wins over 主干课程/学位课 headings (主干学科 lists
 * disciplines, never courses). When the section holds labeled sub-lists ("专业基础课程：… 专业核心课程：…", "主干学科：… 专业核心课程：…"),
 * only the sub-lists whose label contains 核心 are kept (the heading line stays for context).
 */
export function findCoreSection(pages: PageText[]): { page: number; text: string } | null {
  const ls = linesOf(pages);
  let i = ls.findIndex((l) => CORE_HEADING.test(l.text) && /核心/.test(l.text));
  if (i < 0) i = ls.findIndex((l) => CORE_HEADING.test(l.text) && !/^\s*[一二三四五六七八九十]+、\s*主干学科\s*$/.test(l.text));
  if (i < 0) return null;
  const body: string[] = [];
  for (let j = i + 1; j < ls.length && !HEADING.test(ls[j]!.text) && body.length < 40; j++) body.push(ls[j]!.text);
  const labeled = body.filter((l) => SUB_LABEL.test(l) && /课程|学科|课/.test(l.match(SUB_LABEL)![1]!));
  let kept = body;
  if (labeled.length && labeled.some((l) => /核心/.test(l.match(SUB_LABEL)![1]!))) {
    kept = [];
    let keep = false;
    for (const l of body) {
      const m = l.match(SUB_LABEL);
      if (m && /课程|学科|课/.test(m[1]!)) keep = /核心/.test(m[1]!);
      if (keep) kept.push(l);
    }
  }
  return { page: ls[i]!.page, text: [ls[i]!.text, ...kept].join('\n') };
}

export function segmentTableBlocks(pages: PageText[]): TableBlock[] {
  const ls = linesOf(pages);
  const start = ls.findIndex((l) => TABLE_START.test(l.text));
  if (start < 0) return [];
  const blocks: TableBlock[] = [];
  let title: string | null = null;
  let header: string[] = [];
  let inHeader = false;
  let cur: { lines: Line[]; rows: string[]; frags: string[]; closed: boolean } | null = null;
  const flush = () => {
    if (cur && cur.rows.length) {
      const pagesUsed = [...new Set(cur.lines.map((l) => l.page))];
      let text = '', lastPage = -1;
      for (const l of cur.lines) {
        if (l.page !== lastPage) { text += `[[第${l.page}页]]\n`; lastPage = l.page; }
        text += l.text + '\n';
      }
      blocks.push({ table_title: title, label_hint: cur.frags.join(''), pages: pagesUsed, text, header: header.join('\n'), rows: cur.rows });
    }
    cur = null;
  };
  for (let i = start + 1; i < ls.length; i++) {
    const l = ls[i]!;
    const t = l.text.trim();
    // strip a leading vertical-label fragment cell ("业 | 应修小计 | 4") before classifying the line
    const lead0 = t.split('|')[0]!.trim();
    const bare = t.includes('|') && /^[\p{Script=Han}]{1,6}$/u.test(lead0) && !/^(应修|小计|合计)/.test(lead0) ? t.slice(t.indexOf('|') + 1).trim() : t;
    if (HEADING.test(t)) break; // 十一、… : end of the course table
    if (TABLE_TITLE.test(t)) { flush(); title = t; header = []; inHeader = true; continue; }
    if (inHeader) {
      if (isCourseRow(t)) inHeader = false;
      else { header.push(t); continue; }
    }
    if (isCourseRow(t) && isCourseRow(bare)) {
      if (!cur || cur.closed) { flush(); cur = { lines: [], rows: [], frags: [], closed: false }; }
      cur.rows.push(t);
      cur.lines.push(l);
      const lead = t.split('|')[0]!.trim();
      if (/^[\p{Script=Han}]{1,6}$/u.test(lead) && bare !== t) cur.frags.push(lead);
      continue;
    }
    if (!cur) { cur = { lines: [], rows: [], frags: [], closed: false }; }
    cur.lines.push(l);
    if (isFragment(t) && !/^(应修|小计|合计)/.test(t)) cur.frags.push(t);
    else if (bare !== t) cur.frags.push(lead0);
    if (/^\s*(应修小计|小计)/.test(bare)) cur.closed = true;
  }
  flush();
  return blocks;
}
