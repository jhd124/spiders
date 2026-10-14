/**
 * Stage 2: course -> level-2 skill tagging (LLM).
 *  - the model may only pick skill ids from the given list; each course gets 1..3 skills
 *  - 核心课 must get >= 1 skill; a course that fits nothing is reported as untagged — never force-tagged
 *  - responses are cached like extraction (sha256(model + prompt version + prompt)); mock output is never written
 */
import type { ChatMessage, ChatProvider } from '../../lib/llm.js';
import { MockProvider } from '../../lib/llm.js';
import { cacheKey, type LlmCache } from './cache.js';

export const TAG_PROMPT_VERSION = 'course-skill-v3.3-evidence-type';
export const MAX_SKILLS_PER_COURSE = 3;
/** bump when the code-side validation of model output changes (part of the per-course tagging cache key) */
export const TAG_VALIDATION_VERSION = 3;
export const TAG_RULES_VERSION = `${TAG_PROMPT_VERSION}+val${TAG_VALIDATION_VERSION}`;

/** Expert rule (2026-10-13): how a tag is supported by the 培养方案.
 *  原文明确 = the source text says it beyond the bare course name; 课名推断 = only the course name (or its table row) supports it. */
export type EvidenceType = '原文明确' | '课名推断';
/** stored course_skill.evidence_type: the tagger's type, plus 核心课名 assigned deterministically afterwards (see coreNameMatches) */
export type StoredEvidenceType = EvidenceType | '核心课名';
/** Recommendation weight per evidence type: course_skill.weight = EVIDENCE_WEIGHT[type] exactly (no rank/confidence multiplier).
 *  The model's ordering is stored separately in course_skill.tag_rank (1 = most relevant), used only for review sorting.
 *  原文明确 counts fully; 核心课名 (a 正文-listed core course whose name is the skill) 0.8; other course-name inference half. */
export const EVIDENCE_WEIGHT: Record<StoredEvidenceType, number> = { '原文明确': 1.0, '核心课名': 0.8, '课名推断': 0.5 };
/** 课名推断: at most this many skills per course, and never a 工具与技术 skill. */
export const MAX_NAME_INFERRED = 2;
export const tagWeight = (t: StoredEvidenceType) => EVIDENCE_WEIGHT[t];

/**
 * 核心课名 (expert, 2026-10-13): a 课名推断 tag is upgraded to 核心课名 when the course is a 正文-listed core course (is_core = 1)
 * AND its name basically IS the skill name. Deterministic and conservative:
 *   - explicit mapping CORE_NAME_MAP (course name -> skill name), or
 *   - equality after normalizing both names: drop a trailing （…） (双语, (1)…) and the suffixes in CORE_NAME_STRIP.
 * Containment / synonyms never count (算法设计与分析 ≠ 数据结构与算法, 计算机系统导论 ≠ 操作系统原理, 人工智能引论 ≠ 机器学习).
 * Runs as a post-step over stored course_skill rows (no LLM call, does not change which skills are tagged, not part of the
 * per-course tagging cache key). Bump CORE_NAME_VERSION when the rule changes.
 */
export const CORE_NAME_VERSION = 2; // v2 (2026-10-13): 技术/概论 also stripped (数据库系统/数据库技术/数据库系统概论 = 数据库原理)
export const CORE_NAME_MAP: Record<string, string> = {
  '操作系统': '操作系统原理',
  '编译原理': '编译原理',
  '数据结构与算法': '数据结构与算法',
  '软件工程': '软件工程方法',
  '离散数学': '离散数学',
  '计算机网络': '计算机网络协议',
  '计算机组成与系统结构': '计算机组成与体系结构',
  '计算机组成原理': '计算机组成与体系结构',
};
export const CORE_NAME_STRIP = ['与体系结构', '与系统结构', '体系结构', '原理', '方法', '协议', '系统', '技术', '概论'];
const coreNorm = (s: string) => {
  let x = normQuote(s).replace(/[（(][^）)]*[）)]$/, '');
  for (let changed = true; changed;) { changed = false; for (const suf of CORE_NAME_STRIP) if (x.length > suf.length + 1 && x.endsWith(suf)) { x = x.slice(0, -suf.length); changed = true; } }
  return x;
};
export function coreNameMatches(courseName: string, skillName: string): boolean {
  const base = normQuote(courseName).replace(/[（(][^）)]*[）)]$/, '');
  if (CORE_NAME_MAP[base] !== undefined) return CORE_NAME_MAP[base] === skillName;
  return coreNorm(courseName) === coreNorm(skillName);
}
/** final stored type for a tag: 课名推断 on an is_core course whose name is the skill -> 核心课名; otherwise unchanged */
export const storedEvidenceType = (base: StoredEvidenceType, isCoreCourse: boolean, courseName: string, skillName: string): StoredEvidenceType =>
  base === '原文明确' ? base : isCoreCourse && coreNameMatches(courseName, skillName) ? '核心课名' : '课名推断';

/** Tool skills (expert, 2026-10-13): 原文明确 when the tool name literally appears in the course name, or a quote with content
 *  beyond the course name names it. TOOL_NAME_WHITELIST holds the explicitly approved course-name exceptions. Anything else: dropped. */
export const TOOL_NAME_LITERAL: Record<string, RegExp> = {
  'software.c-cpp': /C语言|C\+\+/i,
  'software.java': /Java/i,
  'software.python': /Python/i,
  'software.db-sql': /SQL/i,
  'software.linux': /Linux/i,
  'software.web-frontend': /前端|HTML|JavaScript/i,
  'software.backend': /后端/i,
  'data.bigdata-platform': /Hadoop|Spark/i,
  'data.bi-tools': /商业智能|Tableau|Power ?BI/i,
  'hardware.fpga': /FPGA/i, // expert 2026-10-13: Verilog/VHDL is its own skill, no cross-triggering
  'ai.llm-apps': /大模型|大语言模型|LLM/i,
  // batch 2 (016)
  'hardware.pcb': /PCB|Altium|印制电路板/i,
  'semiconductor.hdl': /Verilog|VHDL/i,
  'semiconductor.eda': /EDA|Cadence|Synopsys/i,
  'embedded.plc': /PLC|可编程控制|可编程逻辑控制器/i, // 2026-10-14 expert: 可编程控制 (技术) is a spelling of PLC
  'mechanical.cad': /CAD|SolidWorks|AutoCAD/i,
  'mechanical.fea': /有限元|ANSYS|Abaqus/i,
  'foundation.matlab': /MATLAB/i,
};
export const TOOL_NAME_WHITELIST: Record<string, string[]> = {
  // (empty) the 数据库系统 -> 数据库与SQL exception was withdrawn by the expert 2026-10-13 (017): 数据库 courses get 数据库原理
};

/** Table-row noise: course codes, numbers, separators and the usual column words (学分/学时/考试…). */
const ROW_NOISE = /[A-Za-z0-9.\s|｜\u00a0,，、。;；:：()（）\[\]【】\-—_/*+~]+|考试|考查|必修|选修|限选|任选|学分|学时|学期|周数|理论|实验|实践|上机|小计|应修|合计|双语|全英文?|秋|春|夏/g;
/** true when the quote contains nothing beyond the course name and table-row noise -> the tag can only be 课名推断 */
export function quoteIsNameOnly(quote: string, courseName: string, otherNames: string[] = []): boolean {
  let q = normQuote(quote);
  // a list of course names (e.g. the 核心课程 sentence "操作系统、数据库系统、…") describes nothing beyond names either
  const names = [courseName, ...otherNames].map(normQuote).flatMap((n) => [n, n.replace(/[（(][^）)]*[）)]$/, '')]).filter((x) => x.length >= 2).sort((a, b) => b.length - a.length);
  for (const x of names) q = q.split(x).join('');
  // <=2 leftover characters = a name fragment cut at a line break (…、计)
  return q.replace(ROW_NOISE, '').length <= 2;
}

/** List filler around enumerated course names: "……等专业课程实验", "包括…以及…等课程" */
const LIST_FILLER = /[…\.。，,、；;：:“”"'（）()\s]|等|及|以及|和|与|包括|如|主要|有|专业|核心|基础|课程|课|实验|实践|教学|环节|内容|开设|设置|学习|修读/g;
/** Expert rule (2026-10-13): a quote that merely enumerates course names (e.g. "……数据结构、操作系统等专业课程实验") says nothing
 *  about the tagged course's content, so it can never be 原文明确 and goes to needs_review. Heuristic: the quote names >= 2
 *  courses (or uses an "等…课程" list marker), and after removing names, list filler and table noise almost nothing is left. */
export function quoteIsCourseList(quote: string, courseName: string, otherNames: string[] = []): boolean {
  let q = normQuote(quote);
  const names = [...new Set([courseName, ...otherNames].map(normQuote).flatMap((n) => [n, n.replace(/[（(][^）)]*[）)]$/, '')]).filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length);
  let hits = 0;
  for (const x of names) { if (q.includes(x)) { hits++; q = q.split(x).join('、'); } }
  const enumerated = (q.match(/、/g)?.length ?? 0) >= 2;
  const listMarker = /等[^，。；]{0,6}课程|课程[^，。；]{0,4}等/.test(normQuote(quote));
  if (hits < 2 && !(listMarker && (hits >= 1 || enumerated))) return false;
  return q.replace(ROW_NOISE, '').replace(LIST_FILLER, '').length <= 3;
}
export const COURSE_LIST_REASON = '引用原文只是罗列课名，不能算原文明确';
/** applies the course-list rule to an already validated tag (fresh or from the per-course cache) */
export function applyCourseListRule<T extends { evidence_type: string; evidence_quote: string | null; needs_review: boolean; review_reason: string | null }>(t: T, courseName: string, otherNames: string[] = [], skillId?: string): T {
  if (skillId && TOOL_TERMS[skillId]) return t; // tool tags were validated by the tool rule (literal name / whitelist)
  if (t.evidence_type !== '原文明确' || !t.evidence_quote || !quoteIsCourseList(t.evidence_quote, courseName, otherNames)) return t;
  if (t.review_reason?.includes(COURSE_LIST_REASON)) return { ...t, evidence_type: '课名推断', needs_review: true };
  return { ...t, evidence_type: '课名推断', needs_review: true, review_reason: t.review_reason ? `${t.review_reason}；${COURSE_LIST_REASON}` : COURSE_LIST_REASON };
}

export interface SkillRef { id: string; name: string; domain_id: string; domain_name: string; skill_type?: string }
export interface CourseForTagging { course_id: string; name: string; course_type: string | null; credits: number | null; snippet: string | null; is_core?: number | null; table_block?: string | null }
/** source text the tagger may quote from: excerpt sent to the model + the full text the quote is checked against */
export interface TagEvidence { excerpt: string; full: string; courseNames?: string[] }
export interface SkillTag { course_id: string; skill_id: string; evidence_type: EvidenceType; rationale: string; evidence_quote: string | null; needs_review: boolean; review_reason: string | null }
export interface Untagged { course_id: string; is_core: boolean; reason: string }
export interface TagResult {
  model: string;
  mock: boolean;
  tags: SkillTag[];
  untagged: Untagged[];
  errors: string[];
  stats: { llm_calls: number; cached: number; prompt_tokens: number; completion_tokens: number; dropped_unknown_skill: number; dropped_over_limit: number; dropped_name_inferred: number };
}

export interface SkillTagger {
  readonly name: string;
  tag(courses: CourseForTagging[], skills: SkillRef[], ctx: { school: string; major: string }, evidence?: TagEvidence): Promise<TagResult>;
}

/** core = listed in the 正文 核心课程 section only (expert rule, 009) */
export const isCore = (c: CourseForTagging) => c.is_core === 1;

/** Tool rule re-checked on stored/cached tags (the cache may hold results validated under older rules): a 工具与技术 tag survives
 *  only when the tool is literally in the course name or the quote names it (and is more than course names). */
export function toolTagStillValid(skillId: string, courseName: string, quote: string | null): boolean {
  const term = TOOL_TERMS[skillId];
  if (!term) return true;
  if (TOOL_NAME_LITERAL[skillId]?.test(courseName)) return true;
  return !!quote && term.test(quote) && !quoteIsNameOnly(quote, courseName);
}

export const HEDGE = /可能|常用|一般|通常|或许|大概/;
/** whitespace- and table-separator-insensitive form used to check that a quote really occurs in the source text */
export const normQuote = (s: string) => s.replace(/[\s|｜\u00a0]+/g, '');
/** A 工具与技术 skill needs its tool named in the quote (expert rule: tools only when the text says so). */
export const TOOL_TERMS: Record<string, RegExp> = {
  'software.c-cpp': /C语言|C\+\+|C\/C\+\+|(^|[^A-Za-z])C程序/i,
  'software.java': /Java/i,
  'software.python': /Python/i,
  'software.db-sql': /SQL/i, // pure tool: only an explicit SQL (数据库 courses -> 数据库原理, 专业知识)
  'software.linux': /Linux/i,
  'software.web-frontend': /Web|前端|HTML|JavaScript/i,
  'software.backend': /后端|服务端|Web/i,
  'data.bigdata-platform': /Hadoop|Spark|大数据平台/i,
  'data.bi-tools': /商业智能|\bBI\b|Tableau|Power ?BI/i,
  'hardware.fpga': /FPGA/i,
  'ai.llm-apps': /大模型|大语言模型|LLM|GPT/i,
  // batch 2 (016): only when the text names the tool
  'hardware.pcb': /PCB|Altium|印制电路板/i,
  'semiconductor.hdl': /Verilog|VHDL|硬件描述语言/i,
  'semiconductor.eda': /EDA|Cadence|Synopsys|电子设计自动化/i,
  'embedded.plc': /PLC|可编程控制|可编程逻辑控制器/i, // 2026-10-14 expert: 可编程控制 (技术) is a spelling of PLC
  'mechanical.cad': /CAD|SolidWorks|AutoCAD|计算机辅助设计/i,
  'mechanical.fea': /有限元|ANSYS|Abaqus/i,
  'foundation.matlab': /MATLAB/i,
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
        '4) 标 [工具] 的技能（编程语言、数据库与SQL、Linux、FPGA 等）只有当原文明确写出该工具/语言时才能挂（大数据平台也不例外：原文没写 Hadoop/Spark/大数据平台就不挂，课程名含“大数据”也不行；例如出现 FPGA 才可挂 FPGA；出现 Verilog、VHDL、硬件描述语言才可挂 Verilog/VHDL；出现 Python 才可挂 Python；出现 SQL 才可挂数据库与SQL，课程名含“数据库”不算——数据库类课程挂知识技能“数据库原理”）；不得因为课程“通常会用到”而挂；',
        '5) 每个技能必须附 quote：从【原文】中逐字复制的一段文字（≤60字），不得改写、拼接或补字；rationale 一句话（≤40字），不要用“可能/常用/一般/通常/或许/大概”等推测性措辞；',
        '6) 只挂课程名或原文直接说明的内容，不要扩展到相邻领域（如“计算机图形学”不挂计算机视觉，“人工智能引论”原文没写深度学习/自然语言处理就只挂机器学习）；思政、英语、体育、军事、劳动、通识、创新创业、实习、毕业论文、综合实践/成果展示等环节，原文没写具体技术内容时 skills 返回空数组并在 reason 说明，绝不硬挂；',
        '7) 每门课都必须出现在输出中，course 字段逐字使用给定课程名；',
        `8) 每个技能标 evidence_type：原文除课程名（及表格行里的课程号、学分、学时等）之外还写了相关内容 → "原文明确"；只凭课程名 → "课名推断"。课名推断只用于明确的情况：课程名直接包含技能名，或是该领域的标准导论课；最多 ${MAX_NAME_INFERRED} 个，且只能是知识类技能（[工具] 一律不能推断）；“计算概论”这类名字宽泛、各校内容差别大的课宁可不挂。注意：原文只列出课程名、没有课程简介，不是不挂的理由——专业课的课程名直接对应某个知识类技能时，必须按课名推断挂上（例：“计算机系统导论”→计算机组成与体系结构+操作系统原理，“嵌入式系统原理与应用”→嵌入式硬件，“汇编语言”→计算机组成与体系结构）；课程名里直接写出工具名（如“Python程序设计”含“Python”）时，该工具技能算原文明确；`,
        '9) 只输出 JSON，格式：{"courses":[{"course":string,"skills":[{"skill_id":string,"evidence_type":"原文明确"|"课名推断","quote":string,"rationale":string}],"reason":string|null}]}',
        '',
        '【技能清单】',
        skillText,
      ].join('\n'),
    },
    { role: 'user', content: `学校：${ctx.school}\n专业：${ctx.major}\n课程：\n${courseText}\n\n【原文】（培养方案中提到这些课程的文字）\n${evidence?.excerpt || courses.map((c) => c.snippet).filter(Boolean).join('\n') || '（无）'}` },
  ];
}

/** Validate the model's JSON against the course and skill lists (pure; unit-tested). */
export function parseTagResponse(text: string, courses: CourseForTagging[], skills: SkillRef[], sourceText?: string, courseNames: string[] = []) {
  const allNames = [...new Set([...courseNames, ...courses.map((c) => c.name)])];
  const errors: string[] = [];
  const tags: SkillTag[] = [];
  const untagged: Untagged[] = [];
  let droppedUnknown = 0, droppedOver = 0, droppedNameInferred = 0;
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
      // evidence type: the model's claim, downgraded by code when the quote is unverified or holds nothing beyond the course name.
      const nameOnly = !found || quoteIsNameOnly(quote!, c.name, allNames);
      let evidence_type: EvidenceType = s.evidence_type === '课名推断' || nameOnly ? '课名推断' : '原文明确';
      if (term) {
        const base = normQuote(c.name).replace(/[（(][^）)]*[）)]$/, '');
        const literalInName = !!TOOL_NAME_LITERAL[id]?.test(c.name) || !!TOOL_NAME_WHITELIST[base]?.includes(id);
        const namedByText = found && !nameOnly && term.test(quote!);
        if (!literalInName && !namedByText) { errors.push(`${c.name}: tool skill ${id} dropped (tool not literally in the course name or the source text)`); continue; }
        evidence_type = '原文明确';
      }
      if (evidence_type === '课名推断') {
        if (term) { droppedNameInferred++; errors.push(`${c.name}: tool skill ${id} dropped (课名推断 never yields a tool skill)`); continue; }
        if (picked.filter((x) => x.evidence_type === '课名推断').length >= MAX_NAME_INFERRED) { droppedNameInferred++; errors.push(`${c.name}: ${id} dropped (课名推断 max ${MAX_NAME_INFERRED})`); continue; }
      }
      const reasons: string[] = [];
      if (!quote) reasons.push('没有原文引用');
      else if (!found) reasons.push('引用不在原文中');
      const hedge = rationale.match(HEDGE);
      if (hedge) reasons.push(`理由含推测词「${hedge[0]}」`);
      seen.add(id);
      // course-list quote: never 原文明确 (tools named literally in the course name stay; the quote is still flagged)
      if (found && quoteIsCourseList(quote!, c.name, allNames)) {
        if (!(term && (TOOL_NAME_LITERAL[id]?.test(c.name) || TOOL_NAME_WHITELIST[normQuote(c.name).replace(/[（(][^）)]*[）)]$/, '')]?.includes(id)))) {
          if (term) { errors.push(`${c.name}: tool skill ${id} dropped (quote only lists course names)`); continue; }
          if (evidence_type === '原文明确' && picked.filter((x) => x.evidence_type === '课名推断').length >= MAX_NAME_INFERRED) { droppedNameInferred++; errors.push(`${c.name}: ${id} dropped (课名推断 max ${MAX_NAME_INFERRED})`); continue; }
          if (evidence_type === '原文明确' || s.evidence_type === '原文明确') reasons.push(COURSE_LIST_REASON);
          evidence_type = '课名推断';
        } else reasons.push(COURSE_LIST_REASON);
      }
      picked.push({ course_id: c.course_id, skill_id: id, evidence_type, rationale, evidence_quote: quote, needs_review: reasons.length > 0, review_reason: reasons.length ? reasons.join('；') : null });
    }
    if (picked.length) tags.push(...picked);
    else untagged.push({ course_id: c.course_id, is_core: isCore(c), reason: typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : 'no matching skill' });
  }
  return { tags, untagged, errors, droppedUnknown, droppedOver, droppedNameInferred };
}

export class LlmSkillTagger implements SkillTagger {
  constructor(private provider: ChatProvider, private cache: LlmCache) {}
  get name() { return this.provider.isMock ? 'mock' : `llm:${this.provider.model}`; }

  async tag(courses: CourseForTagging[], skills: SkillRef[], ctx: { school: string; major: string }, evidence?: TagEvidence): Promise<TagResult> {
    const res: TagResult = { model: this.provider.model, mock: this.provider.isMock, tags: [], untagged: [], errors: [],
      stats: { llm_calls: 0, cached: 0, prompt_tokens: 0, completion_tokens: 0, dropped_unknown_skill: 0, dropped_over_limit: 0, dropped_name_inferred: 0 } };
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
    const p = parseTagResponse(text, courses, skills, evidence?.full, evidence?.courseNames);
    Object.assign(res, { tags: p.tags, untagged: p.untagged, errors: p.errors });
    res.stats.dropped_unknown_skill = p.droppedUnknown;
    res.stats.dropped_over_limit = p.droppedOver;
    res.stats.dropped_name_inferred = p.droppedNameInferred;
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
