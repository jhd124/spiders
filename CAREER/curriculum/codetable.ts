/**
 * Deterministic parsers for course tables whose rows carry a course code (no LLM call):
 *  - hitwh: 哈工大（威海） "六、课程体系及学分分布": `22WHCS22004 | 数据结构与算法 | 3.5 | 56 | 2秋` under numbered category headings
 *           ("1. | 专业集群基础课程…", "2.2 | 大类专业基础限选课", "2.2.1 | 计算机学院模块"). The later 教学进程计划 repeats the rows and is skipped.
 *  - upc:   中国石油大学（华东） "六、课程设置": the Chinese name sits on its own line(s) above the code row, the English name below,
 *           vertical category labels are interleaved as fragments ("通识 | 思政", "教育 | 类课"). Category labels are not reconstructed;
 *           必修/选修 from the table's own 类别 column (see parseUpc), the course code only as a cross-check.
 * Returned rows are table facts (core_in_section=false); the 核心课程 section is still extracted separately.
 */
import type { ExtractedCourse } from './schema.js';
import type { PageText } from './text.js';

export type CodeTableLayout = 'hitwh' | 'upc';
export interface CodeTable { layout: CodeTableLayout; courses: ExtractedCourse[]; warnings: string[] }

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
  const warnings: string[] = [];
  const courses = layout === 'hitwh' ? parseHitwh(linesOf(pages)) : parseUpc(linesOf(pages), warnings);
  return courses.length ? { layout, courses, warnings } : null;
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

type Kind = '必修' | '选修';
const KIND = (c: string): Kind | null => (c === '必修' || c === '选修' ? c : null);

/**
 * UPC 课程类别/模块 columns are printed vertically ("专业 / 必修 / 课程"), once per block, so the text layer has the 必修/选修 word
 * next to only one row of each block. Expert rule (2026-10-13): the column decides; the course code (8th char 1/2) is a cross-check.
 *  - a row whose own record lines carry 必修/选修 takes it directly
 *  - other rows take the label of the surrounding anchors; between a 必修 and a 选修 anchor the boundary is placed where the code flips
 *  - rows before any anchor are the 通识/大类基础 blocks, which carry no 必修/选修 word (required) -> the next anchor (必修)
 *  - a direct label that contradicts the code -> warning (label wins)
 * 选修 -> 任选. The A–D 方向 letter ("建议从A软件架构、B网络规划…中选择一个方向") goes to module as a note, never 限选.
 */
function parseUpc(ls: Line[], warnings: string[]): ExtractedCourse[] {
  const start = ls.findIndex((l) => /^\s*[一二三四五六七八九十]+、\s*课程设置/.test(l.text));
  const end = ls.findIndex((l, i) => i > start && /^\s*[一二三四五六七八九十]+、/.test(l.text));
  const region = ls.slice(Math.max(0, start + 1), end > 0 ? end : undefined);
  const dirNames = new Map<string, string>();
  const advice = region.map((l) => l.text).join('').replace(/\s+/g, '').match(/建议从(.+?)中选择/);
  if (advice) for (const m of advice[1]!.matchAll(/([A-D])([^、，A-D]{2,10})/g)) dirNames.set(m[1]!, m[2]!);
  const out: ExtractedCourse[] = [];
  const codes: string[] = [];
  const own: (Kind | null)[] = [];
  let pending: string[] = [];
  let pendingKind: Kind | null = null;
  let last: ExtractedCourse | null = null; // the row whose English name has not been seen yet takes trailing name pieces / labels
  const labelOf = (c: string[]) => c.map(KIND).find(Boolean) ?? null;
  for (const l of region) {
    const t = l.text.trim();
    if (!t || isHeader(t)) continue;
    const c = cellsOf(t);
    const ci = c.findIndex((x) => UPC_CODE.test(x));
    if (ci >= 0) {
      for (const x of c.slice(0, ci)) if (!isNoise(x) && !isProse(x)) pending.push(splitEnglish(x).han);
      const kind = labelOf(c) ?? pendingKind;
      const rest = c.slice(ci + 1);
      const k = rest.findIndex((x) => NUM.test(x));
      const nums = k >= 0 ? rest.slice(k) : [];
      const code = c[ci]!;
      const pre = (k >= 0 ? rest.slice(0, k) : rest).map(splitEnglish);
      const inline = pre.map((x) => x.han).filter((x) => x && !isNoise(x)).join('');
      const dir = nums.at(-1) && /^[A-D]$/.test(nums.at(-1)!) ? nums.at(-1)! : null;
      const name = inline || pending.slice(-2).join('');
      pending = []; pendingKind = null;
      if (!name) { last = null; continue; }
      const sem = nums[7] && /^S?\d(-\d)?$/.test(nums[7]) ? nums[7] : null;
      const r = row(name, { module: dir ? `${dir}${dirNames.get(dir) ?? ''}方向（建议）` : null, credits: n(nums[0]), hours: n(nums[1]), semester: sem, page: l.page, snippet: t.slice(0, 80) });
      out.push(r); codes.push(code); own.push(kind);
      // a row whose English name is already on the code line is complete; otherwise lines until the English line still belong to it
      last = pre.some((x) => x.en) ? null : r;
      continue;
    }
    const kind = labelOf(c);
    if (c.some(isEnglish)) { if (kind && last && own[out.length - 1] === null) own[out.length - 1] = kind; last = null; pending = []; pendingKind = null; continue; }
    const split = c.filter((x) => !isNoise(x)).map(splitEnglish);
    const pieces = split.map((x) => x.han).filter(Boolean);
    // prose (修读说明, "选修 | ≥10 | 1-8" credit rules) ends a name and its label: they describe a block without codes
    if (pieces.some(isProse) || c.some((x) => x.startsWith('≥'))) { pending = []; pendingKind = null; continue; }
    if (last) {
      if (kind && own[out.length - 1] === null) own[out.length - 1] = kind;
      if (pieces.length) { last.name += pieces.join(''); if (split.some((x) => x.en)) last = null; } // "展史等四门课…）"
      continue;
    }
    if (kind) pendingKind = kind;
    pending.push(...pieces);
  }
  // resolve every row's 必修/选修 from the anchors
  const codeKind = (code: string): Kind | null => (code[7] === '1' ? '必修' : code[7] === '2' ? '选修' : null);
  const anchors = own.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
  out.forEach((r, i) => {
    let kind = own[i];
    if (!kind) {
      const prev = [...anchors].reverse().find((a) => a < i);
      const next = anchors.find((a) => a > i);
      const p = prev !== undefined ? own[prev]! : null, q = next !== undefined ? own[next]! : null;
      kind = p && q && p !== q ? (codeKind(codes[i]!) === q ? q : p) : p ?? q;
    }
    const ck = codeKind(codes[i]!);
    if (kind && ck && kind !== ck) warnings.push(`${r.name} (${codes[i]}): 表内类别 ${kind}, 课程编码第8位提示 ${ck}`);
    r.course_type = kind === '选修' ? '任选' : kind === '必修' ? '必修' : ck === '选修' ? '任选' : ck;
  });
  return out;
}
