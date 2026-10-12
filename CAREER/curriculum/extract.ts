/**
 * LLM extraction of 专业核心课 / 主干课 from 培养方案 text.
 * Cost control: only chunks that mention core/main courses are sent (keyword prefilter), chunks are capped
 * (LLM_CHUNK_CHARS, default 6000), responses are cached by sha256(model + prompt version + chunk), and every
 * returned course must quote a snippet that really occurs in the chunk (else it is dropped).
 */
import type { ChatMessage, ChatProvider } from '../../lib/llm.js';
import { MockProvider } from '../../lib/llm.js';
import { cacheKey, type LlmCache } from './cache.js';
import { OUTPUT_SCHEMA, validateExtraction, type ExtractedCourse } from './schema.js';
import type { PageText } from './text.js';

export const PROMPT_VERSION = 'curriculum-core-v1';
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

export function buildMessages(ctx: { school: string; majorCode: string; majorName: string }, chunk: Chunk): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是高校培养方案信息抽取助手。只依据给定文本，抽取该专业的「专业核心课程」和「主干课程」。',
        '规则：1) 不要选修课、通识课、公共基础课（思政、英语、体育等），除非文本明确把它列为核心课/主干课；',
        '2) course_type 只能是 "核心"（文本称核心课程/专业核心课）或 "主干"（文本称主干课程/主干学科课程/学位课）；',
        '3) credits/hours/semester 只在文本中明确给出时填写，否则为 null；',
        '4) page 取课程所在位置前最近的 [[第N页]] 标记中的 N；',
        '5) snippet 必须是文本中逐字出现的一段原文（不超过 120 字，包含该课程名），不要改写；',
        '6) confidence 为 0~1 的把握度；7) 文本中没有核心/主干课程时返回 {"courses":[]}；',
        `8) 只输出 JSON，格式：${OUTPUT_SCHEMA}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `学校：${ctx.school}\n专业：${ctx.majorName}（${ctx.majorCode}）\n\n文本：\n${chunk.text}`,
    },
  ];
}

const norm = (s: string) => s.replace(/[\s|]+/g, '');
export const normCourseName = (s: string) => norm(s).replace(/[（(][^）)]*[）)]$/, (m) => (/[0-9ⅠⅡⅢIVX一二三上下]/.test(m) ? m : '')).replace(/[“”"《》]/g, '');

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
): Promise<ExtractionResult> {
  const chunks = chunkPages(pages);
  const relevant = chunks.filter((c) => RELEVANT.test(c.text));
  const res: ExtractionResult = {
    model: provider.model, mock: provider.isMock, prompt_version: PROMPT_VERSION, courses: [], errors: [],
    stats: { chunks: chunks.length, sent: relevant.length, cached: 0, llm_calls: 0, dropped_invalid: 0, dropped_unverified: 0, prompt_tokens: 0, completion_tokens: 0 },
  };
  const best = new Map<string, ExtractedCourse>();
  for (const chunk of relevant) {
    const messages = buildMessages(ctx, chunk);
    const key = cacheKey(provider.model, PROMPT_VERSION, messages.map((m) => m.content).join('\n\u0000\n'));
    let text = cache.get(key);
    if (text !== undefined) res.stats.cached++;
    else {
      const r = await provider.chat(messages, { json: true, temperature: 0 });
      res.stats.llm_calls++;
      res.stats.prompt_tokens += r.promptTokens ?? 0;
      res.stats.completion_tokens += r.completionTokens ?? 0;
      text = r.text;
      if (!provider.isMock) cache.set(key, { model: provider.model, promptVersion: PROMPT_VERSION, response: text, promptTokens: r.promptTokens, completionTokens: r.completionTokens });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      res.errors.push(`chunk p${chunk.pages.join(',')}: response is not JSON`);
      continue;
    }
    const v = validateExtraction(parsed);
    res.stats.dropped_invalid += v.errors.length;
    res.errors.push(...v.errors.map((e) => `chunk p${chunk.pages.join(',')}: ${e}`));
    const hay = norm(chunk.text);
    for (const c of v.courses) {
      // anti-hallucination: snippet must be verbatim in the chunk and mention the course
      if (!hay.includes(norm(c.snippet)) || !norm(c.snippet).includes(norm(c.name).replace(/[（(].*$/, ''))) {
        res.stats.dropped_unverified++;
        continue;
      }
      if (!chunk.pages.includes(c.page)) c.page = chunk.pages[0]!;
      const k = normCourseName(c.name);
      const prev = best.get(k);
      if (!prev || c.confidence > prev.confidence) {
        best.set(k, { ...c, credits: c.credits ?? prev?.credits ?? null, hours: c.hours ?? prev?.hours ?? null, semester: c.semester ?? prev?.semester ?? null });
      } else {
        prev.credits ??= c.credits; prev.hours ??= c.hours; prev.semester ??= c.semester;
        if (prev.course_type === '主干' && c.course_type === '核心') prev.course_type = '核心';
      }
    }
  }
  res.courses = [...best.values()];
  return res;
}

/**
 * Offline mock: a crude rule (lines like "核心课程：A、B、C") that exercises the whole pipeline.
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
      const m = line.match(/(核心课程|主干课程|主干学科|专业核心课程)(设置)?\s*[:：]?\s*(.*)$/);
      if (!m) continue;
      // list may continue on the following lines until a sentence end / next heading
      let list = m[3] ?? '';
      for (let j = i + 1; j < lines.length && !/[。]$/.test(list) && j <= i + 3 && !/^[一二三四五六七八九十]+、|^\[\[|^\s*·\s*\d+\s*·/.test(lines[j]!); j++) list += lines[j]!;
      const names = list.replace(/[。.]\s*$/, '').split(/[、，,；;]/).map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 20);
      for (const n of names) {
        const at = line.includes(n) ? line : list;
        courses.push({ name: n, course_type: m[1]!.includes('主干') ? '主干' : '核心', credits: null, hours: null, semester: null, page, snippet: at.slice(Math.max(0, at.indexOf(n) - 30), at.indexOf(n) + n.length + 30), confidence: 0.3 });
      }
    }
    return JSON.stringify({ courses });
  });
