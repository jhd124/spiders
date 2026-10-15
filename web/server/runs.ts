/**
 * Run manager: spawns crawler / clean / ingest / pipeline child processes,
 * persists run history in SQLite (data/web.db) and logs as JSONL (data/logs/<id>.jsonl),
 * and fans out live log lines to SSE subscribers.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DATA_DIR, ROOT } from '../../lib/io.js';
import { discoverGroups, type GroupInfo } from '../../lib/discovery.js';
import type { LogLine, Run, RunStatus, Task } from '../shared/types.js';

export const LOG_DIR = join(DATA_DIR, 'logs');
const ARG_RE = /^--[a-z0-9][a-z0-9-]*(=[\w.,:/@-]*)?$/i;

interface RunRow {
  id: number;
  grp: string;
  crawler: string | null;
  task: Task;
  args: string;
  command: string;
  status: RunStatus;
  exit_code: number | null;
  signal: string | null;
  pid: number | null;
  started_at: string;
  ended_at: string | null;
  counts: string | null;
  error: string | null;
}

const toRun = (r: RunRow): Run => ({
  id: r.id,
  group: r.grp,
  crawler: r.crawler,
  task: r.task,
  args: JSON.parse(r.args),
  command: r.command,
  status: r.status,
  exitCode: r.exit_code,
  signal: r.signal,
  pid: r.pid,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  counts: r.counts ? JSON.parse(r.counts) : {},
  error: r.error,
});

/** Pull record counts out of the crawler / clean / ingest log conventions used in this repo. */
export function parseCounts(line: string, counts: Record<string, number>): boolean {
  let m: RegExpExecArray | null;
  if ((m = /^\[[^\]]+\] [^:]+: (\d+) records\b/.exec(line))) counts.crawled = (counts.crawled ?? 0) + Number(m[1]);
  else if ((m = /\bclean: (\d+)\b/.exec(line))) counts.cleaned = (counts.cleaned ?? 0) + Number(m[1]);
  else if ((m = /\bupserted (\d+)\b/.exec(line))) counts.ingested = (counts.ingested ?? 0) + Number(m[1]);
  else return false;
  return true;
}

interface Active {
  child: ChildProcess;
  log: WriteStream;
  counts: Record<string, number>;
  stopRequested: boolean;
}

export class RunManager {
  private db: Database.Database;
  private active = new Map<number, Active>();
  readonly events = new EventEmitter();

  constructor(dbPath = join(DATA_DIR, 'web.db')) {
    mkdirSync(DATA_DIR, { recursive: true });
    mkdirSync(LOG_DIR, { recursive: true });
    this.events.setMaxListeners(0);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grp TEXT NOT NULL,
      crawler TEXT,
      task TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      command TEXT NOT NULL,
      status TEXT NOT NULL,
      exit_code INTEGER,
      signal TEXT,
      pid INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      counts TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_target ON runs(grp, crawler, id);`);
    // runs left "running" by a previous server process can't be tracked any more
    this.db
      .prepare(`UPDATE runs SET status='failed', ended_at=?, error=COALESCE(error,'interrupted: server restarted') WHERE status='running'`)
      .run(new Date().toISOString());
  }

  groups(): GroupInfo[] {
    return discoverGroups();
  }

  get(id: number): Run | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(id) as RunRow | undefined;
    return r ? toRun(r) : null;
  }

  list(opts: { group?: string; crawler?: string | null; limit?: number; offset?: number } = {}): Run[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.group) {
      where.push('grp = ?');
      params.push(opts.group);
    }
    if (opts.crawler !== undefined) {
      where.push(opts.crawler === null ? 'crawler IS NULL' : 'crawler = ?');
      if (opts.crawler !== null) params.push(opts.crawler);
    }
    const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...params, opts.limit ?? 50, opts.offset ?? 0) as RunRow[]).map(toRun);
  }

  latest(group: string, crawler: string | null, task?: Task, status?: RunStatus): Run | null {
    const where = ['grp = ?'];
    const params: unknown[] = [group];
    if (crawler === null) where.push('crawler IS NULL');
    else {
      where.push('crawler = ?');
      params.push(crawler);
    }
    if (task) {
      where.push('task = ?');
      params.push(task);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const r = this.db.prepare(`SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`).get(...params) as
      | RunRow
      | undefined;
    return r ? toRun(r) : null;
  }

  running(): Run[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE status='running' ORDER BY id`).all() as RunRow[]).map(toRun);
  }

  /** Resolve what to execute for a (group, crawler, task). Throws on invalid combos. */
  private resolve(group: string, crawler: string | null, task: Task, args: string[]): { file: string; argv: string[] } {
    const g = this.groups().find((x) => x.name === group);
    if (!g) throw new HttpError(404, `unknown group ${group}`);
    const c = crawler === null ? null : g.crawlers.find((x) => x.name === crawler);
    if (crawler !== null && !c) throw new HttpError(404, `unknown crawler ${group}/${crawler}`);
    const bad = args.filter((a) => !ARG_RE.test(a));
    if (bad.length) throw new HttpError(400, `invalid args: ${bad.join(' ')} (only --flag or --flag=value)`);

    switch (task) {
      case 'crawl':
        if (!c) throw new HttpError(400, 'crawl needs a crawler (use pipeline for a whole group)');
        return { file: c.crawlerFile, argv: args };
      case 'clean':
        if (!c) throw new HttpError(400, 'clean needs a crawler');
        if (!c.cleanFile) throw new HttpError(400, `${group}/${c.name} has no clean.ts`);
        return { file: c.cleanFile, argv: [] };
      case 'ingest':
        if (!g.ingestFile) throw new HttpError(400, `${group} has no ingest.ts`);
        return { file: g.ingestFile, argv: c ? [c.name] : [] };
      case 'pipeline':
        return { file: 'scripts/run-group.ts', argv: [group, ...(c ? [c.name] : []), ...args] };
      default:
        throw new HttpError(400, `unknown task ${String(task)}`);
    }
  }

  start(group: string, crawler: string | null, task: Task, args: string[] = []): Run {
    const { file, argv } = this.resolve(group, crawler, task, args);
    const conflict = this.running().find(
      (r) => r.group === group && (r.crawler === crawler || r.crawler === null || crawler === null),
    );
    if (conflict) throw new HttpError(409, `run #${conflict.id} (${conflict.task}) is already running for ${group}${conflict.crawler ? '/' + conflict.crawler : ''}`);

    const cmdArgs = ['--import', 'tsx', file, ...argv];
    const command = `node ${cmdArgs.join(' ')}`;
    const startedAt = new Date().toISOString();
    const info = this.db
      .prepare(`INSERT INTO runs (grp, crawler, task, args, command, status, started_at) VALUES (?,?,?,?,?, 'running', ?)`)
      .run(group, crawler, task, JSON.stringify(args), command, startedAt);
    const id = Number(info.lastInsertRowid);

    const log = createWriteStream(this.logPath(id), { flags: 'a' });
    const counts: Record<string, number> = {};
    const emit = (s: LogLine['s'], l: string) => {
      const line: LogLine = { t: Date.now(), s, l };
      log.write(JSON.stringify(line) + '\n');
      this.events.emit(`log:${id}`, line);
    };

    // detached => own process group, so stop() can kill grandchildren (run-group spawns more processes)
    const child = spawn(process.execPath, cmdArgs, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0', SPIDERS_WEB_RUN_ID: String(id) },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const act: Active = { child, log, counts, stopRequested: false };
    this.active.set(id, act);
    this.db.prepare(`UPDATE runs SET pid=? WHERE id=?`).run(child.pid ?? null, id);
    emit('sys', `$ ${command}`);

    const pipeLines = (stream: NodeJS.ReadableStream, s: 'out' | 'err') => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          emit(s, l);
          if (parseCounts(l, counts)) this.db.prepare(`UPDATE runs SET counts=? WHERE id=?`).run(JSON.stringify(counts), id);
        }
      });
      stream.on('end', () => buf && emit(s, buf));
    };
    pipeLines(child.stdout!, 'out');
    pipeLines(child.stderr!, 'err');

    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (finished) return;
      finished = true;
      const status: RunStatus = act.stopRequested ? 'stopped' : code === 0 ? 'success' : 'failed';
      const endedAt = new Date().toISOString();
      this.db
        .prepare(`UPDATE runs SET status=?, exit_code=?, signal=?, ended_at=?, counts=?, error=? WHERE id=?`)
        .run(status, code, signal, endedAt, JSON.stringify(counts), error ?? null, id);
      emit('sys', `process exited: status=${status} code=${code ?? '-'}${signal ? ' signal=' + signal : ''}`);
      this.active.delete(id);
      log.end();
      this.events.emit(`end:${id}`, this.get(id));
      this.events.emit('change');
    };
    child.on('error', (err) => finish(null, null, err.message));
    child.on('close', (code, signal) => finish(code, signal));
    this.events.emit('change');
    return this.get(id)!;
  }

  stop(id: number): Run {
    const act = this.active.get(id);
    if (!act) throw new HttpError(409, `run #${id} is not running`);
    act.stopRequested = true;
    const pid = act.child.pid;
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        act.child.kill('SIGTERM');
      }
      setTimeout(() => {
        if (this.active.has(id)) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, 5000).unref();
    }
    return this.get(id)!;
  }

  isActive(id: number): boolean {
    return this.active.has(id);
  }

  logPath(id: number): string {
    return join(LOG_DIR, `${id}.jsonl`);
  }

  readLog(id: number): LogLine[] {
    const p = this.logPath(id);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as LogLine;
        } catch {
          return { t: 0, s: 'out', l } as LogLine;
        }
      });
  }

  /** Kill everything on shutdown. */
  stopAll(): void {
    for (const id of this.active.keys()) {
      try {
        this.stop(id);
      } catch {
        /* ignore */
      }
    }
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
  }
}
