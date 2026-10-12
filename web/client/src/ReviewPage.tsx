import { useEffect, useState } from 'react';

interface Group { school_id: string; school_name: string; major_code: string; major_name: string | null; total: number; pending: number; approved: number; rejected: number; edited: number }
interface Item {
  school_id: string; major_code: string; course_id: string; name: string; course_type: string | null; credits: number | null; hours: number | null;
  semester: string | null; source_page: number | null; snippet: string | null; source_url: string; model: string | null; confidence: number | null;
  review_status: string; reviewer: string | null; reviewed_at: string | null; review_note: string | null;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`);
  return b as T;
}

const STATUS: Record<string, string> = { pending: '待审', approved: '通过', rejected: '驳回', edited: '已改' };
const pdfLink = (url: string, page: number | null) => (page && /\.pdf|download/i.test(url) ? `${url}#page=${page}` : url);

/** #/review — spot-check LLM-extracted 专业核心课/主干课 per school + major. */
export function ReviewPage({ sel }: { sel?: string }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [err, setErr] = useState('');
  const [reviewer, setReviewer] = useState(() => localStorage.getItem('reviewer') ?? '');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Item>>({});
  const [school, major] = (sel ?? '').split('|');

  const loadGroups = () => j<Group[]>('/api/review/curriculum/groups').then(setGroups).catch((e: Error) => setErr(e.message));
  const loadItems = () =>
    school && major
      ? j<Item[]>(`/api/review/curriculum/items?${new URLSearchParams({ school_id: school, major_code: major })}`).then(setItems).catch((e: Error) => setErr(e.message))
      : setItems([]);
  useEffect(() => { void loadGroups(); }, []);
  useEffect(() => { void loadItems(); }, [sel]);

  const act = async (it: Item, action: 'approve' | 'reject' | 'edit') => {
    if (!reviewer.trim()) { setErr('请先填写审核人'); return; }
    localStorage.setItem('reviewer', reviewer.trim());
    setErr('');
    try {
      await j('/api/review/curriculum/action', {
        method: 'POST',
        body: JSON.stringify({
          school_id: it.school_id, major_code: it.major_code, course_id: it.course_id, action, reviewer,
          note: action === 'edit' ? draft.review_note : undefined,
          edits: action === 'edit' ? { name: draft.name, course_type: draft.course_type, credits: draft.credits === undefined ? it.credits : draft.credits, hours: draft.hours === undefined ? it.hours : draft.hours, semester: draft.semester === undefined ? it.semester : draft.semester } : undefined,
        }),
      });
      setEditing(null);
      await Promise.all([loadItems(), loadGroups()]);
    } catch (e) { setErr((e as Error).message); }
  };
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

  return (
    <div className="review">
      <h2>培养方案核心课 · 人工抽检</h2>
      <p className="muted small">LLM 抽取结果（extraction_method=llm, reviewed=0）。逐条对照原文片段与 PDF 页码：通过 / 驳回 / 修改。Mock 结果不会入库，这里只会出现真实模型的抽取。</p>
      <label>审核人 <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="姓名" /></label>
      {err && <div className="error">{err}</div>}
      <div className="review-layout" style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <aside style={{ minWidth: 260 }}>
          {!groups.length && <p className="muted">暂无待审数据：先在 CAREER/seeds/curriculum_sources.csv 填链接，配置 LLM_* 后运行 career:all。</p>}
          <ul className="plain">
            {groups.map((g) => {
              const key = `${g.school_id}|${g.major_code}`;
              return (
                <li key={key}>
                  <a href={`#/review/${encodeURIComponent(key)}`} className={key === sel ? 'active' : ''}>
                    {g.school_name} · {g.major_code} {g.major_name ?? ''}
                  </a>{' '}
                  <span className="muted small">待审 {g.pending}/{g.total}</span>
                </li>
              );
            })}
          </ul>
        </aside>
        <section style={{ flex: 1 }}>
          {items.length > 0 && (
            <table className="table">
              <thead><tr><th>课程</th><th>类型</th><th>学分</th><th>学时</th><th>学期</th><th>原文（页码）</th><th>置信度</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                {items.map((it) => editing === it.course_id ? (
                  <tr key={it.course_id}>
                    <td><input defaultValue={it.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></td>
                    <td><select defaultValue={it.course_type ?? '核心'} onChange={(e) => setDraft({ ...draft, course_type: e.target.value })}><option>核心</option><option>主干</option></select></td>
                    <td><input size={3} defaultValue={it.credits ?? ''} onChange={(e) => setDraft({ ...draft, credits: numOrNull(e.target.value) })} /></td>
                    <td><input size={3} defaultValue={it.hours ?? ''} onChange={(e) => setDraft({ ...draft, hours: numOrNull(e.target.value) })} /></td>
                    <td><input size={3} defaultValue={it.semester ?? ''} onChange={(e) => setDraft({ ...draft, semester: e.target.value || null })} /></td>
                    <td colSpan={2}><input placeholder="备注" onChange={(e) => setDraft({ ...draft, review_note: e.target.value })} /></td>
                    <td />
                    <td><button onClick={() => act(it, 'edit')}>保存</button> <button onClick={() => setEditing(null)}>取消</button></td>
                  </tr>
                ) : (
                  <tr key={it.course_id}>
                    <td>{it.name}</td>
                    <td>{it.course_type}</td>
                    <td>{it.credits ?? '—'}</td>
                    <td>{it.hours ?? '—'}</td>
                    <td>{it.semester ?? '—'}</td>
                    <td className="small">«{it.snippet}» <a href={pdfLink(it.source_url, it.source_page)} target="_blank" rel="noreferrer">p{it.source_page}</a></td>
                    <td>{it.confidence?.toFixed(2)} <span className="muted small">{it.model}</span></td>
                    <td>{STATUS[it.review_status] ?? it.review_status}{it.reviewer ? <span className="muted small"> · {it.reviewer}</span> : null}</td>
                    <td>
                      <button onClick={() => act(it, 'approve')}>通过</button> <button onClick={() => act(it, 'reject')}>驳回</button>{' '}
                      <button onClick={() => { setDraft({}); setEditing(it.course_id); }}>修改</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
