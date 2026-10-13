/**
 * Stage 2 runner: tag every LLM-extracted course (major_course) with level-2 skills.
 *   npm run career:tag-skills          # real LLM when LLM_* env is set; otherwise mock (nothing written)
 * Runs after ingest in `career:all` (CAREER/post_ingest.ts). Per (school, major) one cached LLM call.
 * Writes course_skill (extraction_method='llm', source='llm:<model>', reviewed=0) and course_skill_untagged.
 * Never touches reviewed course_skill rows; per-course result cache: re-running with unchanged inputs makes no LLM call and writes nothing.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isMain } from '../../lib/main.js';
import { providerFromEnv } from '../../lib/llm.js';
import { migrate } from '../migrate.js';
import { CAREER_DB } from '../db.js';
import { SqliteLlmCache } from './cache.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlmSkillTagger, applyCourseListRule, mockTagProvider, normQuote, TAG_RULES_VERSION, type CourseForTagging, type SkillRef, type SkillTag, type SkillTagger, type TagEvidence, tagWeight, storedEvidenceType, CORE_NAME_VERSION, type StoredEvidenceType } from './skills.js';
import { CURRICULUM_RAW } from './fetch.js';
import type { DocFormat } from './manifest.js';
import { extractText } from './text.js';

const EXCERPT_MAX = Number(process.env.TAG_EXCERPT_MAX ?? 9000);

/** Full extracted text of a stored 培养方案 (data/raw/career/curriculum/<source id>.<ext>), or null when not on disk. */
async function sourceLines(sourceId: string | null): Promise<string[] | null> {
  if (!sourceId || !existsSync(CURRICULUM_RAW)) return null;
  const f = readdirSync(CURRICULUM_RAW).find((x) => x.startsWith(`${sourceId}.`));
  if (!f) return null;
  const pages = await extractText(new Uint8Array(readFileSync(join(CURRICULUM_RAW, f))), f.split('.').pop() as DocFormat);
  return pages.flatMap((p) => p.text.split('\n'));
}

/** Lines that mention any of the courses (plus one line either side, for names/sentences wrapped across lines). */
export function evidenceFor(lines: string[], courses: { name: string; snippet: string | null }[]): TagEvidence {
  const names = courses.map((c) => normQuote(c.name)).filter((n) => n.length >= 2);
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    const n = normQuote(l);
    // a name may be split across two lines (e.g. 计 / 算机网络): test the line joined with the next one too
    const joined = n + normQuote(lines[i + 1] ?? '');
    if (names.some((x) => n.includes(x) || (joined.includes(x) && !normQuote(lines[i + 1] ?? '').includes(x)))) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
  });
  let excerpt = '';
  for (const i of [...keep].sort((a, b) => a - b)) { const l = lines[i]!.trim(); if (l && excerpt.length + l.length < EXCERPT_MAX) excerpt += l + '\n'; }
  return { excerpt: excerpt.trim(), full: lines.join('\n') };
}

const BATCH = Number(process.env.TAG_BATCH ?? 30);

const sha = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex');
/** hash of the skill table as the tagger sees it: any added/renamed/retyped skill re-tags every course */
export const skillTableHash = (skills: SkillRef[]) =>
  sha(...[...skills].sort((x, y) => x.id.localeCompare(y.id)).map((s) => `${s.id}|${s.name}|${s.domain_id}|${s.skill_type ?? ''}`));
/** per-course tagging key: model + course name + the course's own source lines + prompt/rules version + skill table */
export const courseTagKey = (model: string, name: string, ownEvidence: string, skillsHash: string, rulesVersion = TAG_RULES_VERSION) => sha(model, name, ownEvidence, rulesVersion, skillsHash);

/**
 * Post-step (no LLM): recompute the derived evidence_type (核心课名 vs 课名推断) and weight of every stored course_skill row.
 * Only these two columns change; skill, quote, review state, tagged_at are never touched. Applies to reviewed rows too.
 * weight = EVIDENCE_WEIGHT[type] exactly. Idempotent: a second call updates 0 rows.
 */
export function classifyCoreNames(db: Database.Database): { checked: number; updated: number; core_name: number } {
  const rows = db.prepare(`SELECT cs.rowid AS rid, cs.weight, cs.evidence_type, c.name AS course, s.name AS skill,
      EXISTS (SELECT 1 FROM major_course mc WHERE mc.course_id = cs.course_id AND mc.is_core = 1) AS core
    FROM course_skill cs JOIN course c ON c.id = cs.course_id JOIN skill s ON s.id = cs.skill_id WHERE cs.evidence_type IS NOT NULL`).all() as
    { rid: number; weight: number | null; evidence_type: StoredEvidenceType; course: string; skill: string; core: number }[];
  const upd = db.prepare('UPDATE course_skill SET evidence_type = ?, weight = ? WHERE rowid = ?');
  let updated = 0, coreName = 0;
  for (const r of rows) {
    const t = storedEvidenceType(r.evidence_type, r.core === 1, r.course, r.skill);
    if (t === '核心课名') coreName++;
    const w = tagWeight(t);
    if (t !== r.evidence_type || w !== r.weight) { upd.run(t, w, r.rid); updated++; }
  }
  return { checked: rows.length, updated, core_name: coreName };
}
export { CORE_NAME_VERSION };

interface CourseResult { tags: SkillTag[]; untagged: { is_core: boolean; reason: string } | null }

export interface TagRunSummary { tagger: string; mock: boolean; groups: number; courses: number; retagged: number; reused: number; tags: number; untagged: { course_id: string; name: string; is_core: boolean; reason: string }[]; prompt_tokens: number; completion_tokens: number; llm_calls: number; cached: number; errors: string[]; needs_review: number; rows_inserted: number; rows_updated: number; rows_deleted: number; core_name: { checked: number; updated: number; core_name: number } }

/**
 * Stability contract (expert, 2026-10-13):
 *  - each course's validated result is cached in course_skill_tag_cache under courseTagKey; only courses whose key changed go to the model
 *  - course_skill rows are diffed, not rewritten: an unchanged row is never touched (same rowid, tagged_at, every column)
 *  - rows with reviewed = 1 are never updated or deleted, and a reviewed (course, skill) is never re-inserted
 */
export async function tagSkills(dbPath = CAREER_DB, tagger?: SkillTagger, opts: { rulesVersion?: string } = {}): Promise<TagRunSummary> {
  migrate(dbPath, () => {});
  const db = new Database(dbPath);
  try {
    const skills = db.prepare(`SELECT s.id, s.name, s.primary_domain_id AS domain_id, d.name AS domain_name, s.skill_type
      FROM skill s JOIN skill_domain d ON d.id = s.primary_domain_id ORDER BY d.sort_order, s.id`).all() as SkillRef[];
    const t = tagger ?? new LlmSkillTagger(providerFromEnv(mockTagProvider(skills)), new SqliteLlmCache(db));
    const mock = t.name === 'mock';
    const sHash = skillTableHash(skills);
    const rows = db.prepare(`SELECT mc.school_id, mc.major_code, c.id AS course_id, c.name, mc.course_type, mc.is_core, mc.table_block, COALESCE(mc.credits, c.credits) AS credits, mc.snippet, mc.curriculum_source_id,
        COALESCE(s.name, mc.school_id) AS school, COALESCE(m.name, mc.major_code) AS major
      FROM major_course mc JOIN course c ON c.id = mc.course_id LEFT JOIN school s ON s.id = mc.school_id LEFT JOIN major m ON m.code = mc.major_code
      WHERE mc.review_status <> 'rejected' ORDER BY mc.school_id, mc.major_code, mc.source_page, c.name`).all() as (CourseForTagging & { school_id: string; major_code: string; school: string; major: string; curriculum_source_id: string | null })[];
    const texts = new Map<string, string[] | null>();
    const groups = new Map<string, typeof rows>();
    const seen = new Set<string>();
    // a course shared by several majors of one school is tagged once (first occurrence)
    for (const r of rows) { if (seen.has(r.course_id)) continue; seen.add(r.course_id); groups.set(`${r.school_id}|${r.major_code}`, [...(groups.get(`${r.school_id}|${r.major_code}`) ?? []), r]); }
    const sum: TagRunSummary = { tagger: t.name, mock, groups: groups.size, courses: 0, retagged: 0, reused: 0, tags: 0, untagged: [], prompt_tokens: 0, completion_tokens: 0, llm_calls: 0, cached: 0, errors: [], needs_review: 0, rows_inserted: 0, rows_updated: 0, rows_deleted: 0, core_name: { checked: 0, updated: 0, core_name: 0 } };
    const now = new Date().toISOString();
    const getCache = db.prepare('SELECT tag_key, result_json FROM course_skill_tag_cache WHERE course_id = ?');
    const results = new Map<string, { c: (typeof rows)[number]; key: string; res: CourseResult; fresh: boolean; model: string }>();
    for (const g of groups.values()) {
      const sid = g[0]!.curriculum_source_id;
      if (sid && !texts.has(sid)) texts.set(sid, await sourceLines(sid));
      const lines = sid ? texts.get(sid) : null;
      const todo: typeof rows = [];
      for (const c of g) {
        const own = lines ? evidenceFor(lines, [c]).excerpt : (c.snippet ?? '');
        const key = courseTagKey(t.name, c.name, own, sHash, opts.rulesVersion);
        const hit = mock ? undefined : (getCache.get(c.course_id) as { tag_key: string; result_json: string } | undefined);
        if (hit && hit.tag_key === key) { results.set(c.course_id, { c, key, res: JSON.parse(hit.result_json) as CourseResult, fresh: false, model: '' }); sum.reused++; }
        else { todo.push(c); results.set(c.course_id, { c, key, res: { tags: [], untagged: null }, fresh: true, model: '' }); }
      }
      for (let i = 0; i < todo.length; i += BATCH) {
        const part = todo.slice(i, i + BATCH);
        const ev = lines ? evidenceFor(lines, part) : { excerpt: part.map((c) => c.snippet).filter(Boolean).join('\n'), full: part.map((c) => c.snippet ?? '').join('\n') };
        const r = await t.tag(part, skills, { school: g[0]!.school, major: `${g[0]!.major}（${g[0]!.major_code}）` }, { ...ev, courseNames: g.map((c) => c.name) });
        sum.prompt_tokens += r.stats.prompt_tokens; sum.completion_tokens += r.stats.completion_tokens;
        sum.llm_calls += r.stats.llm_calls; sum.cached += r.stats.cached; sum.errors.push(...r.errors);
        for (const c of part) {
          const un = r.untagged.find((x) => x.course_id === c.course_id);
          Object.assign(results.get(c.course_id)!, { res: { tags: r.tags.filter((x) => x.course_id === c.course_id), untagged: un ? { is_core: un.is_core, reason: un.reason } : null }, model: r.model });
        }
        sum.retagged += part.length;
      }
    }
    const runId = `tag:${now}`;
    const skillName = new Map(skills.map((x) => [x.id, x.name]));
    const coreCourse = new Set((db.prepare('SELECT DISTINCT course_id FROM major_course WHERE is_core = 1').all() as { course_id: string }[]).map((r) => r.course_id));
    // expert-rejected (course, skill) pairs (014): never (re)inserted, even from the cache
    const rejected = new Set((db.prepare("SELECT course_id || '|' || skill_id AS k FROM course_skill_rejected").all() as { k: string }[]).map((r) => r.k));
    const groupNames = new Map<string, string[]>();
    for (const g of groups.values()) for (const c of g) groupNames.set(c.course_id, g.map((x) => x.name));
    const write = db.transaction(() => {
      if (mock) return; // mock output is never written
      const existing = db.prepare('SELECT rowid AS rid, * FROM course_skill WHERE course_id = ?');
      const ins = db.prepare(`INSERT INTO course_skill (course_id, skill_id, weight, extraction_method, confidence, reviewed, rationale, source, model, tagged_at, evidence_quote, needs_review, review_reason, evidence_type, tag_rank)
        VALUES (?, ?, ?, 'llm', NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (course_id, skill_id) DO NOTHING`);
      const upd = db.prepare(`UPDATE course_skill SET weight = ?, rationale = ?, source = ?, model = ?, tagged_at = ?, evidence_quote = ?, needs_review = ?, review_reason = ?, evidence_type = ?, tag_rank = ?
        WHERE rowid = ? AND reviewed = 0 AND extraction_method = 'llm'`);
      const del = db.prepare("DELETE FROM course_skill WHERE rowid = ? AND reviewed = 0 AND extraction_method = 'llm'");
      const getUn = db.prepare('SELECT is_core, reason, model FROM course_skill_untagged WHERE course_id = ?');
      const upUn = db.prepare(`INSERT INTO course_skill_untagged (course_id, is_core, reason, model, tagged_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (course_id) DO UPDATE SET is_core = excluded.is_core, reason = excluded.reason, model = excluded.model, tagged_at = excluded.tagged_at`);
      const delUn = db.prepare('DELETE FROM course_skill_untagged WHERE course_id = ?');
      const setCache = db.prepare(`INSERT INTO course_skill_tag_cache (course_id, tag_key, result_json, model, tagged_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (course_id) DO UPDATE SET tag_key = excluded.tag_key, result_json = excluded.result_json, model = excluded.model, tagged_at = excluded.tagged_at`);
      for (const { c, key, res, fresh, model } of results.values()) {
        // a response with no entry for the course (bad JSON, truncated output) is not cached: the course is retried next run
        if (fresh && !(res.untagged?.reason === 'model returned no entry for this course')) setCache.run(c.course_id, key, JSON.stringify(res), model, now);
        const cur = existing.all(c.course_id) as (Record<string, unknown> & { rid: number; skill_id: string; reviewed: number; extraction_method: string })[];
        const locked = new Set(cur.filter((x) => x.reviewed === 1 || x.extraction_method !== 'llm').map((x) => x.skill_id));
        const mine = new Map(cur.filter((x) => x.reviewed === 0 && x.extraction_method === 'llm').map((x) => [x.skill_id, x]));
        const tagModel = (fresh ? model : (cur.find((x) => x.extraction_method === 'llm')?.model as string | undefined)) ?? model;
        const want = new Set<string>();
        const listNames = groupNames.get(c.course_id) ?? [];
        res.tags.map((x) => applyCourseListRule(x, c.name, listNames, x.skill_id)).forEach((x, i) => {
          if (locked.has(x.skill_id) || rejected.has(`${c.course_id}|${x.skill_id}`)) return;
          want.add(x.skill_id);
          const st = storedEvidenceType(x.evidence_type, coreCourse.has(c.course_id), c.name, skillName.get(x.skill_id) ?? '');
          const vals = [tagWeight(st), x.rationale, t.name, tagModel, x.evidence_quote, x.needs_review ? 1 : 0, x.review_reason, st, i + 1] as const;
          const old = mine.get(x.skill_id);
          if (!old) { ins.run(c.course_id, x.skill_id, vals[0], vals[1], vals[2], vals[3], now, vals[4], vals[5], vals[6], vals[7], vals[8]); sum.rows_inserted++; return; }
          const same = old.weight === vals[0] && old.rationale === vals[1] && old.source === vals[2] && old.evidence_quote === vals[4] && old.needs_review === vals[5] && old.review_reason === vals[6] && old.evidence_type === vals[7] && old.tag_rank === vals[8];
          if (!same) { upd.run(vals[0], vals[1], vals[2], vals[3], now, vals[4], vals[5], vals[6], vals[7], vals[8], old.rid); sum.rows_updated++; }
        });
        for (const [sk, old] of mine) if (!want.has(sk)) { del.run(old.rid); sum.rows_deleted++; }
        if (res.untagged) {
          const o = getUn.get(c.course_id) as { is_core: number; reason: string } | undefined;
          if (!o || o.is_core !== (res.untagged.is_core ? 1 : 0) || o.reason !== res.untagged.reason) upUn.run(c.course_id, res.untagged.is_core ? 1 : 0, res.untagged.reason, tagModel, now);
        } else delUn.run(c.course_id);
      }
      if (sum.llm_calls > 0) db.prepare('INSERT INTO skill_tag_run (id, tagger, skill_version, started_at, finished_at, tagged) VALUES (?, ?, ?, ?, ?, ?)')
        .run(runId, t.name, `${TAG_RULES_VERSION}/${sHash.slice(0, 12)}`, now, new Date().toISOString(), sum.retagged);
    });
    write();
    sum.core_name = db.transaction(() => classifyCoreNames(db))();
    for (const { c, res } of results.values()) {
      sum.courses++;
      sum.tags += res.tags.length;
      sum.needs_review += res.tags.filter((x) => x.needs_review).length;
      if (res.untagged) sum.untagged.push({ course_id: c.course_id, name: c.name, is_core: res.untagged.is_core, reason: res.untagged.reason });
    }
    return sum;
  } finally {
    db.close();
  }
}

export async function main() {
  const s = await tagSkills();
  const coreUn = s.untagged.filter((u) => u.is_core);
  console.log(`[career] skill tagger: ${s.tagger}${s.mock ? ' (MOCK — nothing written)' : ''}; ${s.groups} school×major groups, ${s.courses} courses (${s.retagged} sent to model, ${s.reused} unchanged/reused), ${s.tags} course_skill rows (${s.needs_review} needs_review), ${s.untagged.length} untagged${coreUn.length ? ` (${coreUn.length} 核心课!)` : ''}; ${s.llm_calls} calls, ${s.cached} cached, tokens ${s.prompt_tokens}+${s.completion_tokens}; course_skill +${s.rows_inserted} ~${s.rows_updated} -${s.rows_deleted}; 核心课名 post-step v${CORE_NAME_VERSION}: ${s.core_name.core_name} 核心课名, ${s.core_name.updated} rows re-typed`);
  for (const u of s.untagged) console.log(`[career]   untagged${u.is_core ? ' [核心课]' : ''}: ${u.name} — ${u.reason}`);
  for (const e of s.errors) console.warn(`[career]   ${e}`);
}

if (isMain(import.meta.url)) await main();
