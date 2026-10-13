/**
 * LLM extraction of every course of a 培养方案 (v2: whole course table, not only core courses).
 * Units sent to the LLM:
 *   - the "核心课程设置" paragraph (core_in_section=true for the listed courses)
 *   - one chunk per 课程类别 block of the 课程设置及学时分配表 (tables.ts), each carrying the table title,
 *     the column header and the block's label hint, so rows keep their block/credits even when the block
 *     label is split across lines; fallback when no table is recognised: keyword-filtered page chunks.
 * Cost control: responses cached by sha256(model + prompt version + prompt); --refresh re-asks the model.
 * Anti-hallucination: every course must quote a snippet that occurs verbatim in its chunk.
 */
import type { ChatMessage, ChatProvider } from '../../lib/llm.js';
import { MockProvider } from '../../lib/llm.js';
import { cacheKey, type LlmCache } from './cache.js';
import { OUTPUT_SCHEMA, validateExtraction, type CourseType, type ExtractedCourse } from './schema.js';
import { findCoreSection, segmentTableBlocks } from './tables.js';
import type { PageText } from './text.js';

export const PROMPT_VERSION = 'curriculum-all-v2';
const CHUNK_CHARS = Number(process.env.LLM_CHUNK_CHARS ?? 6000);
export const RELEVANT = /(核心课|主干课|主干学科|专业核心|学位课|专业基础课|专业必修|课程设置|课程体系|教学计划|课程名称)/;

export interface Chunk { pages: number[]; text: string }

const PAGE_MARK = (p: number) => `[[第${p}页]]`;

/** Concatenate pages (with page markers) into chunks of at most `max` chars; long pages are split by lines. */
export function chunkPages(pages: PageText[], max = CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk = { pages: [], text: '' };
  const flush = () => { if (cur.text.trim()) chunks.push(cur); cur = { pages: [], text: '' }; };
  for (const p of pages) {
    const pieces: string[] = [];
    let buf = '';
    for (const line of p.text.split('\n')) {
      if (buf.length + line.length + 1 > max - 20 && buf) { pieces.push(buf); buf = ''; }
      buf += line + '\n';
    }
    if (buf) pieces.push(buf);
    for (const piece of pieces) {
      const block = `${PAGE_MARK(p.page)}\n${piece}`;
      if (cur.text.length + block.length > max) flush();
      cur.text += block;
      if (!cur.pages.includes(p.page)) cur.pages.push(p.page);
    }
  }
  flush();
  return chunks;
}

export type UnitKind = 'core_section' | 'table_block' | 'fallback';
export interface Unit extends Chunk { kind: UnitKind; table_title?: string | null; header?: string; label_hint?: string }

/** Split a document into LLM units (see header comment). */
export function planChunks(pages: PageText[]): Unit[] {
  const units: Unit[] = [];
  const core = findCoreSection(pages);
  if (core) units.push({ kind: 'core_section', pages: [core.page], text: `[[第${core.page}页]]\n${core.text}` });
  const blocks = segmentTableBlocks(pages);
  for (const b of blocks) {
    // very long blocks are split by lines, each piece keeps the same title/header/label hint
    if (b.text.length <= CHUNK_CHARS) { units.push({ kind: 'table_block', pages: b.pages, text: b.text, table_title: b.table_title, header: b.header, label_hint: b.label_hint }); continue; }
    for (const c of chunkPages([{ page: b.pages[0]!, text: b.text.replace(/^\[\[第\d+页\]\]\n/, '') }], CHUNK_CHARS))
      units.push({ kind: 'table_block', pages: b.pages, text: c.text, table_title: b.table_title, header: b.header, label_hint: b.label_hint });
  }
  if (!blocks.length) for (const c of chunkPages(pages).filter((c) => RELEVANT.test(c.text))) units.push({ kind: 'fallback', ...c });
  return units;
}

const COMMON_RULES = [
  'credits/hours/semester 只在文本中明确给出时填写，否则为 null；page 取课程所在位置前最近的 [[第N页]] 标记中的 N；',
  'snippet 必须是文本中逐字出现的一段原文（不超过 80 字，尽量取该课程所在的那一行，包含课程名），不要改写；',
  'confidence 为 0~1 的把握度；文本中没有课程时返回 {"courses":[]}；',
  `只输出 JSON，格式：${OUTPUT_SCHEMA}`,
];

export function buildMessages(ctx: { school: string; majorCode: string; majorName: string }, unit: Unit): ChatMessage[] {
  const who = `学校：${ctx.school}\n专业：${ctx.majorName}（${ctx.majorCode}）`;
  if (unit.kind === 'core_section') {
    return [
      { role: 'system', content: ['你是高校培养方案信息抽取助手。给定的是培养方案中列出「核心课程/主干课程」的段落。', '抽取段落中列出的每一门课程，core_in_section 一律为 true，block/module/course_type 为 null；课程名跨行断开时要拼接完整（如“计\n算机网络”→“计算机网络”）。', ...COMMON_RULES].join('\n') },
      { role: 'user', content: `${who}\n\n文本：\n${unit.text}` },
    ];
  }
  if (unit.kind === 'table_block') {
    return [
      {
        role: 'system',
        content: [
          '你是高校培养方案信息抽取助手。给定的是「课程设置及学时分配表」中的一个课程类别块（PDF 抽出的文本，单元格以 " | " 分隔）。',
          '规则：1) 抽取块中每一个课程行（含课程组、无课程号的课程），不要抽「应修小计」「应修说明」「合计」行；',
          '2) 类别名称在 PDF 中是竖排的，被拆成单字/短词夹在行之间或行首（如 “学科 | sd… ”、“平台”、“基础”、“课程”）；“类别标签碎片”已按出现顺序拼好供参考，可能混入外层大类（如“通识教育课程”“专业教育课程”）或备注碎片。block 填该课程所属的最内层类别全称，如 “通识教育必修课程”“学科平台基础课程”“专业基础课程”“专业核心课程”“专业限选课程”“专业任选课程”“重点提升计划”；',
          '3) module 填备注列里的模块/方向（如 “系统与安全模块”），没有则 null；“期末集中进行”“分散进行”之类是教学安排，不是模块；',
          '4) course_type：类别名或应修说明表明必修的填 "必修"，限选填 "限选"，任选/选修填 "任选"，无法判断填 null；',
          '5) credits 是“学分数”列（课程名后的第一个数字），hours 是“总学时”列；semester 是“开设学期”列原文；',
          '6) 课程名跨行断开时要拼接完整（如“毛泽东思想和中国特色社会主义理论体系概”+“论”）；core_in_section 一律为 false；',
          ...COMMON_RULES,
        ].join('\n'),
      },
      { role: 'user', content: `${who}\n表格：${unit.table_title ?? '（未识别）'}\n表头：\n${unit.header ?? ''}\n类别标签碎片：${unit.label_hint || '（无）'}\n\n文本：\n${unit.text}` },
    ];
  }
  return [
    {
      role: 'system',
      content: ['你是高校培养方案信息抽取助手。只依据给定文本，抽取该专业的课程（课程表中的课程，以及“核心课程/主干课程”段落中列出的课程）。', '段落中列为核心课程/主干课程的 core_in_section=true；block 填文本中写明的课程类别，course_type 填 必修/限选/任选 或 null。', ...COMMON_RULES].join('\n'),
    },
    { role: 'user', content: `${who}\n\n文本：\n${unit.text}` },
  ];
}

const norm = (s: string) => s.replace(/[\s|]+/g, '');
export const normCourseName = (s: string) => norm(s).replace(/[（(][^）)]*[）)]$/, (m) => (/[0-9ⅠⅡⅢIVX一二三上下]/.test(m) ? m : '')).replace(/[“”"《》]/g, '');

/** course_type from an explicit block name wins over the model's guess */
export const typeFromBlock = (block: string | null, fallback: CourseType | null): CourseType | null =>
  !block ? fallback : /限选/.test(block) ? '限选' : /任选|选修/.test(block) ? '任选' : /必修/.test(block) ? '必修' : fallback;

export interface ExtractionResult {
  model: string;
  mock: boolean;
  prompt_version: string;
  courses: ExtractedCourse[];
  stats: { chunks: number; sent: number; cached: number; llm_calls: number; dropped_invalid: number; dropped_unverified: number; prompt_tokens: number; completion_tokens: number };
  errors: string[];
}

export async function extractCourses(
  pages: PageText[],
  ctx: { school: string; majorCode: string; majorName: string },
  provider: ChatProvider,
  cache: LlmCache,
  opts: { refresh?: boolean } = {},
): Promise<ExtractionResult> {
  const units = planChunks(pages);
  const res: ExtractionResult = {
    model: provider.model, mock: provider.isMock, prompt_version: PROMPT_VERSION, courses: [], errors: [],
    stats: { chunks: units.length, sent: units.length, cached: 0, llm_calls: 0, dropped_invalid: 0, dropped_unverified: 0, prompt_tokens: 0, completion_tokens: 0 },
  };
  const best = new Map<string, ExtractedCourse>();
  const sectionNames = new Set<string>();
  const coreText = norm(units.find((u) => u.kind === 'core_section')?.text ?? '');
  for (const unit of units) {
    const messages = buildMessages(ctx, unit);
    const key = cacheKey(provider.model, PROMPT_VERSION, messages.map((m) => m.content).join('\n\u0000\n'));
    let text = opts.refresh ? undefined : cache.get(key);
    if (text !== undefined) res.stats.cached++;
    else {
      const r = await provider.chat(messages, { json: true, temperature: 0, maxTokens: 8000 });
      res.stats.llm_calls++;
      res.stats.prompt_tokens += r.promptTokens ?? 0;
      res.stats.completion_tokens += r.completionTokens ?? 0;
      text = r.text;
      if (!provider.isMock) cache.set(key, { model: provider.model, promptVersion: PROMPT_VERSION, response: text, promptTokens: r.promptTokens, completionTokens: r.completionTokens });
    }
    const where = `${unit.kind} p${unit.pages.join(',')}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      res.errors.push(`${where}: response is not JSON`);
      continue;
    }
    const v = validateExtraction(parsed);
    res.stats.dropped_invalid += v.errors.length;
    res.errors.push(...v.errors.map((e) => `${where}: ${e}`));
    const hay = norm(unit.text);
    for (const c of v.courses) {
      // anti-hallucination: snippet verbatim in the chunk; the (start of the) course name must be in the chunk
      const nm = norm(c.name).replace(/[（(].*$/, '');
      if (!hay.includes(norm(c.snippet)) || !(norm(c.snippet).includes(nm) || norm(c.snippet).includes(nm.slice(0, 6)) || hay.includes(nm))) {
        res.stats.dropped_unverified++;
        res.errors.push(`${where}: unverified ${c.name}`);
        continue;
      }
      if (!unit.pages.includes(c.page)) c.page = unit.pages[0]!;
      const k = normCourseName(c.name);
      if (unit.kind === 'core_section') { sectionNames.add(k); if (!best.has(k)) best.set(k, { ...c, core_in_section: true, block: null, module: null, course_type: null }); continue; }
      const row: ExtractedCourse = { ...c, core_in_section: false, course_type: typeFromBlock(c.block, c.course_type) };
      const prev = best.get(k);
      if (!prev || (prev.block === null && row.block !== null)) best.set(k, { ...row, core_in_section: prev?.core_in_section ?? false });
      else { prev.credits ??= row.credits; prev.hours ??= row.hours; prev.semester ??= row.semester; }
    }
  }
  for (const [k, c] of best) c.core_in_section = sectionNames.has(k) || (!!coreText && coreText.includes(k)) || c.core_in_section;
  res.courses = [...best.values()];
  return res;
}

/**
 * Offline mock: crude rules ("核心课程：A、B、C" lists, "code | name | credits" table rows) that exercises the whole pipeline.
 * Its output is flagged mock=true and is never ingested as real data.
 */
export const mockProvider = () =>
  new MockProvider((messages) => {
    const text = messages[messages.length - 1]!.content;
    const courses: unknown[] = [];
    let page = 1;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const pm = line.match(/^\[\[第(\d+)页\]\]$/);
      if (pm) { page = Number(pm[1]); continue; }
      const row = line.match(/^(?:[\p{Script=Han}]{1,6} \| )?[A-Za-z0-9]{4,} \| ([^|]+?) \| (\d+(?:\.\d+)?) \|/u);
      if (row) {
        const hint = text.match(/类别标签碎片：(.*)/)?.[1] ?? null;
        courses.push({ name: row[1]!.trim(), course_type: null, block: hint && hint !== '（无）' ? hint : null, module: null, core_in_section: false, credits: Number(row[2]), hours: null, semester: null, page, snippet: line.slice(0, 80), confidence: 0.3 });
        continue;
      }
      const m = line.match(/(核心课程|主干课程|主干学科|专业核心课程)(设置)?\s*[:：]?\s*(.*)$/);
      if (!m) continue;
      // list may continue on the following lines until a sentence end / next heading
      let list = m[3] ?? '';
      for (let j = i + 1; j < lines.length && !/[。]$/.test(list) && j <= i + 3 && !/^[一二三四五六七八九十]+、|^\[\[|^\s*·\s*\d+\s*·/.test(lines[j]!); j++) list += lines[j]!;
      const names = list.replace(/[。.]\s*$/, '').split(/[、，,；;]/).map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 20);
      for (const n of names) {
        const at = line.includes(n) ? line : list;
        courses.push({ name: n, course_type: null, block: null, module: null, core_in_section: true, credits: null, hours: null, semester: null, page, snippet: at.slice(Math.max(0, at.indexOf(n) - 30), at.indexOf(n) + n.length + 30), confidence: 0.3 });
      }
    }
    return JSON.stringify({ courses });
  });
