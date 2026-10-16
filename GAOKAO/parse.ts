/**
 * Parse Shandong 投档情况表 (.xls/.xlsx/.csv).
 * 2022–2025 headers: 院校代号及名称, 专业代号及名称, 投档计划数, 最低位次
 * 2026 headers:      院校代号及名称, 专业代号及名称, 选考科目要求, 最低位次  (no 投档计划数)
 */
import * as XLSX from 'xlsx';
import { ADMISSION_TYPE_DEFAULT, PROVINCE } from './sources.js';

export interface ToudangRow {
  province: string;
  year: number;
  admission_type: string;
  is_ordinary: 0 | 1;
  /** NULL when ordinary; else one of SPECIAL_TYPE_LABELS (first match wins) */
  special_type: string | null;
  school_code: string;
  school_name: string;
  major_code_raw: string;
  major_name_raw: string;
  subject_requirement: string | null;
  plan_count: number | null;
  min_rank: number;
  source_file: string;
  source_url: string | null;
}

export function detectSpecialType(majorName: string, admissionType: string): string | null {
  const n = majorName.replace(/\s+/g, '');
  const t = admissionType.replace(/\s+/g, '');
  // explicit ordered checks (cleaner than the array edge-case above)
  if (/高校专项/.test(n) || /高校专项/.test(t)) return '高校专项';
  if (/非西藏生/.test(n) && (/定藏|定向西藏/.test(n))) return '非西藏生定藏就业';
  if (/定向西藏/.test(n)) return '定向西藏';
  if (/文物全科/.test(n)) return '文物全科';
  if (/中外合作/.test(n) || /中外合作/.test(t)) return '中外合作';
  // sheet name / admission_type without major hint
  if (/高校专项/.test(t)) return '高校专项';
  if (/国家专项|地方专项|专项计划|专项/.test(t) && !/普通类/.test(t)) return '专项';
  if (/艺术类|体育类|提前批|综合评价|强基/.test(t)) return t.slice(0, 32) || '其他特殊类型';
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, '').replace(/　/g, '');
const cell = (v: unknown) => (v == null ? '' : String(v).trim());

/** Split 「A422山东大学」 / 「A422 山东大学」 / 「A422山东大学济南校区」 → code + name */
export function splitCodeName(raw: string): { code: string; name: string } | null {
  const s = raw.trim();
  const m = s.match(/^([A-Za-z]\d{3})\s*(.+)$/);
  if (!m) return null;
  return { code: m[1]!.toUpperCase(), name: m[2]!.trim() };
}

/** 「01计算机类」 / 「01 计算机类」 / 「0A中外合作办学」 */
export function splitMajor(raw: string): { code: string; name: string } | null {
  const s = raw.trim();
  const m = s.match(/^([0-9A-Za-z]{1,4})\s*(.+)$/);
  if (!m) return null;
  return { code: m[1]!.toUpperCase(), name: m[2]!.trim() };
}

export function yearFromFilename(name: string): number | null {
  const m = name.match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

/** Product rows: 普通类 admission and no special_type from detectSpecialType. */
export function isOrdinaryRow(admissionType: string, majorName: string): boolean {
  if (detectSpecialType(majorName, admissionType)) return false;
  if (!/普通类/.test(admissionType)) return false;
  return true;
}

type Col = 'school' | 'major' | 'plan' | 'rank' | 'subject';
function mapHeader(h: string): Col | null {
  const n = norm(h);
  if (/院校代号/.test(n) || n === '院校') return 'school';
  if (/专业代号/.test(n) || n === '专业' || /专业名称/.test(n)) return 'major';
  if (/投档计划|计划数|计划/.test(n) && !/选考/.test(n)) return 'plan';
  if (/最低位次|位次/.test(n)) return 'rank';
  if (/选考科目|科目要求/.test(n)) return 'subject';
  return null;
}

export function detectColumns(header: unknown[]): Partial<Record<Col, number>> {
  const out: Partial<Record<Col, number>> = {};
  header.forEach((h, i) => {
    const c = mapHeader(cell(h));
    if (c && out[c] == null) out[c] = i;
  });
  return out;
}

export function parseSheetMatrix(
  rows: unknown[][],
  opts: { year: number; source_file: string; source_url?: string | null; admission_type?: string },
): ToudangRow[] {
  if (rows.length < 2) return [];
  // find header row (first with 院校 + 专业 + 位次)
  let hi = -1;
  let cols: Partial<Record<Col, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const c = detectColumns(rows[i] as unknown[]);
    if (c.school != null && c.major != null && c.rank != null) { hi = i; cols = c; break; }
  }
  if (hi < 0) throw new Error(`${opts.source_file}: no 投档表 header (need 院校代号及名称 / 专业代号及名称 / 最低位次)`);

  const admission_type = opts.admission_type ?? ADMISSION_TYPE_DEFAULT;
  const out: ToudangRow[] = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r] as unknown[];
    if (!row?.length) continue;
    const schoolRaw = cell(row[cols.school!]);
    const majorRaw = cell(row[cols.major!]);
    if (!schoolRaw || !majorRaw) continue;
    if (/合计|总计|备注/.test(schoolRaw)) continue;
    const sc = splitCodeName(schoolRaw);
    const mj = splitMajor(majorRaw);
    if (!sc || !mj) continue;
    const rankRaw = cell(row[cols.rank!]).replace(/,/g, '');
    const min_rank = Number(rankRaw);
    if (!Number.isFinite(min_rank) || min_rank <= 0) continue;
    let plan_count: number | null = null;
    if (cols.plan != null) {
      const p = Number(cell(row[cols.plan]).replace(/,/g, ''));
      plan_count = Number.isFinite(p) ? p : null;
    }
    const subject_requirement = cols.subject != null ? (cell(row[cols.subject]) || null) : null;
    const special_type = detectSpecialType(mj.name, admission_type);
    out.push({
      province: PROVINCE,
      year: opts.year,
      admission_type,
      special_type,
      is_ordinary: special_type || !/普通类/.test(admission_type) ? 0 : 1,
      school_code: sc.code,
      school_name: sc.name,
      major_code_raw: mj.code,
      major_name_raw: mj.name,
      subject_requirement,
      plan_count,
      min_rank,
      source_file: opts.source_file,
      source_url: opts.source_url ?? null,
    });
  }
  return out;
}

export function parseWorkbook(
  data: Buffer | Uint8Array,
  opts: { year?: number | null; source_file: string; source_url?: string | null },
): ToudangRow[] {
  const year = opts.year ?? yearFromFilename(opts.source_file);
  if (!year) throw new Error(`${opts.source_file}: cannot infer year (put 20xx in the filename or pass year)`);
  const wb = XLSX.read(data, { type: 'buffer', cellDates: false });
  const out: ToudangRow[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]!;
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) as unknown[][];
    // sheet name may hint 专项 etc.
    const type = /专项|艺术|体育|提前/.test(name) ? name.trim() : ADMISSION_TYPE_DEFAULT;
    out.push(...parseSheetMatrix(matrix, { year, source_file: opts.source_file, source_url: opts.source_url, admission_type: type }));
  }
  return out;
}

/** CSV text with a header row (fixtures / simple drops). */
export function parseCsvText(text: string, opts: { year: number; source_file: string; source_url?: string | null }): ToudangRow[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  const matrix = lines.map((l) => {
    // minimal CSV: split on comma; quoted fields unsupported in fixtures beyond plain
    return l.split(',').map((x) => x.trim());
  });
  return parseSheetMatrix(matrix, opts);
}
