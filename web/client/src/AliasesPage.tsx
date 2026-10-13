import { useEffect, useMemo, useState } from 'react';

interface Alias { alias: string; skill_id: string; skill: string; skill_type: string; source: string; created_by: string | null; created_at: string | null; courses: number }
interface Skill { id: string; name: string; skill_type: string }

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`);
  return b as T;
}

/** #/aliases — expert-maintained alias → skill list; saving re-applies the deterministic alias tagging (no LLM). */
export function AliasesPage() {
  const [rows, setRows] = useState<Alias[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [alias, setAlias] = useState('');
  const [skill, setSkill] = useState('');
  const [filter, setFilter] = useState('');
  const [by, setBy] = useState(() => localStorage.getItem('reviewer') ?? '');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const load = () => j<{ aliases: Alias[]; skills: Skill[] }>('/api/aliases').then((r) => { setRows(r.aliases); setSkills(r.skills); }).catch((e: Error) => setErr(e.message));
  useEffect(() => { void load(); }, []);
  const shown = useMemo(() => rows.filter((r) => !filter || r.alias.includes(filter) || r.skill.includes(filter)), [rows, filter]);
  type Res = { types: number; tags: { inserted: number; deleted: number; updated: number }; core_name_retyped: number };
  const done = (r: Res) => setMsg(`已应用：别名标签 +${r.tags.inserted} −${r.tags.deleted}，核心课名重算 ${r.core_name_retyped} 条`);
  const need = () => { if (!by.trim()) { setErr('请先填写操作人'); return false; } localStorage.setItem('reviewer', by.trim()); setErr(''); return true; };
  const add = async () => {
    if (!need()) return;
    try { done(await j<Res>('/api/aliases', { method: 'POST', body: JSON.stringify({ alias, skill, by }) })); setAlias(''); await load(); } catch (e) { setErr((e as Error).message); }
  };
  const del = async (a: Alias) => {
    if (!need() || !confirm(`删除别名「${a.alias}」→ ${a.skill}？由它产生的未审核标签会一并删除。`)) return;
    try { done(await j<Res>(`/api/aliases/${encodeURIComponent(a.alias)}?by=${encodeURIComponent(by)}`, { method: 'DELETE' })); await load(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>技能别名</h2>
        <span className="muted small">课程名等于或包含别名 → 自动打该技能标签（专业知识：正文核心课 核心课名 0.8，否则 课名推断 0.5；工具：原文明确 1.0），保存即生效，不调用模型</span>
        <span className="spacer" />
        <a className="button ghost" href="/api/aliases/export.csv">导出 CSV（提交到 CAREER/seeds/skill_aliases.csv）</a>
      </div>
      <div className="filters">
        <label>操作人 <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="姓名" /></label>
        <label>别名 <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="如 代数与几何" /></label>
        <label>技能 <select value={skill} onChange={(e) => setSkill(e.target.value)}>
          <option value="">选择技能…</option>
          {skills.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.skill_type}）</option>)}
        </select></label>
        <button disabled={!alias.trim() || !skill} onClick={add}>添加</button>
        <span className="spacer" />
        <label>筛选 <input value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
      </div>
      {err && <div className="pad"><div className="error">{err}</div></div>}
      {msg && <div className="pad-x muted">{msg}</div>}
      <table className="table">
        <thead><tr><th>别名</th><th>技能</th><th>类型</th><th>来源</th><th>添加人 / 时间</th><th>命中课程</th><th></th></tr></thead>
        <tbody>
          {shown.map((a) => (
            <tr key={a.alias}>
              <td className="strong">{a.alias}</td><td>{a.skill} <span className="muted small mono">{a.skill_id}</span></td><td>{a.skill_type}</td>
              <td className="small">{a.source}</td><td className="small">{a.created_by ?? '—'} {a.created_at?.slice(0, 10) ?? ''}</td><td>{a.courses}</td>
              <td><button className="ghost" onClick={() => del(a)}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
