/** Pure parsing for GWY: 职位表 workbooks (zip/xlsx/xls), the notice age clause, the grad catalog, and 专业 → MOE major matching. */
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

/* ---------------- 职位表 ---------------- */

/** header (verbatim) → gwy_position column */
export const COLUMN_MAP: Record<string, string> = {
  部门代码: 'dept_code', 部门名称: 'dept_name', 用人司局: 'bureau', 机构性质: 'org_nature', 招考职位: 'position_name',
  职位属性: 'position_attr', 职位分布: 'position_dist', 职位简介: 'position_desc', 职位代码: 'position_code', 机构层级: 'org_level',
  考试类别: 'exam_category', 招考人数: 'hires', 专业: 'major_text', 学历: 'education', 学位: 'degree', 政治面貌: 'political',
  基层工作最低年限: 'grassroots_years', 服务基层项目工作经历: 'grassroots_project', 是否在面试阶段组织专业能力测试: 'skill_test',
  面试人员比例: 'interview_ratio', 工作地点: 'work_place', 落户地点: 'hukou_place', 备注: 'remarks', 部门网站: 'website',
  咨询电话1: 'phone1', 咨询电话2: 'phone2', 咨询电话3: 'phone3',
};

export interface PositionRow { sheet: string; row_no: number; file: string; raw: Record<string, string>; cols: Record<string, string> }
export interface Workbook { name: string; data: Uint8Array }

const clean = (v: unknown) => String(v ?? '').replace(/\r\n?/g, '\n').trim();

/** Expand a zip (any depth) into its .xls/.xlsx members; a bare workbook is returned as is. */
export async function workbooksFrom(name: string, data: Uint8Array): Promise<Workbook[]> {
  const pk = data[0] === 0x50 && data[1] === 0x4b;
  if (!pk || /\.(xlsx|xlsm)$/i.test(name)) return [{ name, data }];
  const zip = await JSZip.loadAsync(data);
  const out: Workbook[] = [];
  for (const f of Object.values(zip.files)) {
    if (f.dir || /(^|\/)(__MACOSX|\.)/.test(f.name)) continue;
    const bytes = await f.async('uint8array');
    if (/\.(xlsx?|xlsm)$/i.test(f.name)) out.push({ name: f.name, data: bytes });
    else if (/\.zip$/i.test(f.name)) out.push(...(await workbooksFrom(f.name, bytes)));
  }
  return out;
}

/** Every sheet with a header row containing 职位代码 and 部门代码; rows below it until the data ends. */
export function positionRows(wb: Workbook): { rows: PositionRow[]; skipped: string[] } {
  const book = XLSX.read(wb.data, { type: 'array', cellText: true, cellDates: false });
  const rows: PositionRow[] = [];
  const skipped: string[] = [];
  for (const sheet of book.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheet]!, { header: 1, raw: false, defval: '' });
    const h = grid.findIndex((r) => r.map(clean).includes('职位代码') && r.map(clean).includes('部门代码'));
    if (h < 0) { skipped.push(`${wb.name}/${sheet}: no header row`); continue; }
    const header = grid[h]!.map(clean);
    for (let i = h + 1; i < grid.length; i++) {
      const cells = grid[i]!.map(clean);
      if (!cells.some(Boolean)) continue;
      const raw: Record<string, string> = {};
      header.forEach((k, j) => { if (k) raw[k] = cells[j] ?? ''; });
      if (!raw['职位代码'] || !raw['部门代码']) { skipped.push(`${wb.name}/${sheet} row ${i + 1}: no 职位代码/部门代码`); continue; }
      const cols: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) if (COLUMN_MAP[k]) cols[COLUMN_MAP[k]!] = v;
      rows.push({ sheet, row_no: i + 1, file: wb.name, raw, cols });
    }
  }
  return { rows, skipped };
}

/* ---------------- notice ---------------- */

export interface AgeRule { age_min: number | null; age_max: number | null; age_max_relaxed: number | null; age_relaxed_for: string | null }
const NUM = '(\\d{2})';
/** 「18周岁以上、38周岁以下 … 对于2027年应届硕士、博士研究生，放宽到43周岁以下」 */
export function parseAge(text: string): AgeRule {
  const t = text.replace(/\s+/g, '');
  const base = t.match(new RegExp(`${NUM}周岁以上[、，,至到-]*${NUM}周岁以下`));
  const rm = t.match(new RegExp(`放宽(?:到|至)${NUM}周岁以下`));
  let who: string | null = null;
  if (rm) {
    const before = t.slice(0, rm.index);
    const i = Math.max(before.lastIndexOf('对于'), before.lastIndexOf('；'), before.lastIndexOf('。'));
    who = before.slice(i < 0 ? 0 : i).replace(/^(对于|；|。)/, '').split(/[，,（(]/)[0]!.replace(/报考的$/, '') || null;
    if (who && !/研究生|硕士|博士|应届|人员/.test(who)) who = null;
  }
  return {
    age_min: base ? Number(base[1]) : null,
    age_max: base ? Number(base[2]) : null,
    age_max_relaxed: rm ? Number(rm[1]) : null,
    age_relaxed_for: who,
  };
}

/* ---------------- 研究生教育学科专业目录 ---------------- */

export interface GradDiscipline { code: string; name: string; kind: 'category' | 'academic' | 'professional'; category_code: string | null; master_only: number; note: string | null }
/** Lines of the official PDF → 门类 (01 哲学) and 一级学科/专业学位类别 (0812 计算机科学与技术（可授工学、理学学位）, 0251 金融*). */
export function parseGradCatalog(lines: string[]): GradDiscipline[] {
  const out = new Map<string, GradDiscipline>();
  let cat: string | null = null;
  for (const line of lines) {
    const s = line.trim();
    const c = s.match(/^(\d{2})\s*([\u4e00-\u9fa5]{2,6})$/);
    if (c && Number(c[1]) >= 1 && Number(c[1]) <= 14) { cat = c[1]!; out.set(cat, { code: cat, name: c[2]!, kind: 'category', category_code: null, master_only: 0, note: null }); continue; }
    const m = s.match(/^(\d{4})\s*([\u4e00-\u9fa5][\u4e00-\u9fa5、与和及]*)(\*)?\s*(?:[（(](.*?)[）)]?)?$/);
    if (!m || !cat || !m[1]!.startsWith(cat)) continue;
    out.set(m[1]!, { code: m[1]!, name: m[2]!, kind: m[1]![2] === '5' ? 'professional' : 'academic', category_code: cat, master_only: m[3] ? 1 : 0, note: m[4]?.replace(/[，,]$/, '') || null });
  }
  return [...out.values()];
}

/* ---------------- 专业 → MOE major ---------------- */

export type Level = 'any' | 'undergrad' | 'grad';
export type MatchType = 'exact' | 'category' | 'unlimited' | 'related' | 'unresolved';
export interface Catalogs {
  /** 本科: major code → name (code as printed, e.g. 080901, 080910T) */
  majors: Map<string, string>;
  /** 本科专业类: code → name (0809 计算机类) */
  classes: Map<string, string>;
  /** 本科学科门类: code → name (08 工学) */
  ugCategories?: Map<string, string>;
  /** 研究生: code → name (门类 2 digits, 一级学科/专业学位类别 4 digits) */
  grad: Map<string, string>;
}
export interface Rule { id: number; phrase: string; level: Level; catalog: 'undergrad' | 'grad' | null; major_code: string | null; match_type: MatchType }
export interface Match { seq: number; level: Level; phrase: string; catalog: 'undergrad' | 'grad' | null; major_code: string | null; match_type: MatchType; rule_id: number | null }

const LEVEL_PREFIX: [RegExp, Level][] = [
  [/^(?:本科|大学本科|学士)(?:专业)?[:：]/, 'undergrad'],
  [/^(?:研究生|硕士研究生|博士研究生|硕士|博士)(?:专业)?[:：]/, 'grad'],
];

/** Split 专业 into (level, phrase) items: 「本科：A、B；研究生：C」, separators 、，,；; and newlines. */
export function splitMajors(text: string): { level: Level; phrase: string }[] {
  const out: { level: Level; phrase: string }[] = [];
  for (const part of text.replace(/\s*\n\s*/g, '；').split(/[；;]/)) {
    let level: Level = 'any';
    let s = part.trim();
    for (const [re, l] of LEVEL_PREFIX) if (re.test(s)) { level = l; s = s.replace(re, '').trim(); }
    if (!s) continue;
    // keep 「A（B、C）」 together: split on 、，, only outside brackets
    let depth = 0, cur = '';
    for (const ch of s) {
      if ('（(【['.includes(ch)) depth++;
      if ('）)】]'.includes(ch)) depth = Math.max(0, depth - 1);
      if (depth === 0 && '、，,'.includes(ch)) { if (cur.trim()) out.push({ level, phrase: cur.trim() }); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push({ level, phrase: cur.trim().replace(/[。.]$/, '') });
  }
  return out;
}

const UNLIMITED = /^(?:专业)?不限(?:专业)?$|^不限$/;
const RELATED = /相关|相近|等专业|类似/;

/** Match one phrase against the catalogs. Only verbatim code+name / name agreement counts; everything else is unresolved. */
export function matchPhrase(phrase: string, level: Level, cat: Catalogs, rules: Rule[] = []): Omit<Match, 'seq'> {
  const r = rules.find((x) => x.phrase === phrase && (x.level === level || x.level === 'any'));
  if (r) return { level, phrase, catalog: r.catalog, major_code: r.major_code, match_type: r.match_type, rule_id: r.id };
  const res = (catalog: Match['catalog'], major_code: string | null, match_type: MatchType): Omit<Match, 'seq'> => ({ level, phrase, catalog, major_code, match_type, rule_id: null });
  const p = phrase.replace(/[（(]\s*(?:\d{4,6}[A-Z]{0,2})\s*[）)]/, '').trim();
  if (UNLIMITED.test(p)) return res(null, null, 'unlimited');
  if (RELATED.test(p)) return res(null, null, 'related');
  const code = (phrase.match(/^(\d{6}[A-Z]{0,2}|\d{4}|\d{2})(?![\d])/) ?? phrase.match(/[（(](\d{6}[A-Z]{0,2}|\d{4})[）)]/))?.[1];
  const name = p.replace(/^\d{2,6}[A-Z]{0,2}\s*/, '').replace(/^(?:一级学科|学科门类|专业学位类别)[:：]?/, '').trim();
  const grad = level !== 'undergrad', ug = level !== 'grad';
  if (code) {
    // a code is only trusted when the printed name agrees with the catalog name for that code
    if (code.length >= 6 && ug && cat.majors.get(code) === name) return res('undergrad', code, 'exact');
    if (code.length === 6 && ug) {
      // printed without the T/K suffix (080910 数据科学与大数据技术 → 080910T): same base code and same name only
      const k = [...cat.majors.keys()].filter((c) => c.replace(/[A-Z]+$/, '') === code && cat.majors.get(c) === name);
      if (k.length === 1) return res('undergrad', k[0]!, 'exact');
    }
    if (code.length === 2 && ug && cat.ugCategories?.get(code) === name) return res('undergrad', code, 'category');
    if (code.length === 4 && ug && cat.classes.get(code) === name) return res('undergrad', code, 'category');
    if (code.length === 4 && grad && cat.grad.get(code) === name) return res('grad', code, 'exact');
    if (code.length === 2 && grad && cat.grad.get(code) === name.replace(/^门类/, '')) return res('grad', code, 'category');
    return res(null, null, 'unresolved');
  }
  const byName = (m: Map<string, string>, n: string) => [...m].filter(([, v]) => v === n).map(([k]) => k);
  const hits: Omit<Match, 'seq'>[] = [];
  if (ug) for (const k of byName(cat.majors, name)) hits.push(res('undergrad', k, 'exact'));
  if (ug) for (const k of byName(cat.classes, name)) hits.push(res('undergrad', k, 'category'));
  if (ug && cat.ugCategories) for (const k of byName(cat.ugCategories, name.replace(/^门类/, ''))) hits.push(res('undergrad', k, 'category'));
  if (grad) for (const k of byName(cat.grad, name)) hits.push(res('grad', k, k.length === 2 ? 'category' : 'exact'));
  if (grad && /类$/.test(name)) for (const k of byName(cat.grad, name.replace(/类$/, ''))) if (k.length === 2) hits.push(res('grad', k, 'category'));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    // same name in both catalogs (e.g. 软件工程 080902 / 0835) when the level is not given: keep both codes, flagged by catalog
    const codes = hits.map((h) => `${h.catalog}:${h.major_code}`).join('|');
    return { level, phrase, catalog: null, major_code: codes, match_type: hits.every((h) => h.match_type === 'category') ? 'category' : 'exact', rule_id: null };
  }
  return res(null, null, 'unresolved');
}

export function matchMajors(text: string, cat: Catalogs, rules: Rule[] = []): Match[] {
  if (!text.trim()) return [{ seq: 0, level: 'any', phrase: '', catalog: null, major_code: null, match_type: 'unresolved', rule_id: null }];
  return splitMajors(text).map((x, seq) => ({ seq, ...matchPhrase(x.phrase, x.level, cat, rules) }));
}

/** CSV with a header row; quotes "…" with "" escapes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [h, ...body] = rows.filter((r) => r.some((c) => c.trim()) && !r[0]!.startsWith('#'));
  return h ? body.map((r) => Object.fromEntries(h.map((k, j) => [k.trim(), (r[j] ?? '').trim()]))) : [];
}
export const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
