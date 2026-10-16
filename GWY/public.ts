/**
 * Student-facing 国考 summary for one 本科 major (block 「能报考的国考岗位」 on the major page). Read-only, no LLM.
 *  - 本科 basis: gwy_position_undergrad_major (needs_grad = 0 positions whose 专业 admits the major, classes expanded)
 *  - 党员: 政治面貌 is exactly 中共党员 (「中共党员或共青团员」 does not require 党员)
 *  - 限应届: 备注 restricts to 应届/20xx届 高校毕业生 (「非应届…」 clauses are ignored)
 *  - 读对口研究生后可报: needs_grad = 1 positions whose 专业 lists this 本科 major (or its 专业类 / 门类) for the 本科 stage,
 *    OR any 研究生 一级学科/专硕类别 mapped from the major's 专业类 in GWY/rules/grad_pathway.csv (catalogs kept separate)
 */
import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './parse.js';

/** 本科专业类 → 对口研究生 一级学科/专硕类别 (expert 2026-10-16; used by publicGwyForMajor) */
export const GRAD_PATHWAY_CSV = join(dirname(fileURLToPath(import.meta.url)), 'rules', 'grad_pathway.csv');
export interface GradPathway { ug_class: string; grad_code: string; grad_kind: 'academic' | 'professional'; reviewed: boolean }
export function loadGradPathway(path = GRAD_PATHWAY_CSV): Map<string, GradPathway[]> {
  const out = new Map<string, GradPathway[]>();
  if (!existsSync(path)) return out;
  const text = readFileSync(path, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  for (const r of parseCsv(text)) {
    const ug = (r.ug_class ?? '').trim(), g = (r.grad_code ?? '').trim(), k = (r.grad_kind ?? '').trim();
    if (!/^\d{4}$/.test(ug) || !/^\d{4}$/.test(g) || (k !== 'academic' && k !== 'professional')) { if (ug || g) throw new Error(`grad_pathway.csv: bad row ${JSON.stringify(r)}`); continue; }
    out.set(ug, [...(out.get(ug) ?? []), { ug_class: ug, grad_code: g, grad_kind: k, reviewed: r.reviewed === '1' }]);
  }
  return out;
}

export const GWY_SOURCE_NOTE = '来源：2027 年度国考职位表；部分岗位的专业要求尚未归类';

export function isFreshGradOnly(remarks: string | null): boolean {
  const s = (remarks ?? '').replace(/非(?:20\d\d届|应届)(?:高校)?毕业生/g, '');
  return /(?:^|[。；;，,、.\s\d）)]|限|仅限)(?:20\d\d届|应届)(?:高校)?毕业生/.test(s);
}
export const isPartyOnly = (political: string | null) => (political ?? '').trim() === '中共党员';

const share = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export interface GwyForMajor {
  notice: { id: string; title: string }; major_code: string;
  undergrad: { positions: number; hires: number; party: { positions: number; pct: number }; fresh_grad: { positions: number; pct: number } };
  needs_grad: { positions: number; hires: number };
  note: string;
}

export function publicGwyForMajor(db: Database.Database, major: string, noticeId = 'gk2027'): GwyForMajor | null {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gwy_position_undergrad_major'").get();
  if (!has) return null;
  const notice = db.prepare('SELECT id, title FROM gwy_notice WHERE id = ?').get(noticeId) as { id: string; title: string } | undefined;
  if (!notice) return null;
  const ug = db.prepare(`SELECT p.hires, p.political, p.remarks FROM gwy_position p JOIN gwy_position_undergrad_major u
    ON u.notice_id = p.notice_id AND u.dept_code = p.dept_code AND u.position_code = p.position_code
    WHERE p.notice_id = ? AND u.major_code = ? AND p.needs_grad = 0`).all(noticeId, major) as { hires: number; political: string | null; remarks: string | null }[];
  const party = ug.filter((r) => isPartyOnly(r.political)).length, fresh = ug.filter((r) => isFreshGradOnly(r.remarks)).length;
  // 读对口研究生后可报: undergrad-catalog matches (major / 专业类 / 门类) OR graduate-catalog codes from grad_pathway.csv
  const cls = major.slice(0, 4), cat = major.slice(0, 2), bare = major.replace(/[A-Z]+$/, '');
  const pathway = new Set((loadGradPathway().get(cls) ?? []).map((x) => x.grad_code));
  const rows = db.prepare(`SELECT p.dept_code, p.position_code, p.hires, m.catalog, m.major_code FROM gwy_position p JOIN gwy_position_major m
    ON m.notice_id = p.notice_id AND m.dept_code = p.dept_code AND m.position_code = p.position_code
    WHERE p.notice_id = ? AND p.needs_grad = 1 AND m.major_code IS NOT NULL`).all(noticeId) as { dept_code: string; position_code: string; hires: number; catalog: string | null; major_code: string }[];
  const ng = new Map<string, number>();
  for (const r of rows) {
    const hit = r.major_code.split('|').some((t) => {
      const bareTok = t.replace(/^(?:undergrad|grad):/, '');
      // undergrad catalog only: never treat a bare 4-digit as both catalogs (0808 自动化类 ≠ 0808 电气工程)
      if (t.startsWith('undergrad:') || (r.catalog === 'undergrad' && !t.includes(':')))
        return bareTok === major || bareTok === bare || bareTok === cls || bareTok === cat;
      // graduate catalog only: 4-digit codes that the expert mapped for this 专业类 (no bare 2-digit 门类)
      if (pathway.size && (t.startsWith('grad:') || (r.catalog === 'grad' && !t.includes(':'))))
        return pathway.has(bareTok);
      return false;
    });
    if (hit) ng.set(`${r.dept_code}/${r.position_code}`, r.hires);
  }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return {
    notice, major_code: major,
    undergrad: { positions: ug.length, hires: sum(ug.map((r) => r.hires)), party: { positions: party, pct: share(party, ug.length) }, fresh_grad: { positions: fresh, pct: share(fresh, ug.length) } },
    needs_grad: { positions: ng.size, hires: sum([...ng.values()]) },
    note: GWY_SOURCE_NOTE,
  };
}

