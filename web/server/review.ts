/**
 * 培养方案 course review API (CAREER major_course rows extracted by the LLM).
 *   GET  /api/review/curriculum/groups                 school x major with counts per review_status
 *   GET  /api/review/curriculum/items?school_id=&major_code=[&needs_review=1][&evidence_type=原文明确|核心课名|课名推断]   (tags: skill + 标签依据 evidence_quote + needs_review)
 *   POST /api/review/curriculum/action  {school_id, major_code, course_id, action: approve|reject|edit, reviewer, edits?, note?}
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { CAREER_DB } from '../../CAREER/db.js';
import { HttpError } from './runs.js';

const open = () => {
  if (!existsSync(CAREER_DB)) throw new HttpError(404, 'career.db not found (run career:all first)');
  const db = new Database(CAREER_DB);
  db.pragma('busy_timeout = 5000');
  return db;
};
const withDb = <T>(f: (db: Database.Database) => T): T => {
  const db = open();
  try { return f(db); } finally { db.close(); }
};

export const review = new Hono();

review.get('/groups', (c) => c.json(withDb((db) => db.prepare(`
  SELECT mc.school_id, s.name AS school_name, mc.major_code, m.name AS major_name, COUNT(*) AS total,
    SUM(mc.review_status = 'pending') AS pending, SUM(mc.review_status = 'approved') AS approved,
    SUM(mc.review_status = 'rejected') AS rejected, SUM(mc.review_status = 'edited') AS edited
  FROM major_course mc JOIN school s ON s.id = mc.school_id LEFT JOIN major m ON m.code = mc.major_code
  WHERE mc.extraction_method = 'llm'
  GROUP BY mc.school_id, mc.major_code ORDER BY s.name, mc.major_code`).all())));

review.get('/items', (c) => {
  const school = c.req.query('school_id'), major = c.req.query('major_code');
  if (!school || !major) throw new HttpError(400, 'school_id and major_code are required');
  const onlyReview = c.req.query('needs_review') === '1';
  const ev = c.req.query('evidence_type') ?? '';
  if (ev && !['原文明确', '核心课名', '课名推断'].includes(ev)) throw new HttpError(400, 'evidence_type must be 原文明确, 核心课名 or 课名推断');
  return c.json(withDb((db) => db.prepare(`
    SELECT mc.school_id, mc.major_code, mc.course_id, co.name, mc.course_type, mc.table_block, mc.module, mc.core_in_section, mc.is_core, mc.credits, mc.hours, mc.semester, mc.source_page,
      mc.snippet, mc.source_url, mc.model, mc.confidence, mc.review_status, mc.reviewer, mc.reviewed_at, mc.review_note, mc.plan_year,
      (SELECT json_group_array(json_object('skill_id', cs.skill_id, 'skill', sk.name, 'skill_type', sk.skill_type, 'evidence_quote', cs.evidence_quote,
          'rationale', cs.rationale, 'needs_review', cs.needs_review, 'review_reason', cs.review_reason, 'evidence_type', cs.evidence_type, 'weight', cs.weight, 'reviewed', cs.reviewed))
        FROM course_skill cs JOIN skill sk ON sk.id = cs.skill_id WHERE cs.course_id = mc.course_id) AS tags_json,
      (SELECT reason FROM course_skill_untagged u WHERE u.course_id = mc.course_id) AS untagged_reason
    FROM major_course mc JOIN course co ON co.id = mc.course_id
    WHERE mc.school_id = ? AND mc.major_code = ?
      AND (? = 0 OR EXISTS (SELECT 1 FROM course_skill cs WHERE cs.course_id = mc.course_id AND cs.needs_review = 1))
      AND (? = '' OR EXISTS (SELECT 1 FROM course_skill cs WHERE cs.course_id = mc.course_id AND cs.evidence_type = ?))
    ORDER BY mc.review_status != 'pending', mc.source_page, co.name`).all(school, major, onlyReview ? 1 : 0, ev, ev)
    .map((r) => { const { tags_json, ...rest } = r as { tags_json: string }; return { ...rest, tags: JSON.parse(tags_json ?? '[]') }; })));
});

const ACTIONS = { approve: 'approved', reject: 'rejected', edit: 'edited' } as const;

review.post('/action', async (c) => {
  const b = (await c.req.json()) as {
    school_id?: string; major_code?: string; course_id?: string; action?: keyof typeof ACTIONS; reviewer?: string; note?: string;
    edits?: { name?: string; course_type?: string; credits?: number | null; hours?: number | null; semester?: string | null };
  };
  if (!b.school_id || !b.major_code || !b.course_id) throw new HttpError(400, 'school_id, major_code, course_id required');
  const status = b.action && ACTIONS[b.action];
  if (!status) throw new HttpError(400, 'action must be approve, reject or edit');
  const reviewer = b.reviewer?.trim();
  if (!reviewer) throw new HttpError(400, 'reviewer is required');
  const e = b.edits ?? {};
  if (e.course_type !== undefined && !['必修', '限选', '任选'].includes(e.course_type)) throw new HttpError(400, 'course_type must be 必修, 限选 or 任选');
  return c.json(withDb((db) => db.transaction(() => {
    const key = [b.school_id, b.major_code, b.course_id];
    const row = db.prepare('SELECT 1 FROM major_course WHERE school_id = ? AND major_code = ? AND course_id = ?').get(...key);
    if (!row) throw new HttpError(404, 'row not found');
    const now = new Date().toISOString();
    if (status === 'edited') {
      db.prepare(`UPDATE major_course SET course_type = COALESCE(@course_type, course_type), credits = @credits, hours = @hours, semester = @semester
        WHERE school_id = @s AND major_code = @m AND course_id = @c`).run({
        course_type: e.course_type ?? null, credits: e.credits ?? null, hours: e.hours ?? null, semester: e.semester ?? null, s: b.school_id, m: b.major_code, c: b.course_id });
      if (e.name?.trim()) db.prepare('UPDATE course SET name = ? WHERE id = ?').run(e.name.trim(), b.course_id);
    }
    db.prepare(`UPDATE major_course SET review_status = ?, reviewed = 1, reviewer = ?, reviewed_at = ?, review_note = ?
      WHERE school_id = ? AND major_code = ? AND course_id = ?`).run(status, reviewer, now, b.note ?? null, ...key);
    if (status !== 'rejected') db.prepare('UPDATE course SET reviewed = 1 WHERE id = ?').run(b.course_id);
    return { ok: true, review_status: status, reviewer, reviewed_at: now };
  })()));
});
