/**
 * 职业 → 技能 → 专业/课程 → 学校 (deterministic, no LLM).
 *   GET /api/match/occupations          occupations that have a skill mapping
 *   GET /api/match/occupation/:code     required skills + ranked school x major with per-skill courses, evidence_type, quote
 * The seed CSV (CAREER/seeds/occupation_skills.csv) is (re)loaded at server start and at every career ingest.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { CAREER_DB } from '../../CAREER/db.js';
import { listOccupations, loadOccupationSkills, matchOccupation } from '../../CAREER/match.js';
import { addAlias, applyAliasRules, deleteAlias, exportAliasesCsv, listAliases, loadSkillAliases } from '../../CAREER/aliases.js';
import { HttpError } from './runs.js';
import { skillComparison } from '../../JOBS/compare.js';

const withDb = <T>(f: (db: Database.Database) => T): T => {
  if (!existsSync(CAREER_DB)) throw new HttpError(404, 'career.db not found (run career:all first)');
  const db = new Database(CAREER_DB);
  db.pragma('busy_timeout = 5000');
  try { return f(db); } finally { db.close(); }
};

/** Called after the CAREER migrations at server start; failures are logged, never block startup. */
export function syncOccupationSkills() {
  try {
    if (existsSync(CAREER_DB)) withDb((db) => db.transaction(() => {
      loadSkillAliases(db);
      const a = applyAliasRules(db);
      console.log(`[career] deterministic rules at start: course_type filled from block ${a.types}; block type config ${a.blocks.updated} rows set (${a.blocks.matched} matched)`
        + `; alias tags: ${a.tags.matched} course×alias matches, +${a.tags.inserted} new, ${a.tags.took_over} took over flagged/weaker unreviewed rows, ${a.tags.kept} kept existing, ${a.tags.rejected} expert-rejected, -${a.tags.deleted} stale`
        + `; 核心课名 re-typed ${a.core_name_retyped}`);
      if (a.blocks.unmatched.length) console.error(`[career] ERROR curriculum_block_types.csv rows matching nothing: ${a.blocks.unmatched.join('; ')}`);
      loadOccupationSkills(db);
    })());
  } catch (err) {
    console.error('[career] occupation skills load failed:', err);
  }
}

export const match = new Hono();
match.get('/occupations', (c) => c.json(withDb((db) => listOccupations(db))));
match.get('/occupation/:code', (c) => {
  const r = withDb((db) => matchOccupation(db, c.req.param('code')));
  if (!r) throw new HttpError(404, `no occupation ${c.req.param('code')}`);
  return c.json(r);
});

/* ---------- skill aliases (expert-maintained; #/aliases) ---------- */
export const aliases = new Hono();
const fail = (e: unknown): never => { throw new HttpError(400, (e as Error).message); };
aliases.get('/', (c) => c.json(withDb((db) => ({
  aliases: listAliases(db),
  skills: db.prepare('SELECT id, name, skill_type FROM skill ORDER BY primary_domain_id, name').all(),
}))));
aliases.post('/', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { alias?: string; skill?: string; by?: string; match?: string };
  if (!b.alias?.trim() || !b.skill || !b.by?.trim()) throw new HttpError(400, 'alias, skill and by are required');
  return c.json(withDb((db) => { try { return addAlias(db, b.alias!, b.skill!, b.by!.trim(), b.match === 'exact' ? 'exact' : 'contains'); } catch (e) { return fail(e); } }), 201);
});
aliases.delete('/:alias', (c) => {
  const by = c.req.query('by')?.trim();
  if (!by) throw new HttpError(400, 'by is required');
  return c.json(withDb((db) => { try { return deleteAlias(db, decodeURIComponent(c.req.param('alias')), by); } catch (e) { return fail(e); } }));
});
aliases.get('/export.csv', (c) => {
  c.header('Content-Disposition', 'attachment; filename="skill_aliases.csv"');
  return c.body(withDb((db) => exportAliasesCsv(db)), 200, { 'Content-Type': 'text/csv; charset=utf-8' });
});

/* ---------- 岗位技能需求: occupation skill list vs job postings (#/jobs) ---------- */
export const jobs = new Hono();
jobs.get('/compare', (c) => c.json(withDb((db) => skillComparison(db, { occupation: c.req.query('occupation') || undefined }))));
