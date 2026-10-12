import { useEffect, useMemo, useState } from 'react';
import { api, type DatasetView, type QueryResult } from './api';

const PAGE_SIZE = 20;

function Cell({ v, format }: { v: unknown; format?: string }) {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  if (format === 'link' && typeof v === 'string')
    return <a href={v} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>打开 ↗</a>;
  if (format === 'boolean') return <>{v === 1 || v === true ? '✓' : v === 0 || v === false ? '✗' : '—'}</>;
  if (Array.isArray(v)) {
    const s = v.join(', ');
    return <span title={s}>{s.length > 60 ? s.slice(0, 60) + '…' : s || '—'}</span>;
  }
  return <>{String(v)}</>;
}

function Value({ v }: { v: unknown }) {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  if (Array.isArray(v)) return v.length ? <div className="chips">{v.map((x, i) => <span key={i} className="chip">{String(x)}</span>)}</div> : <span className="muted">—</span>;
  if (typeof v === 'string' && /^https?:\/\//.test(v)) return <a href={v} target="_blank" rel="noreferrer">{v}</a>;
  if (typeof v === 'object') return <code>{JSON.stringify(v)}</code>;
  return <>{String(v)}</>;
}

/** Generic dataset browser: every group that exports <GROUP>/dataset.ts shows up here. */
export function DataPage({ group }: { group?: string }) {
  const [datasets, setDatasets] = useState<DatasetView[]>([]);
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [topic, setTopic] = useState('');
  const [page, setPage] = useState(1);
  const [res, setRes] = useState<QueryResult | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.datasets().then(setDatasets, (e) => setErr(String(e.message ?? e)));
  }, []);
  const ds = datasets.find((d) => d.group === group) ?? datasets[0];

  useEffect(() => {
    setFilters({});
    setTopic('');
    setQ('');
    setQInput('');
    setPage(1);
    setDetail(null);
  }, [ds?.group]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) p.set('q', q);
    if (topic) p.set('topic', topic);
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return p;
  }, [q, topic, filters, page]);

  useEffect(() => {
    if (!ds?.available) return;
    api.query(ds.group, params).then(setRes, (e) => setErr(String(e.message ?? e)));
  }, [ds?.group, ds?.available, params]);

  if (!datasets.length) return <p className="muted">{err ?? '加载中…'}</p>;
  if (!ds) return <p className="muted">没有可查询的数据集（在分组目录里添加 dataset.ts）</p>;

  const pages = res ? Math.max(1, Math.ceil(res.total / res.pageSize)) : 1;
  const openDetail = async (row: Record<string, unknown>) => {
    try {
      setDetail(await api.item(ds.group, String(row[ds.idColumn])));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="data-layout">
      <div className="data-main">
        {datasets.length > 1 && (
          <div className="tabs">
            {datasets.map((d) => (
              <a key={d.group} href={`#/data/${d.group}`} className={d.group === ds.group ? 'active' : ''}>{d.title}</a>
            ))}
          </div>
        )}
        <section className="card">
          <div className="card-head">
            <h2>{ds.title}</h2>
            <span className="muted small">{ds.description}</span>
            <div className="spacer" />
            <span className="muted">共 {ds.total} 条</span>
          </div>
          {!ds.available ? (
            <p className="pad muted">{ds.reason}</p>
          ) : (
            <>
              <form
                className="filters"
                onSubmit={(e) => {
                  e.preventDefault();
                  setPage(1);
                  setQ(qInput.trim());
                }}
              >
                <input
                  className="search"
                  placeholder='关键词（整词匹配）："machine learning" 短语，learn* 前缀，OR'
                  title='整词匹配，多个词=同时包含；"双引号"=短语；词尾 *=前缀；OR=或；全大写缩写（如 AI）区分大小写'
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                />
                {ds.topics.length > 0 && (
                  <label>
                    主题
                    <select
                      value={topic}
                      onChange={(e) => {
                        setPage(1);
                        setTopic(e.target.value);
                      }}
                    >
                      <option value="">全部</option>
                      {ds.topics.map((t) => (
                        <option key={t.key} value={t.key}>{t.label} ({t.count})</option>
                      ))}
                    </select>
                  </label>
                )}
                {ds.filters.map((f) => (
                  <label key={f.key}>
                    {f.label}
                    <select
                      value={filters[f.key] ?? ''}
                      onChange={(e) => {
                        setPage(1);
                        setFilters({ ...filters, [f.key]: e.target.value });
                      }}
                    >
                      <option value="">全部</option>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
                      ))}
                      {f.type === 'boolean' && <option value="null">未知</option>}
                    </select>
                  </label>
                ))}
                <button type="submit">搜索</button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setQ('');
                    setQInput('');
                    setFilters({});
                    setTopic('');
                    setPage(1);
                  }}
                >重置</button>
              </form>
              <div className="muted small pad-x">匹配 {res?.total ?? 0} 条 · 第 {page}/{pages} 页</div>
              <table className="table">
                <thead><tr>{ds.listColumns.map((c) => <th key={c.column}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {res?.items.map((row) => (
                    <tr
                      key={String(row[ds.idColumn])}
                      className={`clickable ${detail && detail[ds.idColumn] === row[ds.idColumn] ? 'selected' : ''}`}
                      onClick={() => openDetail(row)}
                    >
                      {ds.listColumns.map((c) => (
                        <td key={c.column} className={c.column === ds.titleColumn ? 'strong' : ''}><Cell v={row[c.column]} format={c.format} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="pager">
                <button disabled={page <= 1} onClick={() => setPage(1)}>«</button>
                <button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
                <span>{page} / {pages}</span>
                <button disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
                <button disabled={page >= pages} onClick={() => setPage(pages)}>»</button>
              </div>
            </>
          )}
        </section>
      </div>
      {detail && (
        <aside className="card detail">
          <div className="card-head">
            <h2>{String(detail[ds.titleColumn] ?? detail[ds.idColumn])}</h2>
            <div className="spacer" />
            <button className="ghost" onClick={() => setDetail(null)}>关闭</button>
          </div>
          <dl className="meta">
            {Object.entries(detail).map(([k, v]) => (
              <div key={k} className="row"><dt>{k}</dt><dd><Value v={v} /></dd></div>
            ))}
          </dl>
        </aside>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  );
}
