import type { DatasetView, GroupView, LogLine, QueryResult, Run, Task } from '../../shared/types';

export type { DatasetView, GroupView, LogLine, QueryResult, Run, Task };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  groups: () => req<GroupView[]>('/api/groups'),
  runs: (params: Record<string, string> = {}) => req<Run[]>(`/api/runs?${new URLSearchParams(params)}`),
  run: (id: number) => req<Run>(`/api/runs/${id}`),
  start: (group: string, crawler: string | null, task: Task, args: string[] = []) =>
    req<Run>('/api/runs', { method: 'POST', body: JSON.stringify({ group, crawler, task, args }) }),
  stop: (id: number) => req<Run>(`/api/runs/${id}/stop`, { method: 'POST' }),
  datasets: () => req<DatasetView[]>('/api/datasets'),
  query: (group: string, params: URLSearchParams) => req<QueryResult>(`/api/datasets/${group}/items?${params}`),
  item: (group: string, id: string) => req<Record<string, unknown>>(`/api/datasets/${group}/items/${encodeURIComponent(id)}`),
};

export const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');

export function fmtDuration(run: Run): string {
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export const fmtCounts = (c: Record<string, number>) =>
  Object.entries(c)
    .map(([k, v]) => `${({ crawled: '抓取', cleaned: '清洗', ingested: '入库' } as Record<string, string>)[k] ?? k} ${v}`)
    .join(' · ') || '—';

export const TASK_LABEL: Record<Task, string> = { crawl: '爬取', clean: '清洗', ingest: '入库', pipeline: '全流程' };
