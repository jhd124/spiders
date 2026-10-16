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
export function positionRows(wb: Workbook): { rows: PositionRow[]; skipped: string[]; ignored: string[] } {
  const book = XLSX.read(wb.data, { type: 'array', cellText: true, cellDates: false });
  const rows: PositionRow[] = [];
  const skipped: string[] = [];
  const ignored: string[] = []; // empty / headerless sheets (e.g. an empty Sheet1): not a failure
  for (const sheet of book.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[sheet]!, { header: 1, raw: false, defval: '' });
    const h = grid.findIndex((r) => r.map(clean).includes('职位代码') && r.map(clean).includes('部门代码'));
    if (h < 0) { ignored.push(`${wb.name}/${sheet}`); continue; }
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
  return { rows, skipped, ignored };
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
export interface Rule { id: number; source?: string | null; phrase: string; level: Level; catalog: 'undergrad' | 'grad' | null; major_code: string | null; match_type: MatchType }
export interface Target { catalog: 'undergrad' | 'grad'; code: string; kind: 'major' | 'class' | 'category' | 'discipline' }
export interface Match {
  seq: number; level: Level; phrase: string;
  /** segment the phrase was matched in: the printed 本科/研究生 prefix, else inferred from 学历 */
  segment: Level;
  catalog: 'undergrad' | 'grad' | null; major_code: string | null; match_type: MatchType; rule_id: number | null;
  /** a printed code disagreed with the catalog name or is not in the catalog; the match stands by name */
  code_doubtful: number;
  targets: Target[];
  /** 本科 majors this phrase admits (classes/categories expanded); [] for 研究生 matches */
  undergrad_majors: string[];
  /** 0 none; 1 the position's 备注 listed this phrase's majors and they were used; 2 detected but unparseable → unresolved */
  remarks_override?: 0 | 1 | 2;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 备注 that spells out what a phrase includes, e.g. 「财会审计类专业包括会计学、审计学、财务管理」 or
 * 「社会保障类（含劳动与社会保障、社会工作）」. Returns the listed items, [] when a list is announced but empty, null if none.
 */
export function remarksList(phrase: string, remarks: string): string[] | null {
  const name = splitCodes(phrase).name;
  if (!name || !remarks || !remarks.includes(name)) return null;
  const m = remarks.match(new RegExp(`${esc(name)}(?:专业)?(?:[（(](?:包括|包含|含|指|即)[:：]?([^）)]*)[）)]|(?:包括|包含|含|是指|指|为|即)[:：]?([^。；;\n]*))`));
  if (!m) return null;
  const list = (m[1] ?? m[2] ?? '').replace(/等(?:专业)?$|专业$/, '');
  return list.split(/[、，,;；]|或/).map((x) => x.trim().replace(/专业$/, '')).filter(Boolean);
}

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

/** 学历 requires 硕士 or above (→ 需读研后报考; never counted for 本科 products) */
export const needsGrad = (education: string) => /^(仅限)?(硕士|博士)|^研究生/.test(education.trim()) && !/本科/.test(education);
/** segment for phrases without a 本科：/研究生： prefix */
export function segmentFor(education: string): Level {
  if (needsGrad(education)) return 'grad';
  if (/^仅限(本科|大专)|^(大专|本科)$/.test(education.trim())) return 'undergrad';
  return 'any';
}

const UNLIMITED = /^(?:专业)?不限(?:专业)?$|^不限$/;
const RELATED = /相关|相近|等专业|类似/;
const CODE = /\d{6}[A-Z]{0,2}|\d{4}|\d{2}/g;
const base = (c: string) => c.replace(/[A-Z]+$/, '');

/** codes printed in the phrase: leading 「0809计算机类」, bracketed 「（0832、0972）食品科学与工程」 or trailing 「计算机类（0809）」 */
export function splitCodes(phrase: string): { codes: string[]; name: string } {
  let s = phrase.trim(), codes: string[] = [];
  const lead = s.match(/^[（(]\s*((?:\d{2,6}[A-Z]{0,2}\s*[、，,/\s]*\s*)+)[）)]\s*/) ?? s.match(/^((?:\d{2,6}[A-Z]{0,2}[、/]?)+)(?=[\u4e00-\u9fa5])/);
  if (lead) { codes = lead[1]!.match(CODE) ?? []; s = s.slice(lead[0].length); }
  // 「计算机类（0809）」「会计学（专业代码120203K）」「软件工程0835」
  const tail = s.match(/\s*[（(]\s*(?:专业代码|代码)?[:：]?\s*((?:\d{2,6}[A-Z]{0,2}\s*[、，,/\s]*\s*)+)[）)]\s*$/) ?? s.match(/(?<=[\u4e00-\u9fa5])((?:\d{4}|\d{6}[A-Z]{0,2}))$/);
  if (tail) { codes.push(...(tail[1]!.match(CODE) ?? [])); s = s.slice(0, tail.index); }
  return { codes, name: s.replace(/^(?:一级学科|学科门类|专业学位类别|门类)[:：]?/, '').trim() };
}

/** 本科 majors admitted by a target: a major itself, every major of a 专业类 / 门类 */
export function expandUndergrad(t: Target, cat: Catalogs): string[] {
  if (t.catalog !== 'undergrad') return [];
  if (t.kind === 'major') return [t.code];
  return [...cat.majors.keys()].filter((c) => c.startsWith(t.code)).sort();
}
/** a code from a rule row: 6 digits → 本科专业, 4 → 专业类 (本科) / 一级学科 (研究生), 2 → 门类 */
function ruleTarget(code: string, catalog: Rule['catalog'], cat: Catalogs): Target & { known: boolean } {
  const c = code.replace(/^(undergrad|grad):/, '');
  const cl = code.startsWith('grad:') ? 'grad' : code.startsWith('undergrad:') ? 'undergrad' : catalog ?? (c.length === 4 && !cat.classes.has(c) ? 'grad' : 'undergrad');
  // expert codes are kept as given even when our catalog lacks them (e.g. old 二级学科 120201); known = false flags them
  if (cl === 'grad') return { catalog: 'grad', code: c, kind: c.length === 2 ? 'category' : 'discipline', known: cat.grad.has(c) };
  if (c.length >= 6) { const k = [...cat.majors.keys()].find((x) => x === c || base(x) === c); return { catalog: 'undergrad', code: k ?? c, kind: 'major', known: !!k }; }
  return { catalog: 'undergrad', code: c, kind: c.length === 4 ? 'class' : 'category', known: (c.length === 4 ? cat.classes : cat.ugCategories ?? new Map()).has(c) };
}

/**
 * Match one phrase (expert rulings 2026-10-16):
 *  - the name decides; a printed code that disagrees with the catalog name or is not in the catalog only sets code_doubtful
 *  - in the 本科 segment a 4-digit code/name is a 专业类 (expanded to all its majors); in the 研究生 segment it is a 一级学科
 *  - several codes with one name: every code whose catalog name equals the name counts; the rest are doubtful
 *  - 不限 → unlimited; 相关/相近/等专业 → related (report); no catalog name → unresolved (report)
 */
export function matchPhrase(phrase: string, level: Level, cat: Catalogs, rules: Rule[] = [], segment: Level = level): Omit<Match, 'seq'> {
  const seg: Level = level !== 'any' ? level : segment;
  const out = (targets: Target[], match_type: MatchType, code_doubtful = 0, rule_id: number | null = null): Omit<Match, 'seq'> => {
    const cats = [...new Set(targets.map((t) => t.catalog))];
    return {
      level, phrase, segment: seg, match_type, rule_id, code_doubtful, targets,
      catalog: cats.length === 1 ? cats[0]! : null,
      major_code: targets.length ? targets.map((t) => (cats.length > 1 ? `${t.catalog}:${t.code}` : t.code)).join('|') : null,
      undergrad_majors: seg === 'grad' ? [] : [...new Set(targets.flatMap((t) => expandUndergrad(t, cat)))].sort(),
    };
  };
  const r = rules.find((x) => x.phrase === phrase && (x.level === level || x.level === 'any'));
  if (r) {
    const ts = (r.major_code ?? '').split('|').map((c) => c.trim()).filter(Boolean).map((c) => ruleTarget(c, r.catalog, cat));
    return out(ts.map(({ known: _k, ...t }) => t), r.match_type, ts.some((t) => !t.known) ? 1 : 0, r.id);
  }
  const { codes, name } = splitCodes(phrase);
  if (UNLIMITED.test(name)) return out([], 'unlimited');
  if (RELATED.test(name)) return out([], 'related');
  const lookup = (ug: boolean, grad: boolean): Target[] => {
    const cands: Target[] = [];
    const byName = (m: Map<string, string> | undefined, n: string) => (m ? [...m].filter(([, v]) => v === n).map(([k]) => k) : []);
    if (ug) {
      cands.push(...byName(cat.majors, name).map((code): Target => ({ catalog: 'undergrad', code, kind: 'major' })));
      cands.push(...byName(cat.classes, name).map((code): Target => ({ catalog: 'undergrad', code, kind: 'class' })));
      cands.push(...byName(cat.ugCategories, name).map((code): Target => ({ catalog: 'undergrad', code, kind: 'category' })));
      // 「0809计算机」 style: a 4-digit code in the 本科 segment is a 专业类 even when printed without 类
      if (!cands.length && codes.length) cands.push(...byName(cat.classes, name + '类').filter((k) => codes.includes(k)).map((code): Target => ({ catalog: 'undergrad', code, kind: 'class' })));
    }
    if (grad) {
      for (const code of byName(cat.grad, name)) cands.push({ catalog: 'grad', code, kind: code.length === 2 ? 'category' : 'discipline' });
      if (/类$/.test(name)) for (const code of byName(cat.grad, name.replace(/类$/, ''))) if (code.length === 2) cands.push({ catalog: 'grad', code, kind: 'category' });
    }
    return cands;
  };
  let cands = lookup(seg !== 'grad', seg !== 'undergrad');
  let crossSegment = 0;
  // the name exists only in the other catalog (e.g. 120401行政管理 printed for a 硕士 position: 本科 120402 行政管理):
  // the name still wins, the match is flagged; 研究生-segment matches never feed 本科 counts (undergrad_majors stays empty)
  if (!cands.length && seg !== 'any') { cands = lookup(seg === 'grad', seg === 'undergrad'); crossSegment = cands.length ? 1 : 0; }
  if (!cands.length) return out([], 'unresolved');
  const agrees = (t: Target, c: string) => t.code === c || base(t.code) === c;
  let doubtful = crossSegment;
  if (codes.length) {
    const hit = cands.filter((t) => codes.some((c) => agrees(t, c)));
    if (hit.length) cands = hit; // codes pick among same-name entries (食品科学与工程: 0832 研究生 vs 082701 本科)
    if (codes.some((c) => !cands.some((t) => agrees(t, c)))) doubtful = 1;
  }
  return out(cands, cands.every((t) => t.kind === 'class' || t.kind === 'category') ? 'category' : 'exact', doubtful);
}

export function matchMajors(text: string, cat: Catalogs, rules: Rule[] = [], education = '', remarks = ''): Match[] {
  const segment = segmentFor(education);
  if (!text.trim()) return [{ seq: 0, ...matchPhrase('', 'any', cat, [], segment), match_type: 'unresolved' }];
  return splitMajors(text).map((x, seq) => {
    const m: Match = { seq, ...matchPhrase(x.phrase, x.level, cat, rules, segment), remarks_override: 0 };
    if (UNLIMITED.test(x.phrase)) return m;
    const items = remarksList(x.phrase, remarks);
    if (!items) return m;
    // the position's own list overrides the rule / catalog match; every item must match the catalog by name
    const parts = items.map((it) => matchPhrase(it, x.level, cat, [], segment));
    if (!parts.length || parts.some((p) => !p.targets.length)) return { ...m, catalog: null, major_code: null, match_type: 'unresolved', rule_id: null, targets: [], undergrad_majors: [], code_doubtful: 0, remarks_override: 2 };
    const targets = parts.flatMap((p) => p.targets);
    const cats = [...new Set(targets.map((t) => t.catalog))];
    return { ...m, rule_id: null, targets, catalog: cats.length === 1 ? cats[0]! : null, code_doubtful: parts.some((p) => p.code_doubtful) ? 1 : 0,
      major_code: targets.map((t) => (cats.length > 1 ? `${t.catalog}:${t.code}` : t.code)).join('|'),
      match_type: parts.every((p) => p.match_type === 'category') ? 'category' : 'exact',
      undergrad_majors: [...new Set(parts.flatMap((p) => p.undergrad_majors))].sort(), remarks_override: 1 };
  });
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
