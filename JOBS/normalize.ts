/**
 * Pure normalizers for job postings (no I/O): salary -> CNY/month, city, education, experience, channel, dedupe key.
 * Every salary result carries a `note` saying how it was derived, so salary_stat.method_note can be traced back.
 */
import { createHash } from 'node:crypto';

export interface Salary {
  min: number | null;
  max: number | null;
  /** months per year when stated (13薪 …); null = not stated (treated as 12) */
  months: number | null;
  note: string;
}

const MIN_MONTH = 1000;
const MAX_MONTH = 300000;

/**
 * '6000-8000' (元/月, the UPC default) | '10k-15k' | '10-15K·13薪' | '1-1.5万' | '1W-2W' | '20-30万/年' | '8000元以上' | '面议'.
 * Daily / hourly pay is not converted (returns null; 实习 pay is usually daily and is excluded from stats anyway).
 */
export function parseSalary(raw: string | null | undefined): Salary {
  const s0 = (raw ?? '').trim();
  if (!s0) return { min: null, max: null, months: null, note: 'empty' };
  const s = s0.replace(/\s+/g, '').replace(/[～~至到—–]/g, '-').replace(/[，,]/g, '').toLowerCase();
  if (/面议|negotiable/.test(s)) return { min: null, max: null, months: null, note: '面议' };
  if (/天|日|小时|时薪|\/d|\/h/.test(s)) return { min: null, max: null, months: null, note: 'daily/hourly, not converted' };
  const mMonths = s.match(/(\d{2})薪/);
  const months = mMonths ? Number(mMonths[1]) : null;
  const body = s.replace(/[·.*x×]?\d{2}薪.*$/, '');
  const yearly = /万\/年|万每年|\/年|年薪|w\/年|万\/year/.test(body);
  const m = body.match(/(\d+(?:\.\d+)?)\s*(k|千|w|万|元)?(?:-(\d+(?:\.\d+)?)\s*(k|千|w|万|元)?)?/);
  if (!m) return { min: null, max: null, months, note: `unparsed: ${s0}` };
  const unitOf = (u: string | undefined, other: string | undefined) => u ?? other;
  const u1 = unitOf(m[2], m[4]);
  const u2 = unitOf(m[4], m[2]);
  const scale = (n: number, u: string | undefined, isMax: boolean): { v: number; why: string } => {
    if (u === 'k' || u === '千') return { v: n * 1000, why: 'K' };
    if (u === 'w' || u === '万') return { v: n * 10000, why: '万' };
    // unitless: UPC-style 元; tiny numbers ('8-12') are K
    if (n < 100) return { v: n * 1000, why: 'unitless<100→K' };
    void isMax;
    return { v: n, why: '元' };
  };
  const a = scale(Number(m[1]), u1, false);
  let b = m[3] != null ? scale(Number(m[3]), u2, true) : null;
  let min = a.v;
  let max = b ? b.v : null;
  const notes = [b && a.why !== b.why ? `${a.why}/${b.why}` : a.why];
  if (yearly) {
    min = min / 12;
    if (max != null) max = max / 12;
    notes.push('年薪/12');
  }
  if (!m[3] && /以上|起|\+/.test(body)) notes.push('open-ended (min only)');
  if (!m[3] && /以下|以内/.test(body)) {
    max = min;
    min = NaN;
    notes.push('max only');
  }
  const ok = (v: number | null) => v != null && Number.isFinite(v) && v >= MIN_MONTH && v <= MAX_MONTH;
  const rmin = ok(min) ? Math.round(min) : null;
  const rmax = ok(max) ? Math.round(max!) : null;
  if (rmin == null && rmax == null) return { min: null, max: null, months, note: `out of range: ${s0}` };
  if (rmin != null && rmax != null && rmax < rmin) return { min: rmax, max: rmin, months, note: notes.join(', ') + ', swapped' };
  if (months) notes.push(`${months}薪`);
  return { min: rmin, max: rmax, months, note: notes.join(', ') };
}

/** monthly figure used for stats: midpoint of the range (or the single bound), annualized over 薪 months / 12 */
export function statMonthly(min: number | null, max: number | null, months: number | null): number | null {
  const base = min != null && max != null ? (min + max) / 2 : (min ?? max);
  if (base == null) return null;
  return Math.round((base * (months ?? 12)) / 12);
}
export const STAT_METHOD =
  'monthly = midpoint of posted range (single bound if open-ended) × (薪 months, default 12) / 12; 年薪 ÷ 12; K=×1000, 万=×10000; unitless ≥100 = 元/月; daily/hourly and 面议 excluded; reposts collapsed by dedupe_key; 实习 excluded from 全部';

const MUNI = ['北京', '上海', '天津', '重庆'];
/** '山东省青岛市市北区' -> '青岛'; '北京市海淀区' -> '北京'; '广东省深圳市' -> '深圳'; '新疆维吾尔自治区乌鲁木齐市' -> '乌鲁木齐' */
export function normCity(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, '').replace(/市辖区$/, '');
  if (!s) return null;
  for (const m of MUNI) if (s.startsWith(m)) return m;
  const rest = s.replace(/^.*?(省|自治区|特别行政区)/, '');
  const m = rest.match(/^(.+?)(市|地区|自治州|盟)/);
  if (m) return m[1]!;
  return rest.replace(/(省|市)$/, '') || null;
}

export type Education = '不限' | '大专' | '本科' | '硕士' | '博士';
const EDU_ORDER: Education[] = ['不限', '大专', '本科', '硕士', '博士'];
/** minimum accepted education: '不限,本科,硕士' -> '不限'; '本科,硕士' -> '本科'; '研究生' -> '硕士' */
export function normEducation(raw: string | null | undefined): Education | null {
  const s = raw ?? '';
  const found = new Set<Education>();
  if (/不限|学历不限|无要求/.test(s)) found.add('不限');
  if (/大专|专科|高职/.test(s)) found.add('大专');
  if (/本科|学士/.test(s)) found.add('本科');
  if (/硕士|研究生/.test(s)) found.add('硕士');
  if (/博士/.test(s)) found.add('博士');
  for (const e of EDU_ORDER) if (found.has(e)) return e;
  return null;
}

/** '3-5年' -> 3; '应届' / '不限' / '无经验' -> 0; '5年以上' -> 5 */
export function normExperience(raw: string | null | undefined): number | null {
  const s = raw ?? '';
  if (!s.trim()) return null;
  if (/应届|不限|无经验|在校|实习/.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export function normChannel(siteDefault: '社招' | '校招', jobType: string | null | undefined, title: string): '社招' | '校招' | '实习' {
  if (/实习/.test(jobType ?? '') || /实习/.test(title)) return '实习';
  return siteDefault;
}

export function dedupeKey(company: string | null, title: string, city: string | null, salaryRaw: string | null): string {
  const n = (x: string | null) => (x ?? '').replace(/\s+/g, '').replace(/[（(][^）)]*[）)]/g, '').toLowerCase();
  return createHash('sha1').update([n(company), n(title), n(city), n(salaryRaw)].join('|')).digest('hex').slice(0, 20);
}

export function quarterOf(isoDate: string | null | undefined): string | null {
  const m = (isoDate ?? '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}Q${Math.ceil(Number(m[2]) / 3)}`;
}

const ENT: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
/** decode the few HTML entities the sources leak into plain-text fields ('大数据开发&nbsp;') and collapse spaces */
export function decodeText(s: string | null | undefined): string | null {
  if (s == null) return null;
  const out = s
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENT[e] ?? '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .trim();
  return out || null;
}
