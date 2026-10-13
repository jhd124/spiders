/**
 * Stage 2 runner: tag every LLM-extracted course (major_course) with level-2 skills.
 *   npm run career:tag-skills          # real LLM when LLM_* env is set; otherwise mock (nothing written)
 * Runs after ingest in `career:all` (CAREER/post_ingest.ts). Per (school, major) one cached LLM call.
 * Writes course_skill (extraction_method='llm', source='llm:<model>', reviewed=0) and course_skill_untagged.
 * Never touches reviewed course_skill rows; re-running with unchanged inputs costs no tokens (cache).
 */
import Database from 'better-sqlite3';
import { isMain } from '../../lib/main.js';
import { providerFromEnv } from '../../lib/llm.js';
import { migrate } from '../migrate.js';
import { CAREER_DB } from '../db.js';
import { SqliteLlmCache } from './cache.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlmSkillTagger, mockTagProvider, normQuote, TAG_PROMPT_VERSION, type CourseForTagging, type SkillRef, type SkillTagger, type TagEvidence, type TagResult } from './skills.js';
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

export interface TagRunSummary { tagger: string; mock: boolean; groups: number; courses: number; tags: number; untagged: { course_id: string; name: string; is_core: boolean; reason: string }[]; prompt_tokens: number; completion_tokens: number; llm_calls: number; cached: number; errors: string[]; needs_review: number }

export async function tagSkills(dbPath = CAREER_DB, tagger?: SkillTagger): Promise<TagRunSummary> {
  migrate(dbPath, () => {});
  const db = new Database(dbPath);
  try {
    const skills = db.prepare(`SELECT s.id, s.name, s.primary_domain_id AS domain_id, d.name AS domain_name, s.skill_type
      FROM skill s JOIN skill_domain d ON d.id = s.primary_domain_id ORDER BY d.sort_order, s.id`).all() as SkillRef[];
    const t = tagger ?? new LlmSkillTagger(providerFromEnv(mockTagProvider(skills)), new SqliteLlmCache(db));
    const mock = t.name === 'mock';
    const rows = db.prepare(`SELECT mc.school_id, mc.major_code, c.id AS course_id, c.name, mc.course_type, mc.is_core, mc.table_block, COALESCE(mc.credits, c.credits) AS credits, mc.snippet, mc.curriculum_source_id,
        COALESCE(s.name, mc.school_id) AS school, COALESCE(m.name, mc.major_code) AS major
      FROM major_course mc JOIN course c ON c.id = mc.course_id LEFT JOIN school s ON s.id = mc.school_id LEFT JOIN major m ON m.code = mc.major_code
      WHERE mc.review_status <> 'rejected' ORDER BY mc.school_id, mc.major_code, mc.source_page, c.name`).all() as (CourseForTagging & { school_id: string; major_code: string; school: string; major: string; curriculum_source_id: string | null })[];
    const texts = new Map<string, string[] | null>();
    const groups = new Map<string, typeof rows>();
    for (const r of rows) groups.set(`${r.school_id}|${r.major_code}`, [...(groups.get(`${r.school_id}|${r.major_code}`) ?? []), r]);
    const sum: TagRunSummary = { tagger: t.name, mock, groups: groups.size, courses: 0, tags: 0, untagged: [], prompt_tokens: 0, completion_tokens: 0, llm_calls: 0, cached: 0, errors: [], needs_review: 0 };
    const now = new Date().toISOString();
    const runId = `tag:${now}`;
    if (!mock) db.prepare('INSERT INTO skill_tag_run (id, tagger, skill_version, started_at) VALUES (?, ?, ?, ?)').run(runId, t.name, `${TAG_PROMPT_VERSION}/${skills.length}`, now);
    const results: { courses: typeof rows; r: TagResult }[] = [];
    for (const g of groups.values()) {
      // a course shared by several majors of one school is tagged per major; first result wins when writing
      for (let i = 0; i < g.length; i += BATCH) {
      const part = g.slice(i, i + BATCH);
      const sid = part[0]!.curriculum_source_id;
      if (sid && !texts.has(sid)) texts.set(sid, await sourceLines(sid));
      const lines = sid ? texts.get(sid) : null;
      const ev = lines ? evidenceFor(lines, part) : { excerpt: part.map((c) => c.snippet).filter(Boolean).join('\n'), full: part.map((c) => c.snippet ?? '').join('\n') };
      const r = await t.tag(part, skills, { school: g[0]!.school, major: `${g[0]!.major}（${g[0]!.major_code}）` }, ev);
      results.push({ courses: part, r });
      sum.prompt_tokens += r.stats.prompt_tokens; sum.completion_tokens += r.stats.completion_tokens;
      sum.llm_calls += r.stats.llm_calls; sum.cached += r.stats.cached; sum.errors.push(...r.errors);
      }
    }
    const names = new Map(rows.map((r) => [r.course_id, r.name]));
    const done = new Set<string>();
    const write = db.transaction(() => {
      const delTags = db.prepare("DELETE FROM course_skill WHERE course_id = ? AND reviewed = 0 AND extraction_method = 'llm'");
      const ins = db.prepare(`INSERT INTO course_skill (course_id, skill_id, weight, extraction_method, confidence, reviewed, rationale, source, model, tagged_at, evidence_quote, needs_review, review_reason)
        VALUES (?, ?, ?, 'llm', NULL, 0, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (course_id, skill_id) DO NOTHING`);
      const delUn = db.prepare('DELETE FROM course_skill_untagged WHERE course_id = ?');
      const insUn = db.prepare('INSERT INTO course_skill_untagged (course_id, is_core, reason, model, tagged_at) VALUES (?, ?, ?, ?, ?)');
      for (const { courses, r } of results) {
        for (const c of courses) {
          if (done.has(c.course_id)) continue;
          done.add(c.course_id);
          sum.courses++;
          const tags = r.tags.filter((x) => x.course_id === c.course_id);
          const un = r.untagged.find((x) => x.course_id === c.course_id);
          if (un) sum.untagged.push({ course_id: c.course_id, name: names.get(c.course_id) ?? c.course_id, is_core: un.is_core, reason: un.reason });
          sum.tags += tags.length;
          if (mock) continue; // mock output is never written
          delTags.run(c.course_id);
          delUn.run(c.course_id);
          tags.forEach((x, i) => { ins.run(c.course_id, x.skill_id, Number((1 - i * 0.25).toFixed(2)), x.rationale, t.name, r.model, now, x.evidence_quote, x.needs_review ? 1 : 0, x.review_reason); if (x.needs_review) sum.needs_review++; });
          if (un) insUn.run(c.course_id, un.is_core ? 1 : 0, un.reason, r.model, now);
        }
      }
      if (!mock) db.prepare('UPDATE skill_tag_run SET finished_at = ?, tagged = ? WHERE id = ?').run(new Date().toISOString(), sum.courses - sum.untagged.length, runId);
    });
    write();
    return sum;
  } finally {
    db.close();
  }
}

export async function main() {
  const s = await tagSkills();
  const coreUn = s.untagged.filter((u) => u.is_core);
  console.log(`[career] skill tagger: ${s.tagger}${s.mock ? ' (MOCK — nothing written)' : ''}; ${s.groups} school×major groups, ${s.courses} courses, ${s.tags} course_skill rows (${s.needs_review} needs_review), ${s.untagged.length} untagged${coreUn.length ? ` (${coreUn.length} 核心课!)` : ''}; ${s.llm_calls} calls, ${s.cached} cached, tokens ${s.prompt_tokens}+${s.completion_tokens}`);
  for (const u of s.untagged) console.log(`[career]   untagged${u.is_core ? ' [核心课]' : ''}: ${u.name} — ${u.reason}`);
  for (const e of s.errors) console.warn(`[career]   ${e}`);
}

if (isMain(import.meta.url)) await main();
