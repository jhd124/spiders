/**
 * Print the 职业 → 专业 ranking (same code as the admin page), no LLM:
 *   npx tsx CAREER/tools/match_occupation.ts [occupation_code=2-02-38-01] [--load] [--db=path]
 *   --load  (re)load CAREER/seeds/occupation_skills.csv first (otherwise the server start / ingest already did)
 */
import Database from 'better-sqlite3';
import { CAREER_DB } from '../db.js';
import { loadOccupationSkills, matchOccupation } from '../match.js';

const args = process.argv.slice(2);
const code = args.find((a) => !a.startsWith('--')) ?? '2-02-38-01';
const db = new Database(args.find((a) => a.startsWith('--db='))?.slice(5) ?? CAREER_DB);
if (args.includes('--load')) db.transaction(() => loadOccupationSkills(db))();
const r = matchOccupation(db, code);
if (!r) { console.error(`no occupation ${code}`); process.exit(1); }
console.log(`${r.occupation.code} ${r.occupation.name}  skills=${r.skills.length}  example=${r.example_data}  unverified=${r.unverified}`);
r.majors.forEach((m, i) => console.log(`${String(i + 1).padStart(2)}. ${m.school} ${m.major_code} ${m.major ?? ''}  ${m.core_label}  ${m.general_label}  (tiebreak 加权 core=${m.core_score} general=${m.general_score}) flagged=${m.flagged}  可选修获得: ${m.elective_only.join('、') || '-'}  missing: ${m.missing.join('、') || '-'}`));
db.close();
