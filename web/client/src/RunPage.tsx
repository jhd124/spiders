import { useEffect, useRef, useState } from 'react';
import { api, fmtCounts, fmtDuration, fmtTime, TASK_LABEL, type LogLine, type Run } from './api';
import { StatusBadge } from './StatusBadge';

/** Run detail + live log over SSE (/api/runs/:id/stream). Works for finished runs too (replay only). */
export function RunPage({ id }: { id: number }) {
  const [run, setRun] = useState<Run | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [live, setLive] = useState(false);
  const [follow, setFollow] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLines([]);
    setRun(null);
    api.run(id).then(setRun, (e) => setErr(String(e.message ?? e)));
    const es = new EventSource(`/api/runs/${id}/stream`);
    es.addEventListener('open', () => setLive(true));
    es.addEventListener('replay', (e) => setLines(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('log', (e) => setLines((prev) => [...prev, JSON.parse((e as MessageEvent).data)]));
    es.addEventListener('end', (e) => {
      setRun(JSON.parse((e as MessageEvent).data));
      setLive(false);
      es.close();
    });
    es.onerror = () => setLive(false);
    // refresh counts / duration while running
    const t = setInterval(() => api.run(id).then(setRun).catch(() => {}), 2000);
    return () => {
      es.close();
      clearInterval(t);
    };
  }, [id]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  const stop = async () => {
    try {
      setRun(await api.stop(id));
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div>
      <p><a href="#/crawlers">← 返回爬虫列表</a></p>
      {err && <div className="error">{err}</div>}
      {run && (
        <section className="card">
          <div className="card-head">
            <h2>
              运行 #{run.id} · <span className="mono">{run.group}{run.crawler ? `/${run.crawler}` : ' (整组)'}</span> · {TASK_LABEL[run.task]}
            </h2>
            <StatusBadge status={run.status} />
            <div className="spacer" />
            {run.status === 'running' && <button className="danger" onClick={stop}>停止</button>}
            <a className="button ghost" href={`/api/runs/${run.id}/log?format=text`} target="_blank" rel="noreferrer">下载日志</a>
          </div>
          <dl className="meta">
            <dt>命令</dt><dd className="mono small">{run.command}</dd>
            <dt>开始</dt><dd>{fmtTime(run.startedAt)}</dd>
            <dt>结束</dt><dd>{fmtTime(run.endedAt)}</dd>
            <dt>耗时</dt><dd>{fmtDuration(run)}</dd>
            <dt>退出码</dt><dd>{run.exitCode ?? '—'}{run.signal ? ` (${run.signal})` : ''}</dd>
            <dt>记录数</dt><dd>{fmtCounts(run.counts)}</dd>
            <dt>PID</dt><dd>{run.pid ?? '—'}</dd>
            {run.error && (<><dt>错误</dt><dd className="err">{run.error}</dd></>)}
          </dl>
        </section>
      )}
      <section className="card">
        <div className="card-head">
          <h2>日志</h2>
          <span className={`dot ${live ? 'on' : ''}`} /> <span className="muted small">{live ? '实时' : '已结束 / 未连接'}</span>
          <span className="muted small">{lines.length} 行</span>
          <div className="spacer" />
          <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 自动滚动</label>
        </div>
        <pre className="log" ref={box}>
          {lines.map((l, i) => (
            <div key={i} className={`ln ${l.s}`}>
              <span className="ts">{new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              {l.l}
            </div>
          ))}
        </pre>
      </section>
    </div>
  );
}
