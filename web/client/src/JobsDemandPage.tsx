import { useEffect, useMemo, useState } from 'react';
import type { CompareRow, OccupationCompare } from '../../../JOBS/compare';

async function j<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`);
  return b as T;
}
const STATUS: Record<string, string> = { core: '核心', general: '一般', 未列入: '未列入' };
type Key = 'skill_name' | 'status' | 'postings' | 'freq_pct' | 'flag';
const COLS: [Key, string][] = [['skill_name', '技能'], ['status', '清单'], ['postings', '岗位数'], ['freq_pct', '占比'], ['flag', '标记']];

/** #/jobs/<occupation code> — 岗位技能需求: 职业技能清单 vs 招聘岗位里的技能出现频率 */
export function JobsDemandPage({ code }: { code?: string }) {
  const [all, setAll] = useState<OccupationCompare[]>([]);
  const [err, setErr] = useState('');
  const [sort, setSort] = useState<{ k: Key; desc: boolean }>({ k: 'freq_pct', desc: true });
  const [onlyFlags, setOnlyFlags] = useState(false);
  useEffect(() => { j<OccupationCompare[]>('/api/jobs/compare').then(setAll).catch((e: Error) => setErr(e.message)); }, []);
  const occ = all.find((o) => o.occupation_code === code) ?? null;
  const rows = useMemo(() => {
    const r = (occ?.rows ?? []).filter((x) => !onlyFlags || x.flag);
    const v = (x: CompareRow) => x[sort.k];
    return [...r].sort((a, b) => { const A = v(a), B = v(b); const c = typeof A === 'number' ? A - (B as number) : String(A).localeCompare(String(B), 'zh'); return sort.desc ? -c : c; });
  }, [occ, sort, onlyFlags]);
  const click = (k: Key) => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k === 'freq_pct' || k === 'postings' }));

  return (
    <div className="card">
      <div className="card-head">
        <h2>岗位技能需求</h2>
        <select value={code ?? ''} onChange={(e) => { location.hash = `#/jobs/${encodeURIComponent(e.target.value)}`; }}>
          <option value="">选择职业…</option>
          {all.map((o) => <option key={o.occupation_code} value={o.occupation_code}>{o.occupation_code} {o.occupation_name}（样本 {o.eligible}，标记 {o.rows.filter((r) => r.flag).length}）</option>)}
        </select>
        <label className="small"><input type="checkbox" checked={onlyFlags} onChange={(e) => setOnlyFlags(e.target.checked)} /> 只看标记</label>
        <span className="spacer" />
        <span className="muted small">占比 = 提到该技能的岗位 / 该职业已归类且描述不过短的岗位（全部年份）。清单来自 occupation_skills.csv；未列入且占比 ≥ {all[0]?.gap_high ?? 20}% 标「高频未列入」，核心且占比 &lt; {all[0]?.core_low ?? 5}% 标「核心低频」（阈值 JOBS_GAP_HIGH / JOBS_CORE_LOW）。</span>
      </div>
      {err && <div className="pad"><div className="error">{err}</div></div>}
      {occ && (
        <div className="pad-x">
          <p className="small">样本：<b>{occ.eligible}</b> 条，发布时间 {occ.sample_from ?? '—'} ~ {occ.sample_to ?? '—'}；描述过短未计入 {occ.too_short} 条。来源：中国石油大学（华东）就业网校招岗位。</p>
          <table className="table">
            <thead><tr>{COLS.map(([k, l]) => <th key={k} className="sortable" onClick={() => click(k)}>{l}{sort.k === k ? (sort.desc ? ' ↓' : ' ↑') : ''}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.skill_id} className={r.flag ? 'flag-row' : ''}>
                  <td title={r.skill_id}>{r.skill_name}</td>
                  <td>{STATUS[r.status]}</td>
                  <td>{r.postings}/{r.eligible}</td>
                  <td>{r.freq_pct}%</td>
                  <td>{r.flag && <span className="flag-warn">{r.flag}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!code && !err && <p className="pad muted">选择一个职业查看对照表。</p>}
    </div>
  );
}
