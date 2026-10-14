/**
 * Occupation skill list (CAREER/seeds/occupation_skills.csv -> occupation_skill) vs. skills found in job postings.
 *   npm run jobs:compare [-- --occupation=2-02-10-03] [--gap-high=20] [--core-low=5]
 * Eligible postings: classified (occupation_code set), JD not too short (jd_too_short = 0), all years.
 * Both sides use skill.id (occupation_skill.skill_id and job_posting_skill.skill_id reference the same skill table).
 * Flags: 高频未列入 = not in the occupation list and freq >= JOBS_GAP_HIGH % (default 20);
 *        核心低频   = core in the list and freq < JOBS_CORE_LOW % (default 5).
 */
import Database from 'better-sqlite3';
import { CAREER_DB } from '../CAREER/db.js';
import { migrate } from '../CAREER/migrate.js';
import { isMain } from '../lib/main.js';

const num = (v: string | undefined, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
export const MIN_JD_CHARS = () => num(process.env.JOBS_MIN_JD_CHARS, 50);
export const GAP_HIGH = () => num(process.env.JOBS_GAP_HIGH, 20);
export const CORE_LOW = () => num(process.env.JOBS_CORE_LOW, 5);

/** JD length after cleaning: all whitespace removed, counted in characters (code points) */
export function jdCleanLength(jd: string | null | undefined): number {
  return [...(jd ?? '').replace(/\s+/g, '')].length;
}

/** recompute job_posting.jd_too_short for every posting (called by reclassifyAll on ingest/reclassify) */
export function updateShortJdFlags(db: Database.Database, min = MIN_JD_CHARS()) {
  const rows = db.prepare('SELECT id, jd_text, jd_too_short FROM job_posting').all() as { id: string; jd_text: string | null; jd_too_short: number }[];
  const upd = db.prepare('UPDATE job_posting SET jd_too_short = ? WHERE id = ?');
  let flagged = 0;
  db.transaction(() => {
    for (const r of rows) {
      const f = jdCleanLength(r.jd_text) < min ? 1 : 0;
      flagged += f;
      if (f !== r.jd_too_short) upd.run(f, r.id);
    }
  })();
  return { min, flagged, total: rows.length };
}

export type SkillStatus = 'core' | 'general' | '未列入';
export interface CompareRow { skill_id: string; skill_name: string; status: SkillStatus; postings: number; eligible: number; freq_pct: number; flag: '' | '高频未列入' | '核心低频' }
export interface OccupationCompare {
  occupation_code: string; occupation_name: string;
  eligible: number; too_short: number; sample_from: string | null; sample_to: string | null;
  gap_high: number; core_low: number; rows: CompareRow[];
}

export function skillComparison(db: Database.Database, opts: { occupation?: string; gapHigh?: number; coreLow?: number } = {}): OccupationCompare[] {
  const gapHigh = opts.gapHigh ?? GAP_HIGH(), coreLow = opts.coreLow ?? CORE_LOW();
  const occs = db.prepare(`SELECT o.code, o.name FROM occupation o
      WHERE (EXISTS (SELECT 1 FROM occupation_skill s WHERE s.occupation_code = o.code) OR EXISTS (SELECT 1 FROM job_posting p WHERE p.occupation_code = o.code))
      ${opts.occupation ? 'AND o.code = ?' : ''} ORDER BY o.code`).all(...(opts.occupation ? [opts.occupation] : [])) as { code: string; name: string }[];
  const sampleQ = db.prepare(`SELECT sum(jd_too_short = 0) eligible, sum(jd_too_short = 1) too_short,
      min(CASE WHEN jd_too_short = 0 THEN coalesce(published_at, fetched_at) END) d_min, max(CASE WHEN jd_too_short = 0 THEN coalesce(published_at, fetched_at) END) d_max
      FROM job_posting WHERE occupation_code = ?`);
  const hitsQ = db.prepare(`SELECT k.skill_id, count(DISTINCT p.id) n FROM job_posting p JOIN job_posting_skill k ON k.posting_id = p.id
      WHERE p.occupation_code = ? AND p.jd_too_short = 0 GROUP BY k.skill_id`);
  const listQ = db.prepare('SELECT skill_id, importance FROM occupation_skill WHERE occupation_code = ?');
  const names = new Map((db.prepare('SELECT id, name FROM skill').all() as { id: string; name: string }[]).map((r) => [r.id, r.name]));
  return occs.map((o) => {
    const s = sampleQ.get(o.code) as { eligible: number | null; too_short: number | null; d_min: string | null; d_max: string | null };
    const eligible = s.eligible ?? 0;
    const hits = new Map((hitsQ.all(o.code) as { skill_id: string; n: number }[]).map((r) => [r.skill_id, r.n]));
    const listed = new Map((listQ.all(o.code) as { skill_id: string; importance: string }[]).map((r) => [r.skill_id, r.importance === 'core' ? 'core' as const : 'general' as const]));
    const ids = new Set([...listed.keys(), ...hits.keys()]);
    const rows: CompareRow[] = [...ids].map((id) => {
      const n = hits.get(id) ?? 0;
      const freq = eligible ? Math.round((1000 * n) / eligible) / 10 : 0;
      const status: SkillStatus = listed.get(id) ?? '未列入';
      const flag = status === '未列入' && eligible > 0 && freq >= gapHigh ? '高频未列入' : status === 'core' && eligible > 0 && freq < coreLow ? '核心低频' : '';
      return { skill_id: id, skill_name: names.get(id) ?? id, status, postings: n, eligible, freq_pct: freq, flag };
    });
    const rank = { core: 0, general: 1, 未列入: 2 } as const;
    rows.sort((a, b) => b.freq_pct - a.freq_pct || rank[a.status] - rank[b.status] || a.skill_name.localeCompare(b.skill_name, 'zh'));
    return { occupation_code: o.code, occupation_name: o.name, eligible, too_short: s.too_short ?? 0, sample_from: s.d_min?.slice(0, 10) ?? null, sample_to: s.d_max?.slice(0, 10) ?? null, gap_high: gapHigh, core_low: coreLow, rows };
  });
}

const STATUS_LABEL: Record<SkillStatus, string> = { core: '核心', general: '一般', 未列入: '未列入' };

/** plain-text table for pasting into chat; by default only listed skills + skills with freq >= minPct */
export function formatComparison(list: OccupationCompare[], opts: { all?: boolean; minPct?: number } = {}): string {
  const minPct = opts.minPct ?? 5;
  const out: string[] = [];
  for (const o of list) {
    out.push(`## ${o.occupation_code} ${o.occupation_name}`);
    out.push(`样本：${o.eligible} 条（已归类、描述不少于阈值，全部年份 ${o.sample_from ?? '—'} ~ ${o.sample_to ?? '—'}；描述过短未计入 ${o.too_short} 条）。标记：未列入且 ≥${o.gap_high}% = 高频未列入；核心且 <${o.core_low}% = 核心低频`);
    out.push('| 技能 | id | 清单 | 岗位数 | 占比 | 标记 |', '|---|---|---|---|---|---|');
    const shown = o.rows.filter((r) => opts.all || r.status !== '未列入' || r.freq_pct >= minPct);
    for (const r of shown) out.push(`| ${r.skill_name} | ${r.skill_id} | ${STATUS_LABEL[r.status]} | ${r.postings}/${r.eligible} | ${r.freq_pct}% | ${r.flag} |`);
    const hidden = o.rows.length - shown.length;
    if (hidden) out.push(`（另有 ${hidden} 项未列入技能占比 < ${minPct}%，加 --all 显示）`);
    out.push('');
  }
  return out.join('\n');
}

if (isMain(import.meta.url)) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
  migrate(CAREER_DB, () => {});
  const db = new Database(CAREER_DB, { readonly: true });
  try {
    const list = skillComparison(db, { occupation: arg('occupation'), gapHigh: arg('gap-high') ? Number(arg('gap-high')) : undefined, coreLow: arg('core-low') ? Number(arg('core-low')) : undefined });
    if (!list.length) console.log('no occupation found');
    console.log(formatComparison(list, { all: process.argv.includes('--all'), minPct: arg('min-pct') ? Number(arg('min-pct')) : undefined }));
  } finally { db.close(); }
}
