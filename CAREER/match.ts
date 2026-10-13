/**
 * 职业 → 技能 → 专业/课程 → 学校 (deterministic, no LLM).
 *  - loadOccupationSkills: CAREER/seeds/occupation_skills.csv -> occupation_skill (at every ingest).
 *  - matchOccupation: rank every school x major by how well its tagged courses cover the occupation's skills.
 * Scoring per school x major:
 *   for each required skill s: best(s) = max course_skill.weight (原文明确 1.0 / 核心课名 0.8 / 课名推断 0.5) over the major's
 *   courses tagged with s, ignoring tags with needs_review = 1 (listed, flagged) and courses whose review was rejected.
 *   core_score = Σ_core 1.0 × best_required(s), where best_required only looks at courses whose course_type is 必修 or 限选
 *     (NULL type = 任选, expert 2026-10-13). A core skill reached only through 任选 courses is listed as 可选修获得 (elective_only),
 *     not scored and not "missing".
 *   general_score = Σ_general 0.5 × best(s) (任选 courses included);  score = core_score + general_score (shown).
 *   Ranked by core_score (expert 2026-10-13: core coverage decides), general_score only as tie-break, then coverage,
 *   then the number of skills whose best evidence is a 核心课.  coverage = covered skills / required skills.
 *   Ties between courses with the same weight prefer a 核心课 (is_core = 1) as the shown "best course".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { parseCsv } from '../lib/csv.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OCC_SKILLS_CSV = join(HERE, 'seeds', 'occupation_skills.csv');
export const IMPORTANCE_WEIGHT = { core: 1.0, general: 0.5 } as const;
export type Importance = keyof typeof IMPORTANCE_WEIGHT;
const EVIDENCE_WEIGHT: Record<string, number> = { 原文明确: 1.0, 核心课名: 0.8, 课名推断: 0.5 };

/**
 * Upsert the CSV (columns occupation_code, occupation_name?, skill_name | skill_id, importance, source, verified_by, note).
 * Skills are matched by NAME (then alias, then id); unmatched names / unknown occupations are logged as errors and listed,
 * never silently dropped. Rows that disappeared from the CSV are removed (the CSV is the source of truth).
 */
export function loadOccupationSkills(db: Database.Database, path = OCC_SKILLS_CSV, log: (s: string) => void = console.log) {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const occ = db.prepare('SELECT 1 FROM occupation WHERE code = ?');
  const byName = db.prepare(`SELECT id FROM skill WHERE name = @n UNION ALL SELECT skill_id FROM skill_alias WHERE alias = @n UNION ALL SELECT id FROM skill WHERE id = @n`);
  const up = db.prepare(`INSERT INTO occupation_skill (occupation_code, skill_id, importance, source, verified_by, note, extraction_method, reviewed, updated_at)
    VALUES (@o, @s, @i, @src, @v, @n, @m, @r, @t)
    ON CONFLICT (occupation_code, skill_id) DO UPDATE SET importance = excluded.importance, source = excluded.source, verified_by = excluded.verified_by,
      note = excluded.note, extraction_method = excluded.extraction_method, reviewed = excluded.reviewed, updated_at = excluded.updated_at`);
  const keep = new Set<string>();
  const skipped: string[] = [];
  const now = new Date().toISOString();
  for (const r of rows) {
    const o = r.occupation_code?.trim(), sn = (r.skill_name || r.skill_id || '').trim(), i = (r.importance?.trim() || 'general') as Importance;
    if (!o || !sn) continue;
    if (!(i in IMPORTANCE_WEIGHT)) { skipped.push(`${o}/${sn}: importance "${i}"`); continue; }
    if (!occ.get(o)) { skipped.push(`${o}/${sn}: unknown occupation`); continue; }
    const s = (byName.get({ n: sn }) as { id: string } | undefined)?.id;
    if (!s) { skipped.push(`${o}/${sn}: unknown skill name`); continue; }
    const src = r.source?.trim() || 'expert', v = r.verified_by?.trim() || null;
    up.run({ o, s, i, src, v, n: r.note?.trim() || null, m: src === 'example' ? 'manual' : 'expert', r: v ? 1 : 0, t: now });
    keep.add(`${o}\t${s}`);
  }
  let removed = 0;
  for (const x of db.prepare(`SELECT occupation_code o, skill_id s FROM occupation_skill WHERE source IS NOT NULL`).all() as { o: string; s: string }[])
    if (!keep.has(`${x.o}\t${x.s}`)) removed += db.prepare('DELETE FROM occupation_skill WHERE occupation_code = ? AND skill_id = ?').run(x.o, x.s).changes;
  if (skipped.length) console.error(`[career] ERROR occupation_skills.csv: ${skipped.length} row(s) NOT loaded:\n  ${skipped.join('\n  ')}`);
  log(`[career] occupation skills: ${keep.size} loaded, ${skipped.length} skipped, ${removed} removed`);
  return { loaded: keep.size, skipped, removed };
}

export interface OccupationListItem { code: string; name: string; skills: number; core_skills: number; example: number; verified: number }
export function listOccupations(db: Database.Database): OccupationListItem[] {
  return db.prepare(`SELECT o.code, o.name, COUNT(*) skills, SUM(os.importance = 'core') core_skills,
      SUM(os.source = 'example') example, SUM(os.verified_by IS NOT NULL) verified
    FROM occupation_skill os JOIN occupation o ON o.code = os.occupation_code GROUP BY o.code ORDER BY o.code`).all() as OccupationListItem[];
}

export interface CourseEvidence { course_id: string; course: string; is_core: boolean; course_type: string | null; evidence_type: string | null; weight: number; quote: string | null; needs_review: boolean; review_reason: string | null }
export interface SkillMatch { skill_id: string; skill: string; importance: Importance; best: number; best_required: number; covered: boolean; elective_only: boolean; best_course: string | null; courses: CourseEvidence[] }
export interface MajorMatch {
  school_id: string; school: string; major_code: string; major: string | null;
  score: number; core_score: number; general_score: number; max_score: number; score_pct: number; coverage_pct: number; covered: string[]; elective_only: string[]; missing: string[]; flagged: number; skills: SkillMatch[];
}
export interface OccupationMatch {
  occupation: { code: string; name: string }; example_data: boolean; unverified: number;
  skills: { skill_id: string; skill: string; importance: Importance; source: string | null; verified_by: string | null; note: string | null }[];
  weights: { importance: typeof IMPORTANCE_WEIGHT; evidence: Record<string, number> };
  majors: MajorMatch[];
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function matchOccupation(db: Database.Database, code: string): OccupationMatch | null {
  const occ = db.prepare('SELECT code, name FROM occupation WHERE code = ?').get(code) as { code: string; name: string } | undefined;
  if (!occ) return null;
  const skills = db.prepare(`SELECT os.skill_id, s.name skill, os.importance, os.source, os.verified_by, os.note
    FROM occupation_skill os JOIN skill s ON s.id = os.skill_id WHERE os.occupation_code = ? ORDER BY os.importance = 'core' DESC, s.name`).all(code) as OccupationMatch['skills'];
  const base = { occupation: occ, example_data: skills.some((s) => s.source === 'example'), unverified: skills.filter((s) => !s.verified_by).length, skills,
    weights: { importance: IMPORTANCE_WEIGHT, evidence: EVIDENCE_WEIGHT } };
  if (!skills.length) return { ...base, majors: [] };
  const ids = skills.map((s) => s.skill_id);
  const ev = db.prepare(`SELECT mc.school_id, mc.major_code, c.id course_id, c.name course, mc.is_core, mc.course_type, cs.skill_id, cs.evidence_type, cs.weight,
      cs.evidence_quote quote, cs.needs_review, cs.review_reason
    FROM course_skill cs JOIN course c ON c.id = cs.course_id JOIN major_course mc ON mc.course_id = cs.course_id
    WHERE cs.skill_id IN (${ids.map(() => '?').join(',')}) AND COALESCE(mc.review_status, '') != 'rejected'`).all(...ids) as
    { school_id: string; major_code: string; course_id: string; course: string; is_core: number | null; course_type: string | null; skill_id: string; evidence_type: string | null; weight: number | null; quote: string | null; needs_review: number; review_reason: string | null }[];
  const majors = db.prepare(`SELECT DISTINCT mc.school_id, s.name school, mc.major_code, m.name major FROM major_course mc JOIN school s ON s.id = mc.school_id
    LEFT JOIN major m ON m.code = mc.major_code`).all() as { school_id: string; school: string; major_code: string; major: string | null }[];
  const maxScore = skills.reduce((a, s) => a + IMPORTANCE_WEIGHT[s.importance], 0);
  const out: (MajorMatch & { coreBest: number })[] = majors.map((m) => {
    const mine = ev.filter((e) => e.school_id === m.school_id && e.major_code === m.major_code);
    let core = 0, gen = 0, flagged = 0, coreBest = 0;
    const sm: SkillMatch[] = skills.map((s) => {
      const courses: CourseEvidence[] = mine.filter((e) => e.skill_id === s.skill_id).map((e) => ({
        course_id: e.course_id, course: e.course, is_core: e.is_core === 1, course_type: e.course_type, evidence_type: e.evidence_type,
        weight: e.weight ?? EVIDENCE_WEIGHT[e.evidence_type ?? ''] ?? 0, quote: e.quote, needs_review: e.needs_review === 1, review_reason: e.review_reason,
      })).sort((a, b) => Number(a.needs_review) - Number(b.needs_review) || b.weight - a.weight || Number(b.is_core) - Number(a.is_core) || a.course.localeCompare(b.course));
      flagged += courses.filter((c) => c.needs_review).length;
      const ok = courses.filter((c) => !c.needs_review);
      const req = ok.filter((c) => c.course_type === '必修' || c.course_type === '限选');
      const best = ok[0]?.weight ?? 0, bestReq = req[0]?.weight ?? 0;
      const isCore = s.importance === 'core';
      const top = isCore ? req[0] : ok[0];
      if (isCore) core += IMPORTANCE_WEIGHT.core * bestReq; else gen += IMPORTANCE_WEIGHT.general * best;
      if (top?.is_core) coreBest++;
      const covered = isCore ? bestReq > 0 : best > 0;
      return { skill_id: s.skill_id, skill: s.skill, importance: s.importance, best, best_required: bestReq, covered, elective_only: isCore && !covered && best > 0,
        best_course: top?.course ?? null, courses };
    });
    const covered = sm.filter((s) => s.covered).map((s) => s.skill);
    return { ...m, score: r3(core + gen), core_score: r3(core), general_score: r3(gen), max_score: maxScore, score_pct: r3((core + gen) / maxScore), coverage_pct: r3(covered.length / skills.length), covered,
      elective_only: sm.filter((s) => s.elective_only).map((s) => s.skill),
      missing: sm.filter((s) => !s.covered && !s.elective_only).map((s) => s.skill), flagged, skills: sm, coreBest };
  });
  out.sort((a, b) => b.core_score - a.core_score || b.general_score - a.general_score || b.coverage_pct - a.coverage_pct || b.coreBest - a.coreBest || a.school.localeCompare(b.school) || a.major_code.localeCompare(b.major_code));
  return { ...base, majors: out.map(({ coreBest: _c, ...m }) => m) };
}
