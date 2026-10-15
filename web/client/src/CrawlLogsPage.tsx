import { useEffect, useState } from 'react';

/** #/crawl-logs and #/crawl-logs/<run id>: every crawler run (CLI, cron, console) logged by lib/crawllog.ts. */
interface RunRow { id: string; crawler: string; web_run_id: number | null; started_at: string; ended_at: string | null; duration_ms: number | null; status: string;
  requests: number; request_errors: number; pages: number; bytes: number; records: number; new_records: number; updated: number; duplicate: number; skipped: number; failures: number; error: string | null }
interface Summary { id: string; crawler: string; web_run_id: number | null; started_at: string; ended_at: string | null; duration_ms: number | null; status: string;
  requests: number; request_errors: number; retries: number; pages: number; bytes: number; records: number; outcomes: Record<string, number>; records_saved: number; records_truncated: boolean;
  failures: { seq: number; at: string; reason: string; context?: Record<string, unknown> }[]; error: string | null; dir: string; extra: Record<string, unknown> }
interface Req { seq: number; at: string; method: string; url: string; keyword: string | null; page: number | null; status: number | null; bytes: number | null; elapsed_ms: number; attempt: number; error: string | null }

async function j<T>(p: string): Promise<T> {
  const r = await fetch(p);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`);
  return b as T;
}
const t = (s: string | null) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—');
const dur = (ms: number | null) => (ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`);
const kb = (b: number | null) => (b == null ? '—' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const badge = (s: string) => <span className={`badge ${s === 'partial' ? 'stopped' : s}`}>{s}</span>;

export function CrawlLogsPage({ id }: { id?: string }) {
  return id ? <RunDetail id={id} /> : <RunList />;
}

function RunList() {
  const [crawler, setCrawler] = useState('');
  const [d, setD] = useState<{ crawlers: { crawler: string; runs: number; last: string }[]; runs: RunRow[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { j<typeof d>(`/api/crawl-runs?crawler=${encodeURIComponent(crawler)}`).then(setD, (e: Error) => setErr(e.message)); }, [crawler]);
  return (
    <div className="card">
      <div className="card-head"><h2>爬虫运行日志</h2><span className="muted small">每次抓取（命令行、定时任务或控制台）都会记录：请求、抓到的数据、失败原因</span></div>
      {err && <div className="error">{err}</div>}
      {d && (
        <>
          <div className="filters">
            <label>爬虫 <select value={crawler} onChange={(e) => setCrawler(e.target.value)}>
              <option value="">全部</option>{d.crawlers.map((c) => <option key={c.crawler} value={c.crawler}>{c.crawler}（{c.runs}）</option>)}
            </select></label>
          </div>
          <table className="table">
            <thead><tr><th>开始</th><th>爬虫</th><th>状态</th><th>耗时</th><th>请求（错误）</th><th>数据量</th><th>记录</th><th>新增 / 更新 / 重复 / 跳过</th><th>失败</th></tr></thead>
            <tbody>{d.runs.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => { location.hash = `#/crawl-logs/${encodeURIComponent(r.id)}`; }}>
                <td>{t(r.started_at)}</td><td>{r.crawler}{r.web_run_id ? <span className="muted small"> · 控制台 #{r.web_run_id}</span> : null}</td><td>{badge(r.status)}</td><td>{dur(r.duration_ms)}</td>
                <td>{r.requests}{r.request_errors ? <span className="err">（{r.request_errors}）</span> : null}</td><td>{kb(r.bytes)}</td><td>{r.records}</td>
                <td>{r.new_records} / {r.updated} / {r.duplicate} / {r.skipped}</td><td className={r.failures ? 'err' : ''}>{r.failures}</td>
              </tr>))}
              {!d.runs.length && <tr><td colSpan={9} className="muted">还没有运行记录</td></tr>}
            </tbody>
          </table>
        </>)}
    </div>
  );
}

function RunDetail({ id }: { id: string }) {
  const [s, setS] = useState<Summary | null>(null);
  const [reqs, setReqs] = useState<{ total: number; rows: Req[] } | null>(null);
  const [onlyErr, setOnlyErr] = useState(false);
  const [rOff, setROff] = useState(0);
  const [recs, setRecs] = useState<{ total: number; rows: Record<string, unknown>[]; pruned: boolean } | null>(null);
  const [outcome, setOutcome] = useState('');
  const [recOff, setRecOff] = useState(0);
  const [err, setErr] = useState('');
  const base = `/api/crawl-runs/${encodeURIComponent(id)}`;
  useEffect(() => { j<Summary>(base).then(setS, (e: Error) => setErr(e.message)); }, [id]);
  useEffect(() => { j<typeof reqs>(`${base}/requests?limit=100&offset=${rOff}${onlyErr ? '&errors=1' : ''}`).then(setReqs, (e: Error) => setErr(e.message)); }, [id, rOff, onlyErr]);
  useEffect(() => { j<typeof recs>(`${base}/records?limit=20&offset=${recOff}${outcome ? `&outcome=${outcome}` : ''}`).then(setRecs, (e: Error) => setErr(e.message)); }, [id, recOff, outcome]);
  return (
    <>
      <p><a href="#/crawl-logs">‹ 全部运行</a></p>
      {err && <div className="error">{err}</div>}
      {s && (
        <div className="card">
          <div className="card-head"><h2>{s.crawler}</h2>{badge(s.status)}<span className="muted small mono">{s.id}</span></div>
          <dl className="meta">
            <div className="row"><dt>时间</dt><dd>{t(s.started_at)} → {t(s.ended_at)}（{dur(s.duration_ms)}）{s.web_run_id ? ` · 控制台运行 #${s.web_run_id}` : ''}</dd></div>
            <div className="row"><dt>请求</dt><dd>{s.requests} 次，成功页面 {s.pages}，错误 {s.request_errors}，重试 {s.retries}，下载 {kb(s.bytes)}</dd></div>
            <div className="row"><dt>记录</dt><dd>{s.records} 条：新增 {s.outcomes.new}，更新 {s.outcomes.updated}，重复 {s.outcomes.duplicate}，跳过 {s.outcomes.skipped}，其他抓取 {s.outcomes.fetched}
              {s.records_truncated ? `（快照只保存了前 ${s.records_saved} 条）` : ''}</dd></div>
            {Object.keys(s.extra).length > 0 && <div className="row"><dt>其他</dt><dd className="mono small">{JSON.stringify(s.extra)}</dd></div>}
            {s.error && <div className="row"><dt>错误</dt><dd className="err">{s.error}</dd></div>}
            <div className="row"><dt>文件</dt><dd className="mono small">{s.dir}</dd></div>
          </dl>
          {s.failures.length > 0 && (
            <>
              <div className="pad-x strong">失败（{s.failures.length}）</div>
              <table className="table"><thead><tr><th>#</th><th>时间</th><th>原因</th><th>上下文</th></tr></thead>
                <tbody>{s.failures.map((f) => <tr key={f.seq}><td>{f.seq}</td><td>{t(f.at)}</td><td className="err">{f.reason}</td><td className="mono small">{JSON.stringify(f.context ?? {})}</td></tr>)}</tbody></table>
            </>)}
        </div>)}
      <div className="card">
        <div className="card-head"><h2>请求日志</h2><span className="muted small">{reqs?.total ?? 0} 条</span>
          <label className="check"><input type="checkbox" checked={onlyErr} onChange={(e) => { setOnlyErr(e.target.checked); setROff(0); }} />只看错误</label><span className="spacer" />
          <button disabled={rOff === 0} onClick={() => setROff(Math.max(0, rOff - 100))}>上一页</button><button disabled={!reqs || rOff + 100 >= reqs.total} onClick={() => setROff(rOff + 100)}>下一页</button></div>
        <table className="table"><thead><tr><th>#</th><th>时间</th><th>请求</th><th>关键词 / 页</th><th>HTTP</th><th>大小</th><th>耗时</th><th>重试</th><th>错误</th></tr></thead>
          <tbody>{reqs?.rows.map((r) => (
            <tr key={r.seq}><td>{r.seq}</td><td className="small">{t(r.at)}</td><td className="mono small" style={{ wordBreak: 'break-all' }}>{r.method} {r.url}</td>
              <td>{r.keyword ?? ''}{r.page != null ? ` · p${r.page}` : ''}</td><td className={r.status && r.status < 400 ? '' : 'err'}>{r.status ?? '—'}</td><td>{kb(r.bytes)}</td><td>{r.elapsed_ms} ms</td>
              <td>{r.attempt || ''}</td><td className="err small">{r.error ?? ''}</td></tr>))}</tbody></table>
      </div>
      <div className="card">
        <div className="card-head"><h2>抓到的数据</h2><span className="muted small">{recs?.pruned ? '快照文件已按保留策略清理' : `${recs?.total ?? 0} 条（快照）`}</span>
          <label className="check">结果 <select value={outcome} onChange={(e) => { setOutcome(e.target.value); setRecOff(0); }}>
            <option value="">全部</option><option value="new">新增</option><option value="updated">更新</option><option value="duplicate">重复</option><option value="skipped">跳过</option><option value="fetched">抓取</option></select></label>
          <span className="spacer" />
          <button disabled={recOff === 0} onClick={() => setRecOff(Math.max(0, recOff - 20))}>上一页</button><button disabled={!recs || recOff + 20 >= recs.total} onClick={() => setRecOff(recOff + 20)}>下一页</button></div>
        {recs?.rows.map((r, i) => (
          <details key={i} className="pad-x"><summary className="small"><b>{String(r.outcome)}</b> #{String(r.n)} {r.key ? <span className="mono">{String(r.key)}</span> : null} {r.keyword ? `· ${String(r.keyword)}` : ''} {r.source ? `· ${String(r.source)}` : ''}</summary>
            <pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(r.data, null, 2)}</pre></details>))}
      </div>
    </>
  );
}
