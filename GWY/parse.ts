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
  /** old 研究生 二级学科 / 专业领域 name → 2022 一级学科/专业学位类别 code(s) (GWY/rules/grad_legacy_map.csv) */
  gradLegacy?: Map<string, string[]>;
}
export interface Rule { id: number; source?: string | null; context?: string | null; phrase: string; level: Level; catalog: 'undergrad' | 'grad' | null; major_code: string | null; match_type: MatchType }
export interface Target { catalog: 'undergrad' | 'grad'; code: string; kind: 'major' | 'class' | 'category' | 'discipline'; /** a major left after subtracting from a class/category */ fromClass?: boolean }
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
  /** 1 = an expert rule's 不含 item / a listed sub-item (专业应为…) was not found and was ignored (排除项未全部对上);
   *  2 = a 不含/除外 item could not be matched → the whole phrase is unresolved (排除项未对上: under-count rather than over-count) */
  exclusions_partial?: number;
  /** how it matched: rule | legacy (旧二级学科 → 2022 parent) | catalog | remarks */
  via?: 'rule' | 'legacy' | 'catalog' | 'remarks' | 'modifier' | null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 备注 that spells out what a phrase includes, e.g. 「财会审计类专业包括会计学、审计学、财务管理」 or
 * 「社会保障类（含劳动与社会保障、社会工作）」. Returns the listed items, [] when a list is announced but empty, null if none.
 */
export function remarksList(phrase: string, remarks: string): string[] | null {
  const name = splitCodes(phrase).name;
  if (!name || !remarks || !remarks.includes(name)) return null;
  // 「法学专业指学科代码0301下设专业」: a definition by code, not a list → the code with the phrase name
  const byCode = remarks.match(new RegExp(`${esc(name)}(?:专业)?(?:是指|指|为)(?:学科|专业)?代码(?:为)?(\\d{2,6}[A-Z]{0,2})(?:下设|开头|的)`));
  if (byCode) return [`${byCode[1]}${name}`];
  const m = remarks.match(new RegExp(`${esc(name)}(?:专业)?(?:[（(](?:包括|包含|含|指|即)[:：]?([^）)]*)[）)]|(?:包括|包含|含|是指|指|为|即)[:：]?([^。；;\n]*))`));
  if (!m) return null;
  const list = (m[1] ?? m[2] ?? '').replace(/等(?:专业)?$|专业$/, '');
  return list.split(/[、，,;；]|或/).map((x) => x.trim().replace(/专业$/, '')).filter(Boolean);
}

/** level markers at the start of a segment (expert list 2026-10-16) */
const LEVEL_PREFIX: [RegExp, Level][] = [
  [/^(?:大学)?本科或(?:硕士)?研究生(?:专业)?(?:为|招收)?[:：]?/, 'any'],
  [/^(?:或|且)?以(?:大学)?本科(?:专业)?报考[:：]?/, 'undergrad'],
  [/^(?:或|且)?以(?:硕士|博士)?研究生(?:专业)?报考[:：]?/, 'grad'],
  [/^(?:或|且)?(?:大学)?本科(?:生)?(?:专业)?(?:为|招收)[:：]?/, 'undergrad'],
  [/^(?:或|且)?(?:硕士|博士)?研究生(?:专业)?(?:为|招收)[:：]?/, 'grad'],
  [/^(?:或|且)?(?:大学本科|本科|学士)(?:专业)?[:：]/, 'undergrad'],
  [/^(?:或|且)?(?:硕士研究生|博士研究生|研究生|硕士|博士)(?:专业)?[:：]/, 'grad'],
  [/^大学本科(?=\d)/, 'undergrad'],
  [/^(?:硕士)?研究生(?=\d)/, 'grad'],
];

/** split at depth-0 separators only (brackets keep 「A（B、C）」 together) */
function splitTop(s: string, seps: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('（(【['.includes(ch)) depth++;
    if ('）)】]'.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && seps.includes(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Split 专业 into (level, phrase) items. Segments end at 。；; or a new level marker
 * (「…，或研究生专业为…」「…且本科专业为…」「以研究生专业报考：…」); items are separated by 、，, outside brackets.
 * A segment that is only a bracket (「研究生08工学。（专业应为…）」) is the previous item's qualifier.
 */
export function splitMajors(text: string): { level: Level; phrase: string }[] {
  const out: { level: Level; phrase: string }[] = [];
  const t = text.replace(/\s*\n\s*/g, '；')
    .replace(/(?<!本科)[，,]*\s*(?=(?:或|且)(?:以)?(?:大学)?(?:本科|(?:硕士|博士)?研究生))/g, '；')
    .replace(/[，,]+\s*(?=(?:大学)?(?:本科|(?:硕士|博士)?研究生)(?:生)?(?:专业)?(?:为|招收|[:：]))/g, '；')
    .replace(/[，,]+\s*(?=以(?:大学)?(?:本科|研究生))/g, '；')
    .replace(/\s+(?=(?:大学本科|本科|硕士研究生|博士研究生|研究生)(?:专业)?[:：])/g, '；');
  let level: Level = 'any';
  for (let part of splitTop(t, '；;。')) {
    if (/^[（(].*[）)]$/.test(part) && out.length && !/^[（(]\s*\d/.test(part)) { out[out.length - 1]!.phrase += part; continue; }
    let lv: Level | null = null;
    for (const [re, l] of LEVEL_PREFIX) if (re.test(part)) { lv = l; part = part.replace(re, '').trim(); break; }
    level = lv ?? 'any';
    for (const item of splitTop(part, '、，,')) out.push({ level, phrase: item.replace(/[。.]$/, '') });
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
export function matchPhrase(phrase: string, level: Level, cat: Catalogs, rules: Rule[] = [], segment: Level = level, siblings: string[] = []): Omit<Match, 'seq'> {
  const seg: Level = level !== 'any' ? level : segment;
  const out = (targets: Target[], match_type: MatchType, code_doubtful = 0, rule_id: number | null = null, extra: { exclusions_partial?: number; via?: Match['via'] } = {}): Omit<Match, 'seq'> => {
    const cats = [...new Set(targets.map((t) => t.catalog))];
    return {
      level, phrase, segment: seg, match_type, rule_id, code_doubtful, targets,
      catalog: cats.length === 1 ? cats[0]! : null,
      major_code: targets.length ? targets.map((t) => (cats.length > 1 ? `${t.catalog}:${t.code}` : t.code)).join('|') : null,
      undergrad_majors: seg === 'grad' ? [] : [...new Set(targets.flatMap((t) => expandUndergrad(t, cat)))].sort(),
      exclusions_partial: extra.exclusions_partial ?? 0, via: extra.via ?? (targets.length ? 'catalog' : null),
    };
  };
  const { head: h0, q: q0 } = splitQualifier(phrase);
  const headName = splitCodes(h0).name.replace(/(?<=.{2})专业$/, '');
  const ruleFor = (key: string) => rules.find((x) => x.phrase === key && (x.level === level || x.level === 'any') && (!x.context || siblings.includes(x.context)));
  // exact phrase first; else the phrase head without its bracket / 专业 suffix (「经济金融类专业（不含…）」 → 经济金融类)
  // an include bracket (「法学类（法学）」) restricts the head, so only an exact-phrase rule applies then
  const r = ruleFor(phrase) ?? (q0?.kind === 'include' ? undefined : ruleFor(h0) ?? ruleFor(headName));
  if (r) {
    const codes = (r.major_code ?? '').split('|').map((c) => c.trim()).filter(Boolean);
    const ts = codes.filter((c) => !c.startsWith('-')).map((c) => ruleTarget(c, r.catalog, cat));
    let targets: Target[] = ts.map(({ known: _k, ...t }) => t);
    let partial = 0;
    const minus = codes.filter((c) => c.startsWith('-')).map((c) => c.slice(1));
    const exclude = r.phrase !== phrase && q0?.kind === 'exclude' ? q0.items : [];
    if (minus.length || exclude.length) {
      const sub = subtractUndergrad(targets, minus, exclude, cat);
      targets = sub.targets; partial = sub.partial;
    }
    return out(targets, r.match_type, ts.some((t) => !t.known) ? 1 : 0, r.id, { exclusions_partial: partial, via: 'rule' });
  }
  if (UNLIMITED.test(splitCodes(phrase).name)) return out([], 'unlimited');
  if (RELATED.test(h0)) return out([], 'related');
  const r2 = matchName(phrase, seg, cat);
  if (!r2 && q0?.kind === 'include' && RELATED.test(phrase.slice(h0.length))) return out([], 'related');
  if (r2?.partial === 2) return out([], 'unresolved', r2.doubtful, null, { exclusions_partial: 2, via: null });
  return r2 ? out(r2.targets, r2.targets.every((t) => t.kind !== 'major' && t.kind !== 'discipline') ? 'category' : 'exact', r2.doubtful, null, { exclusions_partial: r2.partial, via: r2.via }) : out([], 'unresolved');
}

/** 本科 targets → their majors minus codes (base / prefix) and minus named exclusions found in the catalog */
export function subtractUndergrad(targets: Target[], minusCodes: string[], excludeNames: string[], cat: Catalogs): { targets: Target[]; partial: number } {
  const ug = targets.filter((t) => t.catalog === 'undergrad');
  const pool = new Set(ug.flatMap((t) => expandUndergrad(t, cat)));
  let partial = 0;
  for (const c of minusCodes) for (const m of [...pool]) if (m === c || base(m) === base(c) || m.startsWith(c)) pool.delete(m);
  for (const it of excludeNames) {
    const { codes: ic, name } = splitCodes(it);
    const n = name.replace(/(?<=.{2})专业$/, '');
    const sfx = suffixFilter(n);
    if (sfx) { for (const m of [...pool]) if (sfx(m)) pool.delete(m); continue; }
    const hit = [...cat.majors.keys()].filter((c) => cat.majors.get(c) === n || ic.some((x) => base(c) === base(x)))
      .concat(byName(cat.classes, n).flatMap((k) => [...cat.majors.keys()].filter((c) => c.startsWith(k))));
    if (!hit.length) { partial = 1; continue; } // not in the catalog: ignored, flagged (排除项未全部对上)
    for (const h of hit) pool.delete(h);
  }
  return { targets: [...[...pool].sort().map((code): Target => ({ catalog: 'undergrad', code, kind: 'major', fromClass: true })), ...targets.filter((t) => t.catalog === 'grad')], partial };
}

/** 不含特设专业 → codes with T; 不含国家控制布点专业 → K; 不含特设控制布点专业 → both T and K. null = not a suffix term */
export function suffixFilter(term: string): ((code: string) => boolean) | null {
  const t = term.replace(/(?<=.{2})专业$/, '');
  const sf = (c: string) => c.replace(/^\d+/, '');
  if (t === '特设控制布点') return (c) => /T/.test(sf(c)) && /K/.test(sf(c));
  if (t === '国家控制布点') return (c) => /K/.test(sf(c));
  if (t === '特设') return (c) => /T/.test(sf(c));
  return null;
}

const agrees = (t: Target, c: string, prefix = false) => t.code === c || base(t.code) === c || (prefix && (t.code.startsWith(c) || c.startsWith(t.code)));
const byName = (m: Map<string, string> | undefined, n: string) => (m ? [...m].filter(([, v]) => v === n).map(([k]) => k) : []);

/** catalog entries whose name equals n exactly (no substring matching, ever) */
function lookupName(name: string, codes: string[], ug: boolean, grad: boolean, cat: Catalogs): Target[] {
  const cands: Target[] = [];
  const n = name.replace(/门类$/, '');
  if (ug) {
    cands.push(...byName(cat.majors, name).map((code): Target => ({ catalog: 'undergrad', code, kind: 'major' })));
    cands.push(...byName(cat.classes, name).map((code): Target => ({ catalog: 'undergrad', code, kind: 'class' })));
    // 「法学」 is the major 030101K, 「法学门类」 the category: the most specific exact name wins
    if (!cands.length || n !== name) cands.push(...byName(cat.ugCategories, n).map((code): Target => ({ catalog: 'undergrad', code, kind: 'category' })));
    // 「0809计算机」: a 4-digit code in the 本科 segment is a 专业类 even when printed without 类
    if (!cands.length && codes.length) cands.push(...byName(cat.classes, name + '类').filter((k) => codes.includes(k)).map((code): Target => ({ catalog: 'undergrad', code, kind: 'class' })));
  }
  if (grad) {
    const gd = byName(cat.grad, name);
    const disc = gd.filter((c) => c.length === 4);
    for (const code of disc.length && n === name ? disc : gd) cands.push({ catalog: 'grad', code, kind: code.length === 2 ? 'category' : 'discipline' });
    for (const code of byName(cat.grad, n)) if (code.length === 2 && n !== name) cands.push({ catalog: 'grad', code, kind: 'category' });
    if (/类$/.test(name)) for (const code of byName(cat.grad, name.replace(/类$/, ''))) if (code.length === 2) cands.push({ catalog: 'grad', code, kind: 'category' });
  }
  return cands;
}
/** old 二级学科 / 专业领域 name → 2022 parent(s) */
function legacyTargets(name: string, cat: Catalogs): Target[] {
  return (cat.gradLegacy?.get(name) ?? []).map((code): Target => ({ catalog: 'grad', code, kind: code.length === 2 ? 'category' : 'discipline' }));
}

interface Qualifier { kind: 'codes' | 'exclude' | 'include'; codes: string[]; prefix: boolean; items: string[] }
/** trailing bracket of a phrase: 「（专业代码0809开头）」「（不含A、B）」「（法学）」「（会计学、财务管理）」 */
export function splitQualifier(phrase: string): { head: string; q: Qualifier | null } {
  let s = phrase.trim().replace(/^[（(](?=[^）)]*[（(])/, ''); // 「（0301法学类（法学）」: stray opening bracket
  if (!/[）)]$/.test(s)) return { head: s, q: null };
  let depth = 0, i = s.length - 1;
  for (; i >= 0; i--) { const ch = s[i]!; if ('）)'.includes(ch)) depth++; if ('（('.includes(ch)) { depth--; if (depth === 0) break; } }
  if (i <= 0) return { head: s, q: null };
  const head = s.slice(0, i).trim(), body = s.slice(i + 1, -1).trim();
  const parts = splitTop(body, '，,；;');
  if (parts.length > 1) {
    const c = parts[0]!.match(/^(?:仅限|限)?(?:专业代码?为?|代码为?)?[:：]?\s*((?:\d{2,6}[A-Z]{0,2}\s*[、/及和]?\s*)+)(开头)?(?:的?专业)?$/);
    const rest = splitQualifier(`x（${parts.slice(1).join('，')}）`).q;
    if (c && rest && rest.kind === 'exclude') return { head, q: { ...rest, codes: c[1]!.match(CODE) ?? [], prefix: !!c[2] } };
  }
  const cm = body.match(/^(?:仅限|限)?(?:专业代码?为?|代码为?)?[:：]?\s*((?:\d{2,6}[A-Z]{0,2}\s*[、，,/及和]?\s*)+)(开头)?(?:的?专业)?$/);
  if (cm) return { head, q: { kind: 'codes', codes: cm[1]!.match(CODE) ?? [], prefix: !!cm[2], items: [] } };
  const items = (b: string) => b.split(/[、，,]/).map((x) => x.trim().replace(/(?:等)?(?:相关|相近)?(?:的)?(?:专业)?$/, '').replace(/^(?:含|包括)/, '')).filter(Boolean);
  const ex = body.match(/^(?:不含|不包括|除)(.*?)(?:等?专业)?(?:以?外)?$/) ?? body.match(/^(.*?)(?:等?专业)?除外$/);
  if (ex) return { head, q: { kind: 'exclude', codes: [], prefix: false, items: items(ex[1]!) } };
  return { head, q: { kind: 'include', codes: [], prefix: false, items: items(body.replace(/^(?:专业应为|专业为|含|包括|限|即|仅限)[:：]?/, '')) } };
}

/** name (+ printed codes, + bracket qualifier) → targets. null = unresolved. Exact names / classes / codes only. */
function matchName(phrase: string, seg: Level, cat: Catalogs): { targets: Target[]; doubtful: number; partial: number; via: Match['via'] } | null {
  const { head, q } = splitQualifier(phrase);
  const { codes: printed, name: n0 } = splitCodes(head);
  const name = n0.replace(/(?<=.{2})专业$/, ''); // 「财务会计教育专业」→ 财务会计教育 (exact name still required)
  const codes = [...printed, ...(q?.codes ?? [])];
  const prefix = !!q?.prefix;
  const lookup = (ug: boolean, grad: boolean) => lookupName(name, codes, ug, grad, cat);
  let cands = lookup(seg !== 'grad', seg !== 'undergrad');
  let doubtful = 0;
  let via: Match['via'] = 'catalog';
  // old 研究生 二级学科 name (民商法学 → 0301): its 2022 parent; only where 研究生 applies
  if (!cands.length && seg !== 'undergrad') { cands = legacyTargets(name, cat); if (cands.length) via = 'legacy'; }
  // the name exists only in the other catalog (120401行政管理 for a 硕士 position → 本科 120402): name wins, flagged
  if (!cands.length && seg !== 'any') {
    cands = lookup(seg === 'grad', seg === 'undergrad');
    if (!cands.length && seg === 'undergrad') { cands = legacyTargets(name, cat); if (cands.length) via = 'legacy'; }
    doubtful = cands.length ? 1 : 0;
  }
  // 「计算机科学与技术类」: XX类 where XX is a catalog name (研究生 0812 / 本科 080901) — matched, flagged as unsure
  if (!cands.length && /类$/.test(name)) {
    const bare = name.replace(/类$/, '');
    cands = lookupName(bare, codes, seg !== 'grad', seg !== 'undergrad', cat).filter((t) => t.kind === 'major' || t.kind === 'discipline');
    doubtful = cands.length ? 1 : 0;
  }
  if (!cands.length) return null;
  if (codes.length && via !== 'legacy') {
    const hit = cands.filter((t) => codes.some((c) => agrees(t, c, prefix)));
    if (hit.length) cands = hit; // codes pick among same-name entries (食品科学与工程: 0832 研究生 vs 082701 本科)
    if (codes.some((c) => !cands.some((t) => agrees(t, c, prefix)))) doubtful = 1;
  }
  if (!q || q.kind === 'codes') return { targets: cands, doubtful, partial: 0, via };
  if (q.kind === 'exclude') {
    // 「XX类（不含A、B）」: the class minus the exclusions (names / classes / 特设·控制布点 suffix terms);
    // any exclusion that cannot be matched makes the whole phrase unresolved (排除项未对上, expert ruling 2026-10-16)
    if (!cands.some((t) => t.catalog === 'undergrad' && t.kind !== 'major')) return { targets: [], doubtful, partial: 2, via };
    const sub = subtractUndergrad(cands, [], q.items, cat);
    if (sub.partial) return { targets: [], doubtful, partial: 2, via };
    return sub.targets.length ? { targets: sub.targets, doubtful, partial: 0, via } : null;
  }
  // include list
  const gradT = cands.filter((t) => t.catalog === 'grad');
  if (gradT.length === cands.length) {
    // 研究生 head with listed directions: 「1202工商管理学（会计学…）」= head ∪ items, 「08工学（专业应为…）」= the listed items only
    const items = q.items.map((it) => { const n = splitCodes(it).name.replace(/(?<=.{2})专业$/, ''); const t = lookupName(n, [], false, true, cat); return t.length ? t : legacyTargets(n, cat); });
    const found = items.flat();
    const partial = items.some((x) => !x.length) || RELATED.test(phrase.slice(head.length)) ? 1 : 0;
    const headKeep = gradT.filter((t) => t.kind === 'discipline');
    const all = [...headKeep, ...found].filter((t, i, a) => a.findIndex((x) => x.code === t.code) === i);
    return all.length ? { targets: all, doubtful, partial, via } : null;
  }
  // sub-restriction inside a 本科 class/category: only the named majors of it
  const ugT = cands.filter((t) => t.catalog === 'undergrad' && t.kind !== 'major');
  if (!ugT.length || ugT.length !== cands.length) return null;
  const pool = [...new Set(ugT.flatMap((t) => expandUndergrad(t, cat)))];
  const resolve = (it: string): string[] => {
    const { codes: ic, name: n } = splitCodes(it);
    const m = pool.filter((c) => cat.majors.get(c) === n || ic.some((x) => base(c) === base(x)));
    const cl = byName(cat.classes, n).flatMap((k) => pool.filter((c) => c.startsWith(k)));
    return [...new Set([...m, ...cl])];
  };
  const parts = q.items.map(resolve);
  const named = new Set(parts.flat());
  const keep = pool.filter((c) => named.has(c));
  if (!keep.length) return null;
  const partial = parts.some((x) => !x.length) || RELATED.test(phrase.slice(head.length)) ? 1 : 0;
  return { targets: keep.sort().map((code): Target => ({ catalog: 'undergrad', code, kind: 'major' })), doubtful, partial, via };
}

export function matchMajors(text: string, cat: Catalogs, rules: Rule[] = [], education = '', remarks = ''): Match[] {
  const segment = segmentFor(education);
  if (!text.trim()) return [{ seq: 0, ...matchPhrase('', 'any', cat, [], segment), match_type: 'unresolved' }];
  const items = splitMajors(text);
  const siblings = items.map((x) => splitCodes(x.phrase).name);
  const mods = suffixModifiers(items.map((x) => x.phrase));
  const ms = items.map((x, seq): Match | null => {
    if (mods.has(seq)) return null;
    const m: Match = { seq, ...matchPhrase(x.phrase, x.level, cat, rules, segment, siblings), remarks_override: 0 };
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
      undergrad_majors: [...new Set(parts.flatMap((p) => p.undergrad_majors))].sort(), remarks_override: 1, via: 'remarks' } as Match;
  });
  // 「以上各专业类别均不含特设专业、国家控制布点专业…」: applies to the class/category expansions of the phrases before it
  return ms.map((m, seq): Match => {
    if (m) return m;
    const { start, filters } = mods.get(seq)!;
    const before = ms.slice(0, start).filter((x): x is Match => !!x);
    const expanded = before.filter((x) => x.segment !== 'grad' && x.targets.some((t) => t.catalog === 'undergrad' && (t.kind !== 'major' || t.fromClass)));
    const base: Match = { seq, ...matchPhrase('', items[seq]!.level, cat, [], segment), phrase: items[seq]!.phrase, remarks_override: 0 };
    if (!expanded.length) return { ...base, match_type: 'unresolved' as MatchType };
    if (seq === start) for (const x of expanded) {
      const named = new Set(x.targets.filter((t) => t.catalog === 'undergrad' && t.kind === 'major' && !t.fromClass).map((t) => t.code));
      x.undergrad_majors = x.undergrad_majors.filter((c) => named.has(c) || !filters.some((f) => f(c)));
    }
    return { ...base, match_type: 'exact' as MatchType, via: 'modifier' as const };
  });
}

/** seq → modifier: a standalone 「以上…均不含特设专业」 and the bare 「国家控制布点专业」… items continuing its list */
function suffixModifiers(phrases: string[]): Map<number, { start: number; filters: ((c: string) => boolean)[] }> {
  const out = new Map<number, { start: number; filters: ((c: string) => boolean)[] }>();
  for (let i = 0; i < phrases.length; i++) {
    const m = phrases[i]!.match(/^(?:以上)?(?:各|所有)?(?:专业)?(?:类别)?(?:均|都|皆)?(?:不含|不包括)(.+)$/);
    const f = m && suffixFilter(m[1]!);
    if (!f) continue;
    const filters = [f];
    let j = i + 1;
    for (; j < phrases.length; j++) { const g = suffixFilter(phrases[j]!); if (!g) break; filters.push(g); }
    for (let k = i; k < j; k++) out.set(k, { start: i, filters });
    i = j - 1;
  }
  return out;
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
