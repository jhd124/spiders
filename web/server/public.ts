/**
 * Student API (no auth; nginx exposes only /s/ and /api/public/): read-only GET, student fields only (CAREER/public.ts).
 *   GET /api/public/occupations                         11 occupations with display names
 *   GET /api/public/occupation/:code                    skills, salary by education, job-ad skill demand, ranked majors
 *   GET /api/public/occupation/:code/major/:school/:major   per core skill: courses with 必修/限选/任选 badge
 *   GET /api/public/majors                              school x major list
 *   GET /api/public/major/:school/:major                occupations ranked by core coverage
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { CAREER_DB } from '../../CAREER/db.js';
import { FOOTER, publicMajor, publicMajorForOccupation, publicMajors, publicOccupation, publicOccupations } from '../../CAREER/public.js';

const ro = <T>(f: (db: Database.Database) => T): T | null => {
  if (!existsSync(CAREER_DB)) return null;
  const db = new Database(CAREER_DB, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try { return f(db); } finally { db.close(); }
};

export const publicApi = new Hono();
publicApi.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.json({ error: 'read-only' }, 405);
  await next();
  c.header('Cache-Control', 'public, max-age=300');
});
const send = (c: import('hono').Context, v: unknown) => (v == null ? c.json({ error: 'not found' }, 404) : c.json(v));
publicApi.get('/meta', (c) => c.json({ footer: FOOTER }));
publicApi.get('/occupations', (c) => send(c, ro(publicOccupations)));
publicApi.get('/occupation/:code', (c) => send(c, ro((db) => publicOccupation(db, c.req.param('code')))));
publicApi.get('/occupation/:code/major/:school/:major', (c) =>
  send(c, ro((db) => publicMajorForOccupation(db, c.req.param('code'), decodeURIComponent(c.req.param('school')), c.req.param('major')))));
publicApi.get('/majors', (c) => send(c, ro(publicMajors)));
publicApi.get('/major/:school/:major', (c) => send(c, ro((db) => publicMajor(db, decodeURIComponent(c.req.param('school')), c.req.param('major')))));
publicApi.all('*', (c) => c.json({ error: 'not found' }, 404));
