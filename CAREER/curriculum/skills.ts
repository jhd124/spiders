/**
 * Stage 2: course -> level-2 skill tagging (LLM).
 *  - the model may only pick skill ids from the given list; each course gets 1..3 skills
 *  - 核心课 must get >= 1 skill; a course that fits nothing is reported as untagged — never force-tagged
 *  - responses are cached like extraction (sha256(model + prompt version + prompt)); mock output is never written
 */
import type { ChatMessage, ChatProvider } from '../../lib/llm.js';
import { MockProvider } from '../../lib/llm.js';
import { cacheKey, type LlmCache } from './cache.js';

export const TAG_PROMPT_VERSION = 'course-skill-v2';
export const MAX_SKILLS_PER_COURSE = 3;

export interface SkillRef { id: string; name: string; domain_id: string; domain_name: string }
export interface CourseForTagging { course_id: string; name: string; course_type: string | null; credits: number | null; snippet: string | null; is_core?: number | null; table_block?: string | null }
export interface SkillTag { course_id: string; skill_id: string; rationale: string }
export interface Untagged { course_id: string; is_core: boolean; reason: string }
export interface TagResult {
  model: string;
  mock: boolean;
  tags: SkillTag[];
  untagged: Untagged[];
  errors: string[];
  stats: { llm_calls: number; cached: number; prompt_tokens: number; completion_tokens: number; dropped_unknown_skill: number; dropped_over_limit: number };
}

export interface SkillTagger {
  readonly name: string;
  tag(courses: CourseForTagging[], skills: SkillRef[], ctx: { school: string; major: string }): Promise<TagResult>;
}

/** core = listed in the 核心课程 paragraph, or in the table's 专业核心 block (either fact) */
export const isCore = (c: CourseForTagging) => c.is_core === 1 || /专业核心/.test(c.table_block ?? '');

export function buildTagMessages(courses: CourseForTagging[], skills: SkillRef[], ctx: { school: string; major: string }): ChatMessage[] {
  const byDomain = new Map<string, SkillRef[]>();
  for (const s of skills) byDomain.set(`${s.domain_name}(${s.domain_id})`, [...(byDomain.get(`${s.domain_name}(${s.domain_id})`) ?? []), s]);
  const skillText = [...byDomain].map(([d, ss]) => `${d}: ${ss.map((s) => `${s.id}=${s.name}`).join('；')}`).join('\n');
  const courseText = courses.map((c, i) => `${i + 1}. ${c.name}｜${[isCore(c) ? '核心课' : null, c.table_block, c.course_type].filter(Boolean).join('/') || '课程'}${c.credits != null ? `｜${c.credits}学分` : ''}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        '你是高校课程与职业技能对应的标注助手。给每门课程从【技能清单】里挑选它直接教授的技能。',
        '规则：1) skill_id 只能取自技能清单中的 id，不得自造；',
        `2) 每门课挂 1~${MAX_SKILLS_PER_COURSE} 个技能，按相关度从高到低排列，只挂这门课的主要教学内容，不要因为“用到”某技能就挂上；`,
        '3) 核心课尽量至少挂 1 个；思政、英语、体育、军事、劳动等通识课与清单无关时直接返回空数组；但如果课程内容确实不对应清单中的任何技能，skills 返回空数组，并在 reason 里说明，绝不硬挂；',
        '4) 每个技能附一句不超过 40 字的 rationale，说明课程名/内容与该技能的对应关系；',
        '5) 每门课都必须出现在输出中，course 字段逐字使用给定课程名；',
        '6) 只输出 JSON，格式：{"courses":[{"course":string,"skills":[{"skill_id":string,"rationale":string}],"reason":string|null}]}',
        '',
        '【技能清单】',
        skillText,
      ].join('\n'),
    },
    { role: 'user', content: `学校：${ctx.school}\n专业：${ctx.major}\n课程：\n${courseText}` },
  ];
}

/** Validate the model's JSON against the course and skill lists (pure; unit-tested). */
export function parseTagResponse(text: string, courses: CourseForTagging[], skills: SkillRef[]) {
  const errors: string[] = [];
  const tags: SkillTag[] = [];
  const untagged: Untagged[] = [];
  let droppedUnknown = 0, droppedOver = 0;
  const ids = new Set(skills.map((s) => s.id));
  const norm = (s: string) => s.replace(/\s+/g, '');
  let parsed: { courses?: unknown };
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    parsed = {};
    errors.push('response is not JSON');
  }
  const list = Array.isArray(parsed.courses) ? (parsed.courses as Record<string, unknown>[]) : [];
  if (!Array.isArray(parsed.courses) && !errors.length) errors.push('top-level "courses" array missing');
  const byName = new Map(list.filter((x) => typeof x?.course === 'string').map((x) => [norm(x.course as string), x]));
  for (const c of courses) {
    const item = byName.get(norm(c.name));
    if (!item) { untagged.push({ course_id: c.course_id, is_core: isCore(c), reason: 'model returned no entry for this course' }); continue; }
    const seen = new Set<string>();
    const picked: SkillTag[] = [];
    for (const s of Array.isArray(item.skills) ? (item.skills as Record<string, unknown>[]) : []) {
      const id = typeof s?.skill_id === 'string' ? s.skill_id.trim() : '';
      if (!ids.has(id)) { droppedUnknown++; errors.push(`${c.name}: unknown skill_id ${JSON.stringify(id)} dropped`); continue; }
      if (seen.has(id)) continue;
      if (picked.length >= MAX_SKILLS_PER_COURSE) { droppedOver++; continue; }
      seen.add(id);
      picked.push({ course_id: c.course_id, skill_id: id, rationale: typeof s.rationale === 'string' ? s.rationale.trim().slice(0, 200) : '' });
    }
    if (picked.length) tags.push(...picked);
    else untagged.push({ course_id: c.course_id, is_core: isCore(c), reason: typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : 'no matching skill' });
  }
  return { tags, untagged, errors, droppedUnknown, droppedOver };
}

export class LlmSkillTagger implements SkillTagger {
  constructor(private provider: ChatProvider, private cache: LlmCache) {}
  get name() { return this.provider.isMock ? 'mock' : `llm:${this.provider.model}`; }

  async tag(courses: CourseForTagging[], skills: SkillRef[], ctx: { school: string; major: string }): Promise<TagResult> {
    const res: TagResult = { model: this.provider.model, mock: this.provider.isMock, tags: [], untagged: [], errors: [],
      stats: { llm_calls: 0, cached: 0, prompt_tokens: 0, completion_tokens: 0, dropped_unknown_skill: 0, dropped_over_limit: 0 } };
    if (!courses.length || !skills.length) return res;
    const messages = buildTagMessages(courses, skills, ctx);
    const key = cacheKey(this.provider.model, TAG_PROMPT_VERSION, messages.map((m) => m.content).join('\n\u0000\n'));
    let text = this.cache.get(key);
    if (text !== undefined) res.stats.cached++;
    else {
      const r = await this.provider.chat(messages, { json: true, temperature: 0 });
      res.stats.llm_calls++;
      res.stats.prompt_tokens += r.promptTokens ?? 0;
      res.stats.completion_tokens += r.completionTokens ?? 0;
      text = r.text;
      if (!this.provider.isMock) this.cache.set(key, { model: this.provider.model, promptVersion: TAG_PROMPT_VERSION, response: text, promptTokens: r.promptTokens, completionTokens: r.completionTokens });
    }
    const p = parseTagResponse(text, courses, skills);
    Object.assign(res, { tags: p.tags, untagged: p.untagged, errors: p.errors });
    res.stats.dropped_unknown_skill = p.droppedUnknown;
    res.stats.dropped_over_limit = p.droppedOver;
    return res;
  }
}

/** Offline mock: tags a course with every skill whose name occurs in the course name. Never written to the DB. */
export const mockTagProvider = (skills: SkillRef[]) =>
  new MockProvider((messages) => {
    const lines = messages[messages.length - 1]!.content.split('\n').filter((l) => /^\d+\. /.test(l));
    return JSON.stringify({ courses: lines.map((l) => {
      const name = l.replace(/^\d+\. /, '').split('｜')[0]!;
      const hits = skills.filter((s) => name.includes(s.name) || s.name.includes(name)).slice(0, 3);
      return { course: name, skills: hits.map((s) => ({ skill_id: s.id, rationale: 'mock: name match' })), reason: hits.length ? null : 'mock: no name match' };
    }) });
  });
