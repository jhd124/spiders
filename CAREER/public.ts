/**
 * Student-facing read-only views (/api/public/*, pages /s/). Scoring is CAREER/match.ts matchOccupation (not duplicated here);
 * this module only selects the student fields: no evidence quotes, review flags, weights, verifiers or admin notes.
 * Only courses with a non-needs_review tag are shown; practice courses (课程设计/实验/实习/实训/实践, expert 2026-10-15) are hidden
 *  from students whatever the tag source (admin keeps them; scoring is unchanged). "covered" for a core skill = taught by a 必修/限选 course (match.ts rule).
 */
import type Database from 'better-sqlite3';
import { matchOccupation, type MajorMatch } from './match.js';
import { skillComparison } from '../JOBS/compare.js';
import { isPracticeCourse } from './curriculum/tag.js';

export const MIN_PCT_SAMPLES = 30;
export const FOOTER = '本结果依据各校公开的培养方案和招聘数据，反映的是课程设置，不代表教学质量或就业结果。目前只收录了 3 所试点学校。';
const EDU_ORDER = ['全部', '不限', '大专', '本科', '硕士', '博士'];
const badge = (t: string | null) => (t === '必修' || t === '限选' ? t : '任选');
const label = (n: number, m: number) => `核心能力 ${n}/${m}`;
/** the sample is a campus job board: never call it 全国 */
const noNational = (s: string | null) => (s ?? '').replace(/全国/g, '全部城市');

export interface PublicOccupation { code: string; display_name: string; official_name: string; aliases: string[]; core_skills: number; skills: number }

export function publicOccupations(db: Database.Database): PublicOccupation[] {
  return (db.prepare(`SELECT d.code, d.display_name, d.official_name, d.search_aliases,
      (SELECT count(*) FROM occupation_skill os WHERE os.occupation_code = d.code AND os.importance = 'core') core_skills,
      (SELECT count(*) FROM occupation_skill os WHERE os.occupation_code = d.code) skills
    FROM occupation_display d ORDER BY d.code`).all() as { code: string; display_name: string; official_name: string; search_aliases: string; core_skills: number; skills: number }[])
    .map((r) => ({ code: r.code, display_name: r.display_name, official_name: r.official_name, aliases: r.search_aliases ? r.search_aliases.split('|') : [], core_skills: r.core_skills, skills: r.skills }));
}

const display = (db: Database.Database, code: string) =>
  db.prepare('SELECT code, display_name, official_name FROM occupation_display WHERE code = ?').get(code) as { code: string; display_name: string; official_name: string } | undefined;

const majorRow = (m: MajorMatch) => ({ school_id: m.school_id, school: m.school, major_code: m.major_code, major: m.major ?? m.major_code,
  core_covered: m.core_covered, core_total: m.core_total, label: label(m.core_covered, m.core_total) });

export function publicSalary(db: Database.Database, code: string) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'salary_overview'").get();
  if (!has) return [];
  const rows = db.prepare('SELECT education, window, sample_size, p25_month, p50_month, p75_month, source_label, low_sample FROM salary_overview WHERE occupation_code = ?').all(code) as
    { education: string; window: string; sample_size: number; p25_month: number | null; p50_month: number | null; p75_month: number | null; source_label: string | null; low_sample: number }[];
  return rows.map((r) => {
    const pct = r.sample_size >= MIN_PCT_SAMPLES;
    return { education: r.education, window: r.window, sample_size: r.sample_size,
      p25: pct ? r.p25_month : null, p50: pct ? r.p50_month : null, p75: pct ? r.p75_month : null,
      source_label: noNational(r.source_label), note: r.low_sample ? '样本较少，仅供参考' : '' };
  }).sort((a, b) => EDU_ORDER.indexOf(a.education) - EDU_ORDER.indexOf(b.education));
}

export function publicDemand(db: Database.Database, code: string, top = 10) {
  const c = skillComparison(db, { occupation: code })[0];
  if (!c || !c.eligible) return { postings: 0, skills: [] as { skill: string; pct: number; listed: boolean }[] };
  return { postings: c.eligible, skills: c.rows.filter((r) => r.postings > 0).slice(0, top).map((r) => ({ skill: r.skill_name, pct: r.freq_pct, listed: r.status !== '未列入' })) };
}

export function publicOccupation(db: Database.Database, code: string) {
  const d = display(db, code);
  const m = d && matchOccupation(db, code);
  if (!d || !m) return null;
  return {
    code, display_name: d.display_name, official_name: d.official_name,
    core_skills: m.skills.filter((s) => s.importance === 'core').map((s) => s.skill),
    general_skills: m.skills.filter((s) => s.importance !== 'core').map((s) => s.skill),
    salary: publicSalary(db, code),
    demand: publicDemand(db, code),
    majors: m.majors.map(majorRow),
  };
}

export function publicMajorForOccupation(db: Database.Database, code: string, school: string, major: string) {
  const d = display(db, code);
  const m = d && matchOccupation(db, code);
  const mm = m?.majors.find((x) => x.school_id === school && x.major_code === major);
  if (!d || !mm) return null;
  const courses = (s: MajorMatch['skills'][number]) => {
    const seen = new Set<string>();
    return s.courses.filter((c) => !c.needs_review && !isPracticeCourse(c.course) && !seen.has(c.course) && seen.add(c.course))
      .map((c) => ({ course: c.course, type: badge(c.course_type) }))
      .sort((a, b) => ['必修', '限选', '任选'].indexOf(a.type) - ['必修', '限选', '任选'].indexOf(b.type));
  };
  const core = mm.skills.filter((s) => s.importance === 'core');
  return {
    occupation: { code, display_name: d.display_name, official_name: d.official_name },
    school_id: mm.school_id, school: mm.school, major_code: mm.major_code, major: mm.major ?? mm.major_code,
    core_covered: mm.core_covered, core_total: mm.core_total, label: label(mm.core_covered, mm.core_total),
    sentence: `必修和限选课教到了 ${mm.core_total} 项核心能力中的 ${mm.core_covered} 项`,
    covered: core.filter((s) => s.covered).map((s) => ({ skill: s.skill, courses: courses(s) })),
    to_supplement: core.filter((s) => !s.covered).map((s) => ({ skill: s.skill, courses: courses(s) })),
    general: mm.skills.filter((s) => s.importance !== 'core').map((s) => ({ skill: s.skill, covered: s.covered, courses: courses(s) })),
  };
}

export function publicMajors(db: Database.Database) {
  return db.prepare(`SELECT DISTINCT mc.school_id, s.name school, mc.major_code, COALESCE(m.name, mc.major_code) major
    FROM major_course mc JOIN school s ON s.id = mc.school_id LEFT JOIN major m ON m.code = mc.major_code ORDER BY s.name, mc.major_code`).all() as
    { school_id: string; school: string; major_code: string; major: string }[];
}

export function publicMajor(db: Database.Database, school: string, major: string) {
  const info = publicMajors(db).find((x) => x.school_id === school && x.major_code === major);
  if (!info) return null;
  const occs = publicOccupations(db).flatMap((o) => {
    const mm = matchOccupation(db, o.code)?.majors.find((x) => x.school_id === school && x.major_code === major);
    return mm ? [{ code: o.code, display_name: o.display_name, official_name: o.official_name, core_covered: mm.core_covered, core_total: mm.core_total,
      label: label(mm.core_covered, mm.core_total), _c: mm.core_coverage, _g: mm.general_coverage }] : [];
  }).sort((a, b) => b._c - a._c || b.core_covered - a.core_covered || b._g - a._g || a.code.localeCompare(b.code)).map(({ _c, _g, ...r }) => r);
  // expert 2026-10-15: 0/N occupations are not rows; the page folds them into one line 课程基本不涉及：…
  return { ...info, occupations: occs.filter((o) => o.core_covered > 0), not_covered: occs.filter((o) => o.core_covered === 0).map((o) => o.display_name) };
}
