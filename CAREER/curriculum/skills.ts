/**
 * Stage 2: course -> level-2 skill tagging (LLM).
 *  - the model may only pick skill ids from the given list; each course gets 1..3 skills
 *  - 核心课 must get >= 1 skill; a course that fits nothing is reported as untagged — never force-tagged
 *  - responses are cached like extraction (sha256(model + prompt version + prompt)); mock output is never written
 */
import type { ChatMessage, ChatProvider } from '../../lib/llm.js';
import { MockProvider } from '../../lib/llm.js';
import { cacheKey, type LlmCache } from './cache.js';

export const TAG_PROMPT_VERSION = 'course-skill-v3.1-evidence';
export const MAX_SKILLS_PER_COURSE = 3;

export interface SkillRef { id: string; name: string; domain_id: string; domain_name: string; skill_type?: string }
export interface CourseForTagging { course_id: string; name: string; course_type: string | null; credits: number | null; snippet: string | null; is_core?: number | null; table_block?: string | null }
/** source text the tagger may quote from: excerpt sent to the model + the full text the quote is checked against */
export interface TagEvidence { excerpt: string; full: string }
export interface SkillTag { course_id: string; skill_id: string; rationale: string; evidence_quote: string | null; needs_review: boolean; review_reason: string | null }
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
  tag(courses: CourseForTagging[], skills: SkillRef[], ctx: { school: string; major: string }, evidence?: TagEvidence): Promise<TagResult>;
}

/** core = listed in the 正文 核心课程 section only (expert rule, 009) */
export const isCore = (c: CourseForTagging) => c.is_core === 1;

export const HEDGE = /可能|常用|一般|通常|或许|大概/;
/** whitespace- and table-separator-insensitive form used to check that a quote really occurs in the source text */
export const normQuote = (s: string) => s.replace(/[\s|｜\u00a0]+/g, '');
/** A 工具与技术 skill needs its tool named in the quote (expert rule: tools only when the text says so). */
export const TOOL_TERMS: Record<string, RegExp> = {
  'software.c-cpp': /C语言|C\+\+|C\/C\+\+|(^|[^A-Za-z])C程序/i,
  'software.java': /Java/i,
  'software.python': /Python/i,
  'software.db-sql': /数据库|SQL/i,
  'software.linux': /Linux/i,
  'software.web-frontend': /Web|前端|HTML|JavaScript/i,
  'software.backend': /后端|服务端|Web/i,
  'data.bigdata-platform': /Hadoop|Spark|大数据平台/i,
  'data.bi-tools': /商业智能|\bBI\b|Tableau|Power ?BI/i,
  'hardware.fpga': /FPGA|硬件描述语言|Verilog|VHDL/i,
  'ai.llm-apps': /大模型|大语言模型|LLM|GPT/i,
};

export function buildTagMessages(courses: CourseForTagging[], skills: SkillRef[], ctx: { school: string; major: string }, evidence?: TagEvidence): ChatMessage[] {
  const byDomain = new Map<string, SkillRef[]>();
  for (const s of skills) byDomain.set(`${s.domain_name}(${s.domain_id})`, [...(byDomain.get(`${s.domain_name}(${s.domain_id})`) ?? []), s]);
  const skillText = [...byDomain].map(([d, ss]) => `${d}: ${ss.map((s) => `${s.id}=${s.name}${s.skill_type === '工具与技术' ? '[工具]' : ''}`).join('；')}`).join('\n');
  const courseText = courses.map((c, i) => `${i + 1}. ${c.name}｜${[isCore(c) ? '核心课' : null, c.table_block, c.course_type].filter(Boolean).join('/') || '课程'}${c.credits != null ? `｜${c.credits}学分` : ''}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        '你是高校课程与职业技能对应的标注助手。只依据【原文】给每门课程从【技能清单】里挑选它直接教授的技能，必须有原文证据。',
        '规则：1) skill_id 只能取自技能清单中的 id，不得自造；',
        `2) 每门课挂 0~${MAX_SKILLS_PER_COURSE} 个技能，按相关度从高到低排列，只挂这门课的主要教学内容；不要凭常识推测课程“会用到”什么；`,
        '3) 课程名本身就是证据：课程名直接对应某个知识类技能时（如“操作系统”→操作系统原理、“机器学习（双语）”→机器学习、“密码学引论”→密码学、“信息安全导论”→信息安全基础+密码学、“大数据管理与分析”→数据清洗与处理），应当挂上，quote 用原文中包含该课程名的那一行；',
        '4) 标 [工具] 的技能（编程语言、数据库与SQL、Linux、FPGA 等）只有当原文明确写出该工具/语言时才能挂（大数据平台也不例外：原文没写 Hadoop/Spark/大数据平台就不挂，课程名含“大数据”也不行；例如出现 FPGA、Verilog、硬件描述语言才可挂 FPGA；出现 Python 才可挂 Python；课程名含“数据库”可挂数据库与SQL）；不得因为课程“通常会用到”而挂；',
        '5) 每个技能必须附 quote：从【原文】中逐字复制的一段文字（≤60字），不得改写、拼接或补字；rationale 一句话（≤40字），不要用“可能/常用/一般/通常/或许/大概”等推测性措辞；',
        '6) 只挂课程名或原文直接说明的内容，不要扩展到相邻领域（如“计算机图形学”不挂计算机视觉，“人工智能引论”原文没写深度学习/自然语言处理就只挂机器学习）；思政、英语、体育、军事、劳动、通识、创新创业、实习、毕业论文、综合实践/成果展示等环节，原文没写具体技术内容时 skills 返回空数组并在 reason 说明，绝不硬挂；',
        '7) 每门课都必须出现在输出中，course 字段逐字使用给定课程名；',
        '8) 只输出 JSON，格式：{"courses":[{"course":string,"skills":[{"skill_id":string,"quote":string,"rationale":string}],"reason":string|null}]}',
        '',
        '【技能清单】',
        skillText,
      ].join('\n'),
    },
    { role: 'user', content: `学校：${ctx.school}\n专业：${ctx.major}\n课程：\n${courseText}\n\n【原文】（培养方案中提到这些课程的文字）\n${evidence?.excerpt || courses.map((c) => c.snippet).filter(Boolean).join('\n') || '（无）'}` },
  ];
}

/** Validate the model's JSON against the course and skill lists (pure; unit-tested). */
export function parseTagResponse(text: string, courses: CourseForTagging[], skills: SkillRef[], sourceText?: string) {
  const errors: string[] = [];
  const tags: SkillTag[] = [];
  const untagged: Untagged[] = [];
  let droppedUnknown = 0, droppedOver = 0;
  const ids = new Set(skills.map((s) => s.id));
  const typeOf = new Map(skills.map((s) => [s.id, s.skill_type]));
  const hay = normQuote(sourceText ?? courses.map((c) => c.snippet ?? '').join('\n'));
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
      const rationale = typeof s.rationale === 'string' ? s.rationale.trim().slice(0, 200) : '';
      const quote = typeof s.quote === 'string' && s.quote.trim() ? s.quote.trim().slice(0, 300) : null;
      const found = !!quote && hay.includes(normQuote(quote));
      // a tool skill is only allowed when the verified quote names the tool; otherwise drop it (never accept a guessed tool)
      const term = TOOL_TERMS[id] ?? (typeOf.get(id) === '工具与技术' ? new RegExp(skills.find((x) => x.id === id)!.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null);
      if (term && !(found && term.test(quote!))) { errors.push(`${c.name}: tool skill ${id} dropped (source text does not name it)`); continue; }
      const reasons: string[] = [];
      if (!quote) reasons.push('没有原文引用');
      else if (!found) reasons.push('引用不在原文中');
      const hedge = rationale.match(HEDGE);
      if (hedge) reasons.push(`理由含推测词「${hedge[0]}」`);
      seen.add(id);
      picked.push({ course_id: c.course_id, skill_id: id, rationale, evidence_quote: quote, needs_review: reasons.length > 0, review_reason: reasons.length ? reasons.join('；') : null });
    }
    if (picked.length) tags.push(...picked);
    else untagged.push({ course_id: c.course_id, is_core: isCore(c), reason: typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : 'no matching skill' });
  }
  return { tags, untagged, errors, droppedUnknown, droppedOver };
}

export class LlmSkillTagger implements SkillTagger {
  constructor(private provider: ChatProvider, private cache: LlmCache) {}
  get name() { return this.provider.isMock ? 'mock' : `llm:${this.provider.model}`; }

  async tag(courses: CourseForTagging[], skills: SkillRef[], ctx: { school: string; major: string }, evidence?: TagEvidence): Promise<TagResult> {
    const res: TagResult = { model: this.provider.model, mock: this.provider.isMock, tags: [], untagged: [], errors: [],
      stats: { llm_calls: 0, cached: 0, prompt_tokens: 0, completion_tokens: 0, dropped_unknown_skill: 0, dropped_over_limit: 0 } };
    if (!courses.length || !skills.length) return res;
    const messages = buildTagMessages(courses, skills, ctx, evidence);
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
    const p = parseTagResponse(text, courses, skills, evidence?.full);
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
      return { course: name, skills: hits.map((s) => ({ skill_id: s.id, quote: name, rationale: 'mock: name match' })), reason: hits.length ? null : 'mock: no name match' };
    }) });
  });
