/**
 * Which course names each expert alias hits (contains or exact match, practice courses skipped, same rules as tag.ts applyAliasTags), read-only, no LLM:
 *   npx tsx CAREER/tools/alias_hits.ts [skill_id ...] [--db=path]
 *   e.g. npx tsx CAREER/tools/alias_hits.ts software.testing software.architecture software.distributed software.cloud
 * No skill ids = every alias. Per course: school, major codes, course type, and the current course_skill tag (source/evidence/review).
 */
import Database from 'better-sqlite3';
import { CAREER_DB } from '../db.js';
import { aliasHits } from '../curriculum/tag.js';

const args = process.argv.slice(2);
const ids = args.filter((a) => !a.startsWith('--'));
const db = new Database(args.find((a) => a.startsWith('--db='))?.slice(5) ?? CAREER_DB, { readonly: true });
const aliases = db.prepare(`SELECT a.alias, a.skill_id, a.match, s.name skill FROM skill_alias a JOIN skill s ON s.id = a.skill_id
  ${ids.length ? `WHERE a.skill_id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY a.skill_id, a.alias`).all(...ids) as { alias: string; skill_id: string; match: string; skill: string }[];
if (!aliases.length) { console.error(`no aliases for ${ids.join(', ') || '(any skill)'} (run the server / career:ingest first so the seed is loaded)`); process.exit(1); }
const courses = db.prepare('SELECT id, school_id, name FROM course ORDER BY school_id, name').all() as { id: string; school_id: string; name: string }[];
const mc = db.prepare(`SELECT group_concat(DISTINCT major_code) majors, group_concat(DISTINCT COALESCE(course_type, '?')) types FROM major_course WHERE course_id = ?`);
const tag = db.prepare('SELECT source, evidence_type, weight, needs_review, reviewed FROM course_skill WHERE course_id = ? AND skill_id = ?');
let last = '';
for (const a of aliases) {
  if (a.skill_id !== last) { console.log(`\n== ${a.skill_id} ${a.skill}`); last = a.skill_id; }
  const hits = courses.filter((c) => aliasHits(a.alias, a.match, c.name));
  console.log(`  alias「${a.alias}」${a.match === 'exact' ? ' (exact)' : ''}: ${hits.length} course(s)`);
  for (const c of hits) {
    const m = mc.get(c.id) as { majors: string | null; types: string | null };
    const t = tag.get(c.id, a.skill_id) as { source: string; evidence_type: string; weight: number; needs_review: number; reviewed: number } | undefined;
    console.log(`    ${c.school_id}  ${c.name}  [${m.majors ?? '-'}] ${m.types ?? '-'}  tag: ${t ? `${t.source} ${t.evidence_type} ${t.weight}${t.needs_review ? ' needs_review' : ''}${t.reviewed ? ' reviewed' : ''}` : 'NONE'}`);
  }
}
db.close();
