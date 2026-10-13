/**
 * Deterministic parsers for course tables whose rows carry a course code (no LLM call):
 *  - hitwh: 哈工大（威海） "六、课程体系及学分分布": `22WHCS22004 | 数据结构与算法 | 3.5 | 56 | 2秋` under numbered category headings
 *           ("1. | 专业集群基础课程…", "2.2 | 大类专业基础限选课", "2.2.1 | 计算机学院模块"). The later 教学进程计划 repeats the rows and is skipped.
 *  - upc:   中国石油大学（华东） "六、课程设置": the Chinese name sits on its own line(s) above the code row, the English name below,
 *           vertical category labels are interleaved as fragments ("通识 | 思政", "教育 | 类课"). Category labels are not reconstructed;
 *           必修/选修 comes from the course code (8th character: 1 = 必修, 2 = 选修), the A–D direction letter goes to module.
 * Returned rows are table facts (core_in_section=false); the 核心课程 section is still extracted separately.
 */
import type { ExtractedCourse } from './schema.js';
import type { PageText } from './text.js';

export type CodeTableLayout = 'hitwh' | 'upc';
export interface CodeTable { layout: CodeTableLayout; courses: ExtractedCourse[] }

const HIT_CODE = /^\d{2}WH[A-Z]{2}\d{5,6}$/;
const UPC_CODE = /^[A-Z]{3}\d{9}$/;
const HAN = /\p{Script=Han}/u;
const NUM = /^\d+(\.\d+)?$/;
const n = (s: string | undefined) => (s !== undefined && NUM.test(s.trim()) ? Number(s) : null);
const cellsOf = (l: string) => l.split(' | ').map((c) => c.trim());

interface Line { page: number; text: string }
const linesOf = (pages: PageText[]): Line[] => pages.flatMap((p) => p.text.split('\n').map((text) => ({ page: p.page, text })));

const row = (name: string, x: Partial<ExtractedCourse> & { page: number; snippet: string }): ExtractedCourse => ({
  name, course_type: null, block: null, module: null, core_in_section: false, credits: null, hours: null, semester: null, confidence: 0.95, ...x,
});

export function detectLayout(pages: PageText[]): CodeTableLayout | null {
  let hit = 0, upc = 0;
  for (const l of linesOf(pages)) {
    const c = cellsOf(l.text);
    if (HIT_CODE.test(c[0]!)) hit++;
    if (c.some((x) => UPC_CODE.test(x))) upc++;
  }
  return hit >= 15 ? 'hitwh' : upc >= 15 ? 'upc' : null;
}

export function parseCodeTable(pages: PageText[]): CodeTable | null {
  const layout = detectLayout(pages);
  if (!layout) return null;
  const courses = layout === 'hitwh' ? parseHitwh(linesOf(pages)) : parseUpc(linesOf(pages));
  return courses.length ? { layout, courses } : null;
}

function parseHitwh(ls: Line[]): ExtractedCourse[] {
  const start = ls.findIndex((l) => /^\s*[一二三四五六七八九十]+、\s*课程体系/.test(l.text));
  const end = ls.findIndex((l, i) => i > start && /教学进程计划/.test(l.text));
  const out: ExtractedCourse[] = [];
  let top: string | null = null, block: string | null = null, sub: string | null = null, module: string | null = null;
  for (const l of ls.slice(Math.max(0, start), end > 0 ? end : undefined)) {
    const t = l.text.trim();
    const top1 = t.match(/^[（(][一二三四五六七八九十]+[)）]\s*(.+)$/);
    if (top1) { top = top1[1]!.trim(); block = sub = module = null; continue; }
    const h = t.match(/^(\d+(?:\.\d+)*)\.?\s*\|\s*([^|]+)$/);
    if (h && HAN.test(h[2]!)) {
      const depth = h[1]!.split('.').filter(Boolean).length;
      const name = h[2]!.trim();
      if (depth === 1) { block = name; sub = module = null; } else if (depth === 2) { sub = name; module = null; } else module = name;
      continue;
    }
    const c = cellsOf(t);
    if (!HIT_CODE.test(c[0]!)) continue;
    const ci = c.findIndex((x, i) => i >= 2 && NUM.test(x));
    if (ci < 0) continue;
    const name = c.slice(1, ci).join('');
    if (!HAN.test(name)) continue;
    const cat = sub ?? block ?? top;
    const course_type = /限选/.test(cat ?? '') ? '限选' : /选修/.test(cat ?? '') ? '任选' : '必修';
    out.push(row(name, { block: cat, module, course_type, credits: n(c[ci]), hours: n(c[ci + 1]), semester: c[ci + 2] && /[春秋夏]/.test(c[ci + 2]!) ? c[ci + 2]! : null, page: l.page, snippet: t.slice(0, 80) }));
  }
  return out;
}

/** vertical category-label fragments of the UPC table (never course names on their own) */
const UPC_LABELS = new Set(['通识', '教育', '课程', '思政', '类课', '程', '基础', '素养', '大类', '专业', '必修', '选修', '国际', '自主', '发展', '跨学', '科课', '第二', '课堂', '活动', '修读说明', '续表', '算法', '类', '应用', '双语']);
const isNoise = (c: string) => !c || UPC_LABELS.has(c) || /^[\d，,、\s\-≥周S]+$/.test(c) || !HAN.test(c);
const isEnglish = (l: string) => !HAN.test(l) && /[A-Za-z]{2}/.test(l);
const isHeader = (l: string) => /^(课程 \| 课程|课程编码|类别 \| 模块|续表)/.test(l) || /培养方案$|学院$|^·\s*\d+\s*·$/.test(l);
/** "数据结构Data Structure" -> 数据结构 + English tail (the f4 layout prints both names in one cell); "数据分析（Python）" is not split */
export function splitEnglish(cell: string): { han: string; en: string } {
  if (!HAN.test(cell)) return { han: '', en: cell };
  const m = cell.match(/^(.*[\p{Script=Han}）)])\s*([A-Z][a-z]+(?:\s.*)?)$/u);
  return m && !HAN.test(m[2]!) && !/[（(]$/.test(m[1]!) ? { han: m[1]!, en: m[2]! } : { han: cell, en: '' };
}
const isProse = (c: string) => /[，；：。≥]|学分|修读/.test(c);

function parseUpc(ls: Line[]): ExtractedCourse[] {
  const start = ls.findIndex((l) => /^\s*[一二三四五六七八九十]+、\s*课程设置/.test(l.text));
  const end = ls.findIndex((l, i) => i > start && /^\s*[一二三四五六七八九十]+、/.test(l.text));
  const out: ExtractedCourse[] = [];
  let pending: string[] = [];
  let last: ExtractedCourse | null = null; // the row whose English name has not been seen yet takes trailing name pieces
  for (const l of ls.slice(Math.max(0, start + 1), end > 0 ? end : undefined)) {
    const t = l.text.trim();
    if (!t || isHeader(t)) continue;
    const c = cellsOf(t);
    const ci = c.findIndex((x) => UPC_CODE.test(x));
    if (ci >= 0) {
      for (const x of c.slice(0, ci)) if (!isNoise(x) && !isProse(x)) pending.push(splitEnglish(x).han);
      const rest = c.slice(ci + 1);
      const k = rest.findIndex((x) => NUM.test(x));
      const nums = k >= 0 ? rest.slice(k) : [];
      const code = c[ci]!;
      const pre = (k >= 0 ? rest.slice(0, k) : rest).map(splitEnglish);
      const inline = pre.map((x) => x.han).filter((x) => x && !isNoise(x)).join('');
      const dir = nums.at(-1) && /^[A-D]$/.test(nums.at(-1)!) ? nums.at(-1)! : null;
      const name = inline || pending.slice(-2).join('');
      pending = [];
      if (!name) { last = null; continue; }
      const sem = nums[7] && /^S?\d(-\d)?$/.test(nums[7]) ? nums[7] : null;
      const r = row(name, { course_type: code[7] === '2' ? '任选' : code[7] === '1' ? '必修' : null, module: dir ? `${dir}方向` : null, credits: n(nums[0]), hours: n(nums[1]), semester: sem, page: l.page, snippet: t.slice(0, 80) });
      out.push(r);
      // a row whose English name is already on the code line is complete; otherwise CJK pieces until the English line continue its name
      last = pre.some((x) => x.en) ? null : r;
      continue;
    }
    if (c.some(isEnglish)) { last = null; pending = []; continue; }
    const split = c.filter((x) => !isNoise(x)).map(splitEnglish);
    const pieces = split.map((x) => x.han).filter(Boolean);
    if (pieces.some(isProse)) { pending = []; continue; }
    if (last && pieces.length) { last.name += pieces.join(''); if (split.some((x) => x.en)) last = null; continue; } // name continued below the code row ("展史等四门课…）")
    pending.push(...pieces);
  }
  return out;
}
