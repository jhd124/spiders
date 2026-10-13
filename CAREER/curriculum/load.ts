/**
 * Ingest stage for 培养方案 courses (called from CAREER/ingest.ts inside its transaction).
 *  - syncs seeds/curriculum_sources.csv -> curriculum_source (+ school rows for unknown schools)
 *  - records each fetched document in source_document (sha256, bytes)
 *  - upserts course / major_course with provenance (extraction_method='llm', model, confidence, page, snippet, reviewed=0)
 *  - SKIPS mock results (no LLM configured) — mock output is never stored as data
 *  - never overwrites a major_course row the expert already approved/rejected/edited
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../lib/csv.js';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { cleanPath, rawPath } from '../../lib/io.js';
import { isMultiMajor, majorCodes, readManifest } from './manifest.js';
import { RAW_NAME, type RawCurriculum } from './crawler.js';
import type { CleanCurriculum } from './clean.js';
import { impliedType, normCourseName, typeFromBlock } from './extract.js';

/** Expert rule (009): core ONLY when listed in the 正文 核心课程 section. A course that is only in the table's 专业核心课程
 *  block is 专业必修 (is_core 0); table_block stays as the source fact. Applies to every school. */
export const isCoreValue = (c: { core_in_section: boolean; block?: string | null }) => (c.core_in_section ? 1 : 0);
/** Display label: 核心课 (section) / 专业必修 (only the table's 专业核心 block) / course_type */
export const coreLabel = (c: { is_core: number | null; table_block: string | null; course_type: string | null }) =>
  c.is_core === 1 ? '核心课' : c.table_block && /专业核心/.test(c.table_block) ? '专业必修' : c.course_type;

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
    ON CONFLICT (school_id, major_code, course_id) DO UPDATE SET plan_year=excluded.plan_year, semester=COALESCE(excluded.semester, major_course.semester), source_url=excluded.source_url, fetched_at=excluded.fetched_at,
      confidence=excluded.confidence, is_core=excluded.is_core, course_type=COALESCE(excluded.course_type, major_course.course_type), core_in_section=excluded.core_in_section,
      table_block=COALESCE(excluded.table_block, major_course.table_block), module=COALESCE(excluded.module, major_course.module), credits=COALESCE(excluded.credits, major_course.credits), hours=COALESCE(excluded.hours, major_course.hours), curriculum_source_id=excluded.curriculum_source_id,
      source_doc_id=excluded.source_doc_id, source_page=excluded.source_page, snippet=excluded.snippet, model=excluded.model
    WHERE major_course.review_status = 'pending'`);
  // Source facts (where the PDF lists the course) are not reviewer judgments: refresh them on reviewed rows too, otherwise a row
  // approved before a schema change keeps the new columns' defaults forever (server bug 2026-10-13: 19 rows approved before 008
  // kept core_in_section 0 / course_type NULL, then 009 derived is_core 0 from that). A reviewer-set course_type is kept.
  // Never overwrite a known fact with null (server 2026-10-13: a re-extraction without credits nulled 7 SDU 080901 credits).
  const upFacts = db.prepare(`UPDATE major_course SET core_in_section = @core_in_section, table_block = COALESCE(@table_block, table_block), module = COALESCE(@module, module), is_core = @is_core,
      course_type = COALESCE(course_type, @course_type), credits = COALESCE(credits, @credits), hours = COALESCE(hours, @hours)
    WHERE school_id = @school_id AND major_code = @major_code AND course_id = @course_id AND review_status <> 'pending'
      AND (core_in_section IS NOT @core_in_section OR (@table_block IS NOT NULL AND table_block IS NOT @table_block) OR (@module IS NOT NULL AND module IS NOT @module) OR is_core IS NOT @is_core
        OR (course_type IS NULL AND @course_type IS NOT NULL) OR (credits IS NULL AND @credits IS NOT NULL) OR (hours IS NULL AND @hours IS NOT NULL))`);
  let repaired = 0;
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
        course_type: typeFromBlock(c.block, c.course_type), core_in_section: c.core_in_section ? 1 : 0, table_block: c.block, module: c.module, is_core: isCoreValue(c), credits: c.credits, hours: c.hours, curriculum_source_id: r.source_id, source_doc_id: s.docId, source_page: c.page, snippet: c.snippet, model: r.model });
      repaired += upFacts.run({ school_id: s.schoolId, major_code: r.major_code, course_id: courseId, core_in_section: c.core_in_section ? 1 : 0, table_block: c.block, module: c.module, is_core: isCoreValue(c), course_type: typeFromBlock(c.block, c.course_type), credits: c.credits, hours: c.hours }).changes;
      loaded++;
    }
    // a pending row of this source/major that the latest extraction no longer produces is stale -> delete
    const ids = r.courses.map((c) => `${s.schoolId}:${normCourseName(c.name)}`);
    const stale = db.prepare(`DELETE FROM major_course WHERE curriculum_source_id = ? AND major_code = ? AND review_status = 'pending' AND course_id NOT IN (SELECT value FROM json_each(?))`)
      .run(r.source_id, r.major_code, JSON.stringify(ids)).changes;
    if (stale) console.log(`[career] curriculum: ${r.school} ${r.major_code}: removed ${stale} stale pending rows`);
  }
  const typed = backfillImpliedTypes(db);
  if (typed) console.log(`[career] curriculum: ${typed} null course_type filled from the table block (impliedType)`);
  const bt = applyBlockTypeConfig(db);
  if (bt.updated || bt.unmatched.length) console.log(`[career] curriculum: block type config: ${bt.updated} rows set${bt.unmatched.length ? `; ERROR no rows for ${bt.unmatched.join(', ')}` : ''}`);
  // stage 2 (course -> skill tagging) runs after ingest: CAREER/post_ingest.ts -> curriculum/tag.ts
  console.log(`[career] curriculum: manifest ${synced} sources, upserted ${loaded} major_course rows${repaired ? `, refreshed source facts (core/block/type) on ${repaired} reviewed rows` : ''}${skippedMock ? `, skipped ${skippedMock} MOCK courses (not ingested)` : ''}, skill tagging runs next (post_ingest)`);
}

/** Deterministic course_type default on stored rows (no re-extraction needed, works on results extracted before the rule existed,
 *  e.g. SDU 080902's 大学英语课题组 rows): course_type NULL + a table_block -> typeFromBlock/impliedType. Reviewer edits are kept
 *  (only NULL is filled). Returns the number of rows filled. */
export function backfillImpliedTypes(db: Database.Database): number {
  const rows = db.prepare('SELECT rowid AS rid, table_block FROM major_course WHERE course_type IS NULL AND table_block IS NOT NULL').all() as { rid: number; table_block: string }[];
  const upd = db.prepare('UPDATE major_course SET course_type = ? WHERE rowid = ? AND course_type IS NULL');
  let n = 0;
  for (const r of rows) {
    const t = typeFromBlock(r.table_block, null) ?? impliedType(r.table_block);
    if (t) n += upd.run(t, r.rid).changes;
  }
  return n;
}

export const BLOCK_TYPES_CSV = join(dirname(fileURLToPath(import.meta.url)), '..', 'seeds', 'curriculum_block_types.csv');

/**
 * Expert per-source course_type of a whole table block (seeds/curriculum_block_types.csv: school, major_code, table_block,
 * course_type, verified_by, note). Used where the block name alone is ambiguous: e.g. HIT-WH 专业方向选修课表一 (choose 4 credits from
 * 6 courses) = 限选, 表二 = 任选 although its text also says 选择4学分 — so there is deliberately NO generic "选N学分" detector.
 * major_code '*' = every major of that school. Rows edited by a reviewer (review_status 'edited') are never changed. Unconfigured
 * blocks keep the parser's type. A config row matching no stored row is reported (typo / renamed block). Idempotent.
 */
export function applyBlockTypeConfig(db: Database.Database, path = BLOCK_TYPES_CSV): { updated: number; matched: number; unmatched: string[] } {
  if (!existsSync(path)) return { updated: 0, matched: 0, unmatched: [] };
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const unmatched: string[] = [];
  let updated = 0, matched = 0;
  for (const r of rows) {
    const t = r.course_type?.trim();
    if (!r.school?.trim() || !r.table_block?.trim() || !['必修', '限选', '任选'].includes(t ?? '')) { unmatched.push(`${r.school}/${r.major_code}/${r.table_block}: bad row`); continue; }
    const where = `FROM major_course WHERE school_id IN (SELECT id FROM school WHERE name = @school) AND (@major = '*' OR major_code = @major)
      AND replace(table_block, ' ', '') = replace(@block, ' ', '')`;
    const p = { school: r.school.trim(), major: (r.major_code || '*').trim(), block: r.table_block.trim(), t };
    const n = (db.prepare(`SELECT count(*) n ${where}`).get(p) as { n: number }).n;
    if (!n) { unmatched.push(`${p.school}/${p.major}/${p.block}`); continue; }
    matched += n;
    updated += db.prepare(`UPDATE major_course SET course_type = @t WHERE rowid IN (SELECT rowid ${where} AND review_status <> 'edited' AND course_type IS NOT @t)`).run(p).changes;
  }
  return { updated, matched, unmatched };
}
