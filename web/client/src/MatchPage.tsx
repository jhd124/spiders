import { Fragment, useEffect, useState } from 'react';
import type { MajorMatch, OccupationListItem, OccupationMatch } from '../../../CAREER/match';

async function j<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`);
  return b as T;
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
const IMP: Record<string, string> = { core: '核心', general: '一般' };

/** #/match/<occupation code> — 职业 → 技能 → 专业/课程 → 学校 */
export function MatchPage({ code }: { code?: string }) {
  const [occs, setOccs] = useState<OccupationListItem[]>([]);
  const [data, setData] = useState<OccupationMatch | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { j<OccupationListItem[]>('/api/match/occupations').then(setOccs).catch((e: Error) => setErr(e.message)); }, []);
  useEffect(() => {
    setData(null); setOpen(null); setErr('');
    if (code) j<OccupationMatch>(`/api/match/occupation/${encodeURIComponent(code)}`).then(setData).catch((e: Error) => setErr(e.message));
  }, [code]);

  return (
    <div>
      <div className="card">
        <div className="card-head">
          <h2>职业 → 技能 → 专业/课程 → 学校</h2>
          <select value={code ?? ''} onChange={(e) => { location.hash = `#/match/${encodeURIComponent(e.target.value)}`; }}>
            <option value="">选择职业…</option>
            {occs.map((o) => <option key={o.code} value={o.code}>{o.code} {o.name}（{o.skills} 项技能{o.example ? '，示例' : ''}）</option>)}
          </select>
          <span className="spacer" />
          <span className="muted small">排序：先按核心技能得分 Σ 1.0 × 该专业必修/限选课程对该技能的最高依据权重(原文明确1.0/核心课名0.8/课名推断0.5)，一般技能(0.5，含任选课)仅作并列时的次序；核心技能仅由任选课覆盖的列为“可选修获得”，不计核心分；待复核标签不计分</span>
        </div>
        {err && <div className="pad"><div className="error">{err}</div></div>}
        {!occs.length && !err && <p className="pad muted">还没有职业技能映射：在 CAREER/seeds/occupation_skills.csv 中填写后重启服务或运行 career:ingest。</p>}
        {data?.example_data && (
          <div className="error" style={{ margin: 16, background: '#fff4d6', color: '#8a6100', borderColor: '#f0d58a' }}>
            ⚠ 示例数据：该职业的技能要求来自占位示例（source=example），未经专家确认，排名仅用于演示页面。
          </div>
        )}
        {data && (
          <div className="pad-x">
            <div className="chips">
              {data.skills.map((s) => <span key={s.skill_id} className="chip" title={s.note ?? ''}>{s.skill} · {IMP[s.importance]}{s.verified_by ? ` ✓${s.verified_by}` : ''}</span>)}
            </div>
          </div>
        )}
      </div>
      {data && (
        <div className="card">
          <table className="table">
            <thead><tr><th>#</th><th>学校</th><th>专业</th><th>核心得分</th><th>一般得分</th><th>覆盖</th><th>已覆盖技能</th><th>可选修获得</th><th>缺失技能</th><th>待复核</th></tr></thead>
            <tbody>
              {data.majors.map((m, i) => {
                const key = `${m.school_id}|${m.major_code}`;
                return (
                  <Fragment key={key}>
                    <tr className={`clickable${open === key ? ' selected' : ''}`} onClick={() => setOpen(open === key ? null : key)}>
                      <td>{i + 1}</td><td>{m.school}</td><td>{m.major_code} {m.major ?? ''}</td>
                      <td className="strong">{m.core_score}</td><td>{m.general_score}</td>
                      <td>{pct(m.coverage_pct)}</td>
                      <td className="small">{m.covered.join('、') || '—'}</td>
                      <td className="small" style={{ color: '#8a6100' }}>{m.elective_only.join('、') || '—'}</td>
                      <td className="small err">{m.missing.join('、') || '—'}</td>
                      <td>{m.flagged || ''}</td>
                    </tr>
                    {open === key && <tr><td colSpan={10}><Detail m={m} /></td></tr>}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!data.majors.length && <p className="pad muted">暂无专业数据。</p>}
        </div>
      )}
    </div>
  );
}

function Detail({ m }: { m: MajorMatch }) {
  return (
    <table className="table">
      <thead><tr><th>技能</th><th>重要度</th><th>最高权重</th><th>课程</th><th>依据类型</th><th>原文依据</th></tr></thead>
      <tbody>
        {m.skills.map((s) => (s.courses.length ? s.courses : [null]).map((c, k) => (
          <tr key={`${s.skill_id}-${k}`} style={c?.needs_review ? { opacity: 0.6 } : undefined}>
            {k === 0 && <><td rowSpan={Math.max(1, s.courses.length)} className={s.covered ? 'strong' : 'err'}>{s.skill}</td>
              <td rowSpan={Math.max(1, s.courses.length)}>{IMP[s.importance]}</td><td rowSpan={Math.max(1, s.courses.length)}>{(s.importance === 'core' ? s.best_required : s.best) || '—'}{s.elective_only && <span className="badge stopped" style={{ marginLeft: 4 }}>可选修获得</span>}</td></>}
            {c ? <>
              <td>{c.course}{c.is_core && <span className="badge success" style={{ marginLeft: 4 }}>核心课</span>}{c.course_type && <span className="muted small"> {c.course_type}</span>}</td>
              <td>{c.evidence_type ?? '—'} <span className="muted small">{c.weight}</span>{c.needs_review && <span className="badge stopped" title={c.review_reason ?? ''} style={{ marginLeft: 4 }}>待复核·不计分</span>}</td>
              <td className="small">{c.quote ?? '—'}</td>
            </> : <td colSpan={3} className="muted">没有课程标注该技能</td>}
          </tr>
        )))}
      </tbody>
    </table>
  );
}
