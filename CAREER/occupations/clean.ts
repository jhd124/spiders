/**
 * Rebuild the 大典 2022 分类体系表 (大类 / 中类 / 小类 / 细类) from positioned PDF text.
 * Layout: three table columns (中类 | 小类 | 细类(职业)); names wrap inside a cell and are either
 * top-aligned with the code or vertically centred on it; L / S / L/S markers follow the 细类 name.
 * The result is checked (codes nest, every 细类 has a parent, no duplicates); counts are printed
 * next to the official totals so a layout drift is visible.
 * Output: data/clean/career-occupations.json
 */
import { cleanPath, rawPath, readJson, writeJson, type RawDump } from '../../lib/io.js';
import { isMain } from '../../lib/main.js';
import type { FetchedDoc } from '../fetchdoc.js';
import { RAW_NAME } from './crawler.js';

type RawTable = FetchedDoc & { pages: number; items: [number, number, number, string][] };

export interface Occupation {
  code: string;
  level: 1 | 2 | 3 | 4;
  name: string;
  parent_code: string | null;
  gbm_code: string | null;
  is_digital: boolean;
  is_green: boolean;
  page: number;
}

/** Official totals of the 2022 公示稿 announcement (MOHRSS, 2022-07-12). */
/** Official totals (S/L totals include the 23 L/S). 公示稿 2022-07-12; final edition per 人社部 2022-09-28 release. */
export const OFFICIAL_COUNTS = {
  draft: { 1: 8, 2: 79, 3: 449, 4: 1636, digital_total_S: 97, green_total_L: 133, both_LS: 23 },
  final: { 1: 8, 2: 79, 4: 1639, digital_total_S: 97, green_total_L: 134, both_LS: 23 },
};

const CODE = /(\d)-(\d{2})(?:-(\d{2}))?(?:-(\d{2}))?/;
const JUNK = /^(续表|中华人民共和国|职业分类大典（2022年版）|中类|小类|细类\(职业\)|细类（职业）|分类体系表|\d{1,3})$/;
const FLAG_ONLY = /^(L\/S|L|S)$/;
const FLAG_TAIL = /(?<=[\p{Script=Han}）)])(L\/S|L|S)$/u;
const LEVEL_NAMES = { 1: '大类', 2: '中类', 3: '小类', 4: '细类' } as const;
export { LEVEL_NAMES };

interface Line { page: number; y: number; text: string }
interface Anchor { line: Line; code: string; level: number; head: string; parts: { y: number; text: string; page: number }[]; flag: string | null; centred: boolean }

const norm = (s: string) => s.replace(/\s+/g, '');

export function parseTable(raw: RawTable): Occupation[] {
  // ---- 1. lines per page x column
  const byKey = new Map<string, { page: number; c: number; y: number; parts: [number, string][] }>();
  const majors: Occupation[] = [];
  for (const [page, x, y, str] of raw.items) {
    const even = page % 2 === 0;
    const c = x < (even ? 197 : 185) ? 0 : x < (even ? 347 : 335) ? 1 : 2;
    let key = '';
    for (const dy of [0, -1, 1, -2, 2]) {
      const k = `${page}|${c}|${Math.round(y) + dy}`;
      if (byKey.has(k)) { key = k; break; }
    }
    if (!key) { key = `${page}|${c}|${Math.round(y)}`; byKey.set(key, { page, c, y, parts: [] }); }
    byKey.get(key)!.parts.push([x, str]);
  }
  const cols: Line[][] = [[], [], []];
  for (const l of [...byKey.values()].sort((a, b) => a.page - b.page || b.y - a.y)) {
    const text = norm(l.parts.sort((a, b) => a[0] - b[0]).map((p) => p[1]).join(''));
    const mj = text.match(/^第.大类(\d)（GBM(\d{5})）(.+)$/);
    if (mj) {
      majors.push({ code: mj[1]!, level: 1, name: mj[3]!, parent_code: null, gbm_code: 'GBM' + mj[2], is_digital: false, is_green: false, page: l.page });
      continue;
    }
    if (!text || JUNK.test(text)) continue;
    cols[l.c]!.push({ page: l.page, y: l.y, text });
  }

  const out: Occupation[] = [...majors];
  for (const [c, lines] of cols.entries()) {
    const level = c + 2;
    // ---- 2. split lines into anchors (code lines) and loose lines; a prefix before a code belongs upward
    type Item = { kind: 'anchor'; a: Anchor } | { kind: 'loose'; line: Line };
    const seq: Item[] = [];
    for (const line of lines) {
      const m = line.text.match(CODE);
      if (!m) { seq.push({ kind: 'loose', line }); continue; }
      const idx = m.index!;
      if (idx > 0) seq.push({ kind: 'loose', line: { ...line, text: line.text.slice(0, idx), y: line.y + 0.01 } });
      const rest = line.text.slice(idx + m[0].length);
      const code = m[0];
      const lv = code.split('-').length;
      if (lv !== level) throw new Error(`page ${line.page}: code ${code} (level ${lv}) found in level-${level} column`);
      const head = rest.replace(/^\(?\)?\(?GBM\d{5}\)?/, '').replace(/^\(\)/, '');
      const gbm = rest.match(/GBM(\d{5})/)?.[1];
      const a: Anchor = { line, code, level: lv, head, parts: [], flag: null, centred: head.replace(/[()（）]/g, '') === '' };
      (a as Anchor & { gbm?: string }).gbm = gbm ? 'GBM' + gbm : undefined;
      if (head) a.parts.push({ y: line.y, text: head, page: line.page });
      seq.push({ kind: 'anchor', a });
    }
    // ---- 3. centred anchors claim as many lines above as they have below (within the page)
    const owner = new Map<number, Anchor>();
    for (let i = 0; i < seq.length; i++) {
      const it = seq[i]!;
      if (it.kind !== 'anchor' || !it.a.centred) continue;
      let below = 0;
      for (let j = i + 1; j < seq.length; j++) {
        const s = seq[j]!;
        if (s.kind !== 'loose' || s.line.page !== it.a.line.page || FLAG_ONLY.test(s.line.text)) break;
        below++;
      }
      for (let j = i - 1, n = 0; j >= 0 && n < Math.max(below, 1); j--) {
        const s = seq[j]!;
        if (s.kind !== 'loose' || s.line.page !== it.a.line.page || FLAG_ONLY.test(s.line.text)) break;
        if (it.a.line.y - s.line.y > 16 * (below + 1)) break;
        owner.set(j, it.a);
        n++;
      }
    }
    // ---- 4. everything else belongs to the closest anchor above (across page breaks)
    let cur: Anchor | null = null;
    const anchors: Anchor[] = [];
    for (let i = 0; i < seq.length; i++) {
      const it = seq[i]!;
      if (it.kind === 'anchor') { cur = it.a; anchors.push(cur); continue; }
      const target = owner.get(i) ?? cur;
      if (!target) throw new Error(`page ${it.line.page}: text before first code: ${it.line.text}`);
      target.parts.push({ y: it.line.y, text: it.line.text, page: it.line.page });
    }
    for (const a of anchors) {
      let name = a.parts
        .sort((p, q) => p.page - q.page || q.y - p.y)
        .map((p) => p.text)
        .join('')
        .replace(/（年版）职业分类大典2022|中华人民共和国职业分类大典（2022年版）/g, '') // rotated running header
        .replace(/^\(\)|\(\)$/g, '')
        .replace(/[（(]\)?$/, '');
      let flag: string | null = null;
      const fm = name.match(FLAG_TAIL) ?? name.match(/(L\/S|L|S)$/);
      if (fm && a.level === 4) { flag = fm[1]!; name = name.slice(0, -fm[1]!.length); }
      const fo = name.match(/^(.*?)(L\/S|L|S)(?=[\p{Script=Han}])/u);
      if (fo && a.level === 4 && !fo[1]) throw new Error(`stray flag at start of ${a.code}: ${name}`);
      if (/[A-Za-z]/.test(name.replace(/\(GBM\d+\)/, ''))) console.warn(`[occupations] latin text left in ${a.code}: ${name}`);
      const parts = a.code.split('-');
      out.push({
        code: a.code,
        level: a.level as Occupation['level'],
        name,
        parent_code: parts.slice(0, -1).join('-'),
        gbm_code: (a as Anchor & { gbm?: string }).gbm ?? null,
        is_digital: flag === 'S' || flag === 'L/S',
        is_green: flag === 'L' || flag === 'L/S',
        page: a.line.page,
      });
    }
  }
  // ---- 5. integrity
  const by = new Map<string, Occupation>();
  for (const o of out) {
    if (by.has(o.code)) throw new Error(`duplicate code ${o.code}: ${by.get(o.code)!.name} / ${o.name}`);
    if (!o.name) throw new Error(`empty name for ${o.code}`);
    by.set(o.code, o);
  }
  for (const o of out) if (o.parent_code && !by.has(o.parent_code)) throw new Error(`${o.code} has no parent ${o.parent_code}`);
  return out.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}

export async function clean() {
  const dump = await readJson<RawDump>(rawPath(RAW_NAME));
  const raw = Object.values(dump.sources)[0]?.[0] as RawTable | undefined;
  if (!raw) throw new Error(`no raw data: ${JSON.stringify(dump.errors)}`);
  const occ = parseTable(raw);
  const n = (l: number) => occ.filter((o) => o.level === l).length;
  const l4 = occ.filter((o) => o.level === 4);
  const counts = {
    1: n(1), 2: n(2), 3: n(3), 4: n(4),
    digital_total_S: l4.filter((o) => o.is_digital).length,
    green_total_L: l4.filter((o) => o.is_green).length,
    both_LS: l4.filter((o) => o.is_digital && o.is_green).length,
    digital_only: l4.filter((o) => o.is_digital && !o.is_green).length,
    green_only: l4.filter((o) => o.is_green && !o.is_digital).length,
  };
  console.log(`[${RAW_NAME}] parsed`, JSON.stringify(counts), 'official', JSON.stringify(OFFICIAL_COUNTS));
  const doc = { doc: raw.doc, fetched_url: raw.fetched_url, fetched_at: raw.fetched_at, sha256: raw.sha256, bytes: raw.bytes };
  await writeJson(cleanPath(RAW_NAME), { doc, counts, occupations: occ });
  console.log(`[${RAW_NAME}] clean: ${occ.length} records -> ${cleanPath(RAW_NAME)}`);
}

if (isMain(import.meta.url)) await clean();
