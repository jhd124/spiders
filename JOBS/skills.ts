/**
 * JD -> skill extraction.
 *  1. deterministic term match (no LLM): skill names, CAREER skill_alias, plus JOBS/seeds/jd_skill_terms.csv
 *     (exact-match aliases are course-name-only and skipped here; JD vocabulary like 'Linux'/'PyTorch' is kept OUT of skill_alias on purpose: skill_alias also tags courses by name).
 *     ASCII terms match on word boundaries, case-insensitive; CJK terms by substring.
 *  2. LLM fallback hook, only for postings with no term hit, only when `--llm` is passed AND LLM_* env is configured
 *     (the server's lib/llm providerFromEnv / deepseek-chat). Never runs locally without a key; tests use MockProvider.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { parseCsv } from '../lib/csv.js';
import type { ChatProvider } from '../lib/llm.js';

export const JD_TERMS_CSV = join(dirname(fileURLToPath(import.meta.url)), 'seeds', 'jd_skill_terms.csv');

export interface Term { term: string; skill_id: string; re: RegExp | null }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function makeTerm(term: string, skill_id: string): Term | null {
  const t = term.trim();
  if (!t) return null;
  const ascii = /^[\x20-\x7e]+$/.test(t);
  if (ascii && t.replace(/[^A-Za-z0-9]/g, '').length < 2 && !/[+#]/.test(t)) return null; // 'C', 'R', 'Go' alone are too ambiguous
  return { term: t, skill_id, re: ascii ? new RegExp(`(?<![A-Za-z0-9+#])${esc(t).replace(/\\? /g, '\\s*')}(?![A-Za-z0-9+#])`, 'i') : null };
}

/** split display names like '大数据平台（Hadoop/Spark）', 'C/C++', 'Verilog/VHDL' into matchable terms */
export function nameTerms(name: string): string[] {
  const inner = [...name.matchAll(/[（(]([^）)]+)[）)]/g)].flatMap((m) => m[1]!.split('/'));
  const outer = name.replace(/[（(][^）)]*[）)]/g, '');
  const parts = outer.includes('/') ? outer.split('/') : [outer];
  return [...parts, ...inner].map((s) => s.replace(/使用$/, '').trim()).filter((s) => s.length >= 2);
}

export function loadTerms(db: Database.Database, csvPath = JD_TERMS_CSV): Term[] {
  const known = new Set((db.prepare('SELECT id FROM skill').all() as { id: string }[]).map((r) => r.id));
  const raw: [string, string][] = [];
  for (const s of db.prepare('SELECT id, name FROM skill').all() as { id: string; name: string }[]) for (const t of nameTerms(s.name)) raw.push([t, s.id]);
  for (const a of db.prepare("SELECT alias, skill_id FROM skill_alias WHERE match = 'contains'").all() as { alias: string; skill_id: string }[]) raw.push([a.alias, a.skill_id]);
  for (const r of parseCsv(readFileSync(csvPath, 'utf8'))) if (r.term && r.skill_id && known.has(r.skill_id.trim())) raw.push([r.term, r.skill_id.trim()]);
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const [t, id] of raw) {
    const k = `${t.toLowerCase()}\t${id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const term = makeTerm(t, id);
    if (term) out.push(term);
  }
  return out;
}

export function matchTerms(text: string, terms: Term[]): Map<string, string> {
  const hits = new Map<string, string>(); // skill_id -> first matched term
  const lower = text.toLowerCase();
  for (const t of terms) {
    if (hits.has(t.skill_id)) continue;
    if (t.re ? t.re.test(text) : lower.includes(t.term.toLowerCase())) hits.set(t.skill_id, t.term);
  }
  return hits;
}

/** LLM fallback: returns validated skill ids (unknown ids from the model are dropped). */
export async function llmExtractSkills(provider: ChatProvider, title: string, jd: string, skills: { id: string; name: string }[]): Promise<{ skill_id: string; quote: string }[]> {
  const res = await provider.chat(
    [
      { role: 'system', content: '你是招聘JD技能标注助手。只从给定技能清单里选择JD明确要求的技能，输出JSON：{"skills":[{"id":"技能id","quote":"JD原文片段"}]}。没有就输出空数组。' },
      { role: 'user', content: `技能清单：\n${skills.map((s) => `${s.id}\t${s.name}`).join('\n')}\n\n职位：${title}\nJD：\n${jd.slice(0, 3000)}` },
    ],
    { json: true, temperature: 0 },
  );
  const ids = new Set(skills.map((s) => s.id));
  try {
    const j = JSON.parse(res.text) as { skills?: { id?: string; quote?: string }[] };
    return (j.skills ?? []).filter((s) => s.id && ids.has(s.id)).map((s) => ({ skill_id: s.id!, quote: (s.quote ?? '').slice(0, 200) }));
  } catch {
    return [];
  }
}

/**
 * Skill tagging in two passes.
 *  1. Term pass: postings with skills_extracted_at NULL (all in scope with `all`/--force). Alias/term tags are rebuilt
 *     deterministically and skills_extracted_at is set (= "term pass done", nothing more).
 *  2. LLM pass (only when a provider is given): in-scope postings with a JD, ZERO skills and llm_attempted_at NULL
 *     (with `all`/--force: every posting without a term tag, even if the LLM tagged it before). llm_attempted_at is set after each call, so a run never re-sends a posting
 *     unless forced. Without a provider nothing is marked as LLM-attempted, so a later --llm run still picks them up.
 */
export async function tagPostings(db: Database.Database, opts: { all?: boolean; llm?: ChatProvider | null; llmLimit?: number; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const terms = loadTerms(db);
  const scope = '(occupation_code IS NOT NULL OR multi_role = 1)';
  const rows = db
    .prepare(`SELECT id, title_raw, jd_text FROM job_posting WHERE ${scope} ${opts.all ? '' : 'AND skills_extracted_at IS NULL'}`)
    .all() as { id: string; title_raw: string; jd_text: string | null }[];
  const now = new Date().toISOString();
  const delAlias = db.prepare("DELETE FROM job_posting_skill WHERE posting_id = ? AND method = 'alias'");
  const ins = db.prepare(`INSERT INTO job_posting_skill (posting_id, skill_id, method, matched_text, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (posting_id, skill_id) DO UPDATE SET method = excluded.method, matched_text = excluded.matched_text, confidence = excluded.confidence, created_at = excluded.created_at`);
  const done = db.prepare('UPDATE job_posting SET skills_extracted_at = ? WHERE id = ?');
  let tagged = 0, tags = 0, noHit = 0;
  db.transaction(() => {
    for (const r of rows) {
      delAlias.run(r.id);
      const hits = matchTerms(`${r.title_raw}\n${r.jd_text ?? ''}`, terms);
      for (const [sid, term] of hits) ins.run(r.id, sid, 'alias', term, 0.8, now);
      if (hits.size) { tagged++; tags += hits.size; } else noHit++;
      done.run(now, r.id);
    }
  })();
  let llmTagged = 0, llmSent = 0, llmPending = 0;
  const pendingSql = `SELECT id, title_raw, jd_text FROM job_posting p WHERE ${scope} AND jd_text IS NOT NULL AND jd_text <> ''
      ${opts.all ? `AND NOT EXISTS (SELECT 1 FROM job_posting_skill k WHERE k.posting_id = p.id AND k.method = 'alias')` : 'AND NOT EXISTS (SELECT 1 FROM job_posting_skill k WHERE k.posting_id = p.id) AND llm_attempted_at IS NULL'} ORDER BY id`;
  const pending = db.prepare(pendingSql).all() as { id: string; title_raw: string; jd_text: string }[];
  llmPending = pending.length;
  if (opts.llm && pending.length) {
    const skills = db.prepare('SELECT id, name FROM skill ORDER BY id').all() as { id: string; name: string }[];
    const mark = db.prepare('UPDATE job_posting SET llm_attempted_at = ? WHERE id = ?');
    for (const r of pending.slice(0, opts.llmLimit ?? LLM_LIMIT)) {
      const out = await llmExtractSkills(opts.llm, r.title_raw, r.jd_text, skills);
      const at = new Date().toISOString();
      db.transaction(() => {
        for (const s of out) ins.run(r.id, s.skill_id, 'llm', s.quote, 0.5, at);
        mark.run(at, r.id);
      })();
      llmSent++;
      if (out.length) llmTagged++;
    }
  }
  log(`[jobs] skills: ${rows.length} postings scanned, ${tagged} tagged by terms (${tags} tags), ${noHit} without a term hit; ${llmPending} with zero skills pending LLM` +
    (opts.llm ? `, ${llmSent} sent to LLM, ${llmTagged} tagged by LLM` : ' (LLM fallback off: run with --llm)'));
  return { scanned: rows.length, tagged, tags, noHit, llmPending, llmSent, llmTagged };
}

/** max postings sent to the LLM per run (JOBS_LLM_LIMIT) */
export const LLM_LIMIT = Number(process.env.JOBS_LLM_LIMIT ?? 1000);
