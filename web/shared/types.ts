/** Types shared by the web server and the React client. */

export type Task = 'crawl' | 'clean' | 'ingest' | 'pipeline';
export type RunStatus = 'running' | 'success' | 'failed' | 'stopped';

export interface Run {
  id: number;
  group: string;
  /** null = group-level run */
  crawler: string | null;
  task: Task;
  args: string[];
  command: string;
  status: RunStatus;
  exitCode: number | null;
  signal: string | null;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  /** parsed from logs: raw records crawled, cleaned, ingested… */
  counts: Record<string, number>;
  error: string | null;
}

export interface LogLine {
  /** ms since epoch */
  t: number;
  /** stdout / stderr / system message from the runner */
  s: 'out' | 'err' | 'sys';
  l: string;
}

export interface CrawlerView {
  group: string;
  name: string;
  hasClean: boolean;
  lastRun: Run | null;
  lastSuccessByTask: Partial<Record<Task, Run>>;
  running: Run | null;
}

export interface GroupView {
  name: string;
  hasIngest: boolean;
  hasDataset: boolean;
  crawlers: CrawlerView[];
  /** latest group-level run */
  lastRun: Run | null;
  running: Run | null;
}

export interface FilterView {
  key: string;
  label: string;
  type: 'select' | 'boolean';
  options: { value: string; label: string; count: number }[];
}

export interface DatasetView {
  group: string;
  title: string;
  description?: string;
  available: boolean;
  /** why it's unavailable (e.g. DB not ingested yet) */
  reason?: string;
  total: number;
  filters: FilterView[];
  listColumns: { column: string; label: string; format?: string }[];
  idColumn: string;
  titleColumn: string;
}

export interface QueryResult {
  total: number;
  page: number;
  pageSize: number;
  items: Record<string, unknown>[];
}
