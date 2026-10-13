/**
 * Ingest stage for 培养方案 courses (called from CAREER/ingest.ts inside its transaction).
 *  - syncs seeds/curriculum_sources.csv -> curriculum_source (+ school rows for unknown schools)
 *  - records each fetched document in source_document (sha256, bytes)
 *  - upserts course / major_course with provenance (extraction_method='llm', model, confidence, page, snippet, reviewed=0)
 *  - SKIPS mock results (no LLM configured) — mock output is never stored as data
 *  - never overwrites a major_course row the expert already approved/rejected/edited
 */
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { cleanPath, rawPath } from '../../lib/io.js';
import { isMultiMajor, majorCodes, readManifest } from './manifest.js';
import { RAW_NAME, type RawCurriculum } from './crawler.js';
import type { CleanCurriculum } from './clean.js';
import { normCourseName } from './extract.js';

/** 1 = listed in the 核心课程 paragraph, NULL = only the table block says 专业核心 (expert rule pending), 0 = neither */
export const isCoreValue = (c: { core_in_section: boolean; block: string | null }) => (c.core_in_section ? 1 : c.block && /专业核心/.test(c.block) ? null : 0);

const readJsonSync = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

export function ingestCurriculum(db: Database.Database, opts: { manifest?: string } = {}) {
  const now = new Date().toISOString();
  const majors = new Set((db.prepare('SELECT code FROM major').all() as { code: string }[]).map((r) => r.code));
  const raw = existsSync(rawPath(RAW_NAME)) ? readJsonSync<RawCurriculum>(rawPath(RAW_NAME)) : { docs: [] as RawCurriculum['docs'] };
  const clean = existsSync(cleanPath(RAW_NAME)) ? readJsonSync<CleanCurriculum>(cleanPath(RAW_NAME)) : { results: [] as CleanCurriculum['results'] };
  const rawById = new Map(raw.docs.map((d) => [d.source.id, d]));
  const schoolId = (name: string) => {
    const row = db.prepare('SELECT id FROM school WHERE name = ?').get(name) as { id: string } | undefined;
    if (row) return row.id;
    db.prepare('INSERT INTO school (id, name, source) VALUES (?, ?, ?)').run(`name:${name}`, name, 'curriculum_sources.csv');
    return `name:${name}`;
  };
  const upSource = db.prepare(`INSERT INTO curriculum_source (id, school_name, school_id, major_code, major_codes, grade_year, url, format, verified_by, notes, source_doc_id, status, error, sections_note, updated_at)
    VALUES (@id, @school_name, @school_id, @major_code, @major_codes, @grade_year, @url, @format, @verified_by, @notes, @source_doc_id, @status, @error, @sections_note, @updated_at)
    ON CONFLICT (id) DO UPDATE SET school_name=excluded.school_name, school_id=excluded.school_id, major_code=excluded.major_code, major_codes=excluded.major_codes, grade_year=excluded.grade_year, sections_note=COALESCE(excluded.sections_note, curriculum_source.sections_note),
      format=excluded.format, verified_by=excluded.verified_by, notes=excluded.notes, source_doc_id=COALESCE(excluded.source_doc_id, curriculum_source.source_doc_id),
      status=CASE WHEN curriculum_source.status='extracted' AND excluded.status='fetched' THEN 'extracted' ELSE excluded.status END, error=excluded.error, updated_at=excluded.updated_at`);
  const upDoc = db.prepare(`INSERT INTO source_document (id, title, publisher, edition, url, fetched_url, is_official, sha256, bytes, fetched_at, note)
    VALUES (@id, @title, @publisher, @edition, @url, @url, 1, @sha256, @bytes, @fetched_at, @note)
    ON CONFLICT (id) DO UPDATE SET title=excluded.title, sha256=excluded.sha256, bytes=excluded.bytes, fetched_at=excluded.fetched_at, note=excluded.note`);

  const manifest = readManifest(opts.manifest);
  let synced = 0;
  const srcMeta = new Map<string, { schoolId: string; docId: string | null; fetchedAt: string | null; year: number | null }>();
  for (const m of manifest) {
    const unknown = (majorCodes(m) ?? []).filter((c) => !majors.has(c));
    if (unknown.length) { console.warn(`[career] curriculum: ${m.school} ${unknown.join(',')} not in major table, skipped`); continue; }
    const sid = schoolId(m.school);
    const d = rawById.get(m.id);
    let docId: string | null = null;
    if (d?.meta) {
      docId = `curriculum:${d.meta.sha256.slice(0, 16)}`;
      upDoc.run({ id: docId, title: `${m.school} ${isMultiMajor(m) ? '' : m.major_code + ' '}本科培养方案${isMultiMajor(m) ? '汇编' : ''}${m.grade_year ? `（${m.grade_year}）` : ''}`, publisher: m.school, edition: m.grade_year || null, url: m.url, sha256: d.meta.sha256, bytes: d.meta.bytes, fetched_at: d.meta.fetched_at, note: m.verified_by ? `verified_by ${m.verified_by}` : null });
    }
    const real = clean.results.find((r) => r.source_id === m.id && !r.mock);
    const secs = d?.sections ?? [];
    const sectionsNote = secs.length ? secs.map((x) => `${x.major_code}${x.variant ? `（${x.variant}）` : ''} p${x.page_start}-${x.page_end}${x.extracted ? ' 抽取' : x.variant ? ' 班级变体，仅记录' : x.pilot ? '' : ' 非试点'}`).join('; ') : null;
    upSource.run({ id: m.id, school_name: m.school, school_id: sid, major_code: isMultiMajor(m) ? null : m.major_code, major_codes: m.major_code, sections_note: sectionsNote, grade_year: m.grade_year || null, url: m.url, format: m.format, verified_by: m.verified_by || null, notes: m.notes || null, source_doc_id: docId, status: d?.error ? 'error' : real ? 'extracted' : d?.meta ? 'fetched' : 'pending', error: d?.error ?? null, updated_at: now });
    if (secs.length) {
      db.prepare('DELETE FROM curriculum_source_major WHERE source_id = ?').run(m.id);
      const ins = db.prepare(`INSERT INTO curriculum_source_major (source_id, major_code, variant, title, page_start, page_end, printed_pages, is_pilot, extracted, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source_id, major_code, variant) DO NOTHING`);
      for (const x of secs) ins.run(m.id, x.major_code, x.variant ?? '', x.title, x.page_start, x.page_end, x.printed_pages, x.pilot ? 1 : 0, x.extracted ? 1 : 0, now);
    }
    srcMeta.set(m.id, { schoolId: sid, docId, fetchedAt: d?.meta?.fetched_at ?? null, year: /^\d{4}/.test(m.grade_year) ? Number(m.grade_year.slice(0, 4)) : null });
    synced++;
  }

  // prune sources no longer in the manifest (a removed row is deleted, not kept as history)
  const keep = new Set(manifest.map((m) => m.id));
  const stale = (db.prepare('SELECT id, url FROM curriculum_source').all() as { id: string; url: string }[]).filter((r) => !keep.has(r.id));
  for (const st of stale) {
    const mc = db.prepare("DELETE FROM major_course WHERE curriculum_source_id = ? AND review_status = 'pending'").run(st.id).changes;
    const kept = db.prepare('UPDATE major_course SET curriculum_source_id = NULL WHERE curriculum_source_id = ?').run(st.id).changes;
    db.prepare('DELETE FROM curriculum_source_major WHERE source_id = ?').run(st.id);
    db.prepare('DELETE FROM curriculum_source WHERE id = ?').run(st.id);
    console.warn(`[career] curriculum: removed source not in manifest ${st.url} (${mc} pending major_course rows deleted${kept ? `, ${kept} reviewed rows kept without source link` : ''})`);
  }

  const upCourse = db.prepare(`INSERT INTO course (id, school_id, name, credits, hours, course_type, source_url, fetched_at, extraction_method, confidence, reviewed, model, source_doc_id)
    VALUES (@id, @school_id, @name, @credits, @hours, @block, @source_url, @fetched_at, 'llm', @confidence, 0, @model, @source_doc_id)
    ON CONFLICT (id) DO UPDATE SET credits=COALESCE(excluded.credits, course.credits), course_type=COALESCE(excluded.course_type, course.course_type), hours=COALESCE(excluded.hours, course.hours), source_url=excluded.source_url, fetched_at=excluded.fetched_at,
      confidence=excluded.confidence, model=excluded.model, source_doc_id=excluded.source_doc_id
    WHERE course.extraction_method = 'llm' AND course.reviewed = 0`);
  const upMc = db.prepare(`INSERT INTO major_course (school_id, major_code, course_id, plan_year, semester, is_core, source_url, fetched_at, extraction_method, confidence, reviewed,
      course_type, core_in_section, table_block, module, credits, hours, curriculum_source_id, source_doc_id, source_page, snippet, model, review_status)
    VALUES (@school_id, @major_code, @course_id, @plan_year, @semester, @is_core, @source_url, @fetched_at, 'llm', @confidence, 0,
      @course_type, @core_in_section, @table_block, @module, @credits, @hours, @curriculum_source_id, @source_doc_id, @source_page, @snippet, @model, 'pending')
    ON CONFLICT (school_id, major_code, course_id) DO UPDATE SET plan_year=excluded.plan_year, semester=excluded.semester, source_url=excluded.source_url, fetched_at=excluded.fetched_at,
      confidence=excluded.confidence, is_core=excluded.is_core, course_type=excluded.course_type, core_in_section=excluded.core_in_section, table_block=excluded.table_block, module=excluded.module, credits=excluded.credits, hours=excluded.hours, curriculum_source_id=excluded.curriculum_source_id,
      source_doc_id=excluded.source_doc_id, source_page=excluded.source_page, snippet=excluded.snippet, model=excluded.model
    WHERE major_course.review_status = 'pending'`);
  let loaded = 0, skippedMock = 0;
  for (const r of clean.results) {
    const s = srcMeta.get(r.source_id);
    if (!s) continue;
    if (r.mock) { skippedMock += r.courses.length; continue; }
    const doc = rawById.get(r.source_id);
    if (doc?.meta && doc.meta.sha256 !== r.doc_sha256) { console.warn(`[career] curriculum: ${r.source_id} document changed since extraction; re-run clean`); continue; }
    if (!majors.has(r.major_code)) continue;
    for (const c of r.courses) {
      const courseId = `${s.schoolId}:${normCourseName(c.name)}`;
      upCourse.run({ id: courseId, school_id: s.schoolId, name: c.name, credits: c.credits, hours: c.hours, block: c.block, source_url: r.url, fetched_at: s.fetchedAt, confidence: c.confidence, model: r.model, source_doc_id: s.docId });
      upMc.run({ school_id: s.schoolId, major_code: r.major_code, course_id: courseId, plan_year: s.year, semester: c.semester, source_url: r.url, fetched_at: s.fetchedAt, confidence: c.confidence,
        course_type: c.course_type, core_in_section: c.core_in_section ? 1 : 0, table_block: c.block, module: c.module, is_core: isCoreValue(c), credits: c.credits, hours: c.hours, curriculum_source_id: r.source_id, source_doc_id: s.docId, source_page: c.page, snippet: c.snippet, model: r.model });
      loaded++;
    }
    // a pending row of this source/major that the latest extraction no longer produces is stale -> delete
    const ids = r.courses.map((c) => `${s.schoolId}:${normCourseName(c.name)}`);
    const stale = db.prepare(`DELETE FROM major_course WHERE curriculum_source_id = ? AND major_code = ? AND review_status = 'pending' AND course_id NOT IN (SELECT value FROM json_each(?))`)
      .run(r.source_id, r.major_code, JSON.stringify(ids)).changes;
    if (stale) console.log(`[career] curriculum: ${r.school} ${r.major_code}: removed ${stale} stale pending rows`);
  }
  // stage 2 (course -> skill tagging) runs after ingest: CAREER/post_ingest.ts -> curriculum/tag.ts
  console.log(`[career] curriculum: manifest ${synced} sources, upserted ${loaded} major_course rows${skippedMock ? `, skipped ${skippedMock} MOCK courses (not ingested)` : ''}, skill tagging runs next (post_ingest)`);
}
