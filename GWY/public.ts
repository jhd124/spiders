/**
 * Student-facing 国考 summary for one 本科 major (block 「能报考的国考岗位」 on the major page). Read-only, no LLM.
 *  - 本科 basis: gwy_position_undergrad_major (needs_grad = 0 positions whose 专业 admits the major, classes expanded)
 *  - 党员: 政治面貌 is exactly 中共党员 (「中共党员或共青团员」 does not require 党员)
 *  - 限应届: 备注 restricts to 应届/20xx届 高校毕业生 (「非应届…」 clauses are ignored)
 *  - 需读研后报考: needs_grad = 1 positions whose 专业 lists this 本科 major (or its 专业类 / 门类) for the 本科 stage
 */
import type Database from 'better-sqlite3';

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
  // 需读研: major_code tokens are 本科 when the row's catalog is undergrad or the token says undergrad:
  const cls = major.slice(0, 4), cat = major.slice(0, 2), bare = major.replace(/[A-Z]+$/, '');
  const rows = db.prepare(`SELECT p.dept_code, p.position_code, p.hires, m.catalog, m.major_code FROM gwy_position p JOIN gwy_position_major m
    ON m.notice_id = p.notice_id AND m.dept_code = p.dept_code AND m.position_code = p.position_code
    WHERE p.notice_id = ? AND p.needs_grad = 1 AND m.major_code IS NOT NULL`).all(noticeId) as { dept_code: string; position_code: string; hires: number; catalog: string | null; major_code: string }[];
  const ng = new Map<string, number>();
  for (const r of rows) {
    const hit = r.major_code.split('|').some((t) => {
      const ugTok = t.startsWith('undergrad:') || (r.catalog === 'undergrad' && !t.includes(':'));
      const c = t.replace(/^undergrad:/, '');
      return ugTok && (c === major || c === bare || c === cls || c === cat);
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
