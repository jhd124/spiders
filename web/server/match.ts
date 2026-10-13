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
import { HttpError } from './runs.js';

const withDb = <T>(f: (db: Database.Database) => T): T => {
  if (!existsSync(CAREER_DB)) throw new HttpError(404, 'career.db not found (run career:all first)');
  const db = new Database(CAREER_DB);
  db.pragma('busy_timeout = 5000');
  try { return f(db); } finally { db.close(); }
};

/** Called after the CAREER migrations at server start; failures are logged, never block startup. */
export function syncOccupationSkills() {
  try {
    if (existsSync(CAREER_DB)) withDb((db) => db.transaction(() => loadOccupationSkills(db))());
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
