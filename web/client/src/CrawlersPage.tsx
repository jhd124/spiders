import { useCallback, useEffect, useState } from 'react';
import { api, fmtCounts, fmtDuration, fmtTime, TASK_LABEL, type GroupView, type Run, type Task } from './api';
import { StatusBadge } from './StatusBadge';

export function CrawlersPage() {
  const [groups, setGroups] = useState<GroupView[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [flags, setFlags] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const [g, r] = await Promise.all([api.groups(), api.runs({ limit: '30' })]);
      setGroups(g);
      setRuns(r);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const start = async (group: string, crawler: string | null, task: Task) => {
    setErr(null);
    try {
      const args = (task === 'crawl' || task === 'pipeline') && flags[group] ? ['--no-details'] : [];
      const run = await api.start(group, crawler, task, args);
      location.hash = `#/runs/${run.id}`;
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };
  const stop = async (id: number) => {
    try {
      await api.stop(id);
      void refresh();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div>
      {err && <div className="error">{err}</div>}
      {groups.map((g) => (
        <section key={g.name} className="card">
          <div className="card-head">
            <h2>{g.name}</h2>
            <span className="muted">{g.crawlers.length} 个爬虫</span>
            <div className="spacer" />
            <label className="check">
              <input
                type="checkbox"
                checked={!!flags[g.name]}
                onChange={(e) => setFlags({ ...flags, [g.name]: e.target.checked })}
              />
              --no-details（跳过详情页，快）
            </label>
            {g.running ? (
              <>
                <a href={`#/runs/${g.running.id}`}>
                  <StatusBadge status="running" /> 分组任务 #{g.running.id}
                </a>
                <button className="danger" onClick={() => stop(g.running!.id)}>停止</button>
              </>
            ) : (
              <>
                <button onClick={() => start(g.name, null, 'pipeline')}>全部运行（crawl→clean→ingest）</button>
                {g.hasIngest && <button onClick={() => start(g.name, null, 'ingest')}>整组入库</button>}
              </>
            )}
            {g.hasDataset && <a className="button ghost" href={`#/data/${g.name}`}>查数据 →</a>}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>爬虫</th>
                <th>状态</th>
                <th>最近一次</th>
                <th>耗时</th>
                <th>记录数</th>
                <th>上次成功爬取</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {g.crawlers.map((c) => {
                const last = c.running ?? c.lastRun;
                const busy = !!c.running || !!g.running;
                return (
                  <tr key={c.name}>
                    <td className="mono strong">{c.name}</td>
                    <td><StatusBadge status={last?.status} /></td>
                    <td>
                      {last ? (
                        <a href={`#/runs/${last.id}`}>
                          #{last.id} {TASK_LABEL[last.task]} · {fmtTime(last.startedAt)}
                        </a>
                      ) : '—'}
                    </td>
                    <td>{last ? fmtDuration(last) : '—'}</td>
                    <td className="small">{last ? fmtCounts(last.counts) : '—'}</td>
                    <td className="small">
                      {c.lastSuccessByTask.crawl ? `${fmtTime(c.lastSuccessByTask.crawl.endedAt)} · ${fmtCounts(c.lastSuccessByTask.crawl.counts)}` : '—'}
                    </td>
                    <td className="actions">
                      {c.running ? (
                        <button className="danger" onClick={() => stop(c.running!.id)}>停止</button>
                      ) : (
                        <>
                          <button disabled={busy} onClick={() => start(g.name, c.name, 'crawl')}>爬取</button>
                          <button disabled={busy || !c.hasClean} onClick={() => start(g.name, c.name, 'clean')}>清洗</button>
                          <button disabled={busy || !g.hasIngest} onClick={() => start(g.name, c.name, 'ingest')}>入库</button>
                          <button disabled={busy} className="ghost" onClick={() => start(g.name, c.name, 'pipeline')}>全流程</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      <section className="card">
        <div className="card-head"><h2>运行历史</h2><span className="muted">最近 30 次</span></div>
        <RunsTable runs={runs} />
      </section>
    </div>
  );
}

export function RunsTable({ runs }: { runs: Run[] }) {
  if (!runs.length) return <p className="muted pad">还没有运行记录</p>;
  return (
    <table className="table">
      <thead>
        <tr><th>#</th><th>目标</th><th>任务</th><th>状态</th><th>开始</th><th>结束</th><th>耗时</th><th>退出码</th><th>记录数</th></tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className="clickable" onClick={() => (location.hash = `#/runs/${r.id}`)}>
            <td>{r.id}</td>
            <td className="mono">{r.group}{r.crawler ? `/${r.crawler}` : ' (整组)'}</td>
            <td>{TASK_LABEL[r.task]}{r.args.length ? <span className="muted small"> {r.args.join(' ')}</span> : null}</td>
            <td><StatusBadge status={r.status} /></td>
            <td>{fmtTime(r.startedAt)}</td>
            <td>{fmtTime(r.endedAt)}</td>
            <td>{fmtDuration(r)}</td>
            <td>{r.exitCode ?? '—'}</td>
            <td className="small">{fmtCounts(r.counts)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
