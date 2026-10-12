/**
 * Spiders web console — API + (in production) the built React app.
 *   npm run web:dev     # API on 127.0.0.1:8787 + Vite dev server on 127.0.0.1:5173
 *   npm run web:build && npm run web:start   # single server on 127.0.0.1:8787
 * No authentication: it binds to localhost by default (HOST / PORT env to change).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../../lib/io.js';
import { discoverGroups } from '../../lib/discovery.js';
import { HttpError, RunManager } from './runs.js';
import { review } from './review.js';
import { describeDataset, getItem, listDatasets, queryDataset } from './query.js';
import type { CrawlerView, GroupView, LogLine, Run, Task } from '../shared/types.js';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8787);
const TASKS: Task[] = ['crawl', 'clean', 'ingest', 'pipeline'];

const runs = new RunManager();
const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: err.message }, 500);
});

/* ---------- crawlers ---------- */

function groupViews(): GroupView[] {
  const running = runs.running();
  return runs.groups().map((g) => {
    const crawlers: CrawlerView[] = g.crawlers.map((c) => {
      const lastSuccessByTask: CrawlerView['lastSuccessByTask'] = {};
      for (const t of TASKS) {
        const r = runs.latest(g.name, c.name, t, 'success');
        if (r) lastSuccessByTask[t] = r;
      }
      return {
        group: g.name,
        name: c.name,
        hasClean: !!c.cleanFile,
        lastRun: runs.latest(g.name, c.name),
        lastSuccessByTask,
        running: running.find((r) => r.group === g.name && r.crawler === c.name) ?? null,
      };
    });
    return {
      name: g.name,
      hasIngest: !!g.ingestFile,
      hasDataset: !!g.datasetFile,
      crawlers,
      lastRun: runs.latest(g.name, null),
      running: running.find((r) => r.group === g.name && r.crawler === null) ?? null,
    };
  });
}

app.get('/api/groups', (c) => c.json(groupViews()));

app.get('/api/runs', (c) => {
  const crawler = c.req.query('crawler');
  return c.json(
    runs.list({
      group: c.req.query('group') || undefined,
      crawler: crawler === undefined ? undefined : crawler === '' || crawler === '-' ? null : crawler,
      limit: Number(c.req.query('limit') ?? 50),
      offset: Number(c.req.query('offset') ?? 0),
    }),
  );
});

app.post('/api/runs', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    group?: string;
    crawler?: string | null;
    task?: Task;
    args?: string[];
  };
  if (!body.group || !body.task) throw new HttpError(400, 'group and task are required');
  if (!TASKS.includes(body.task)) throw new HttpError(400, `task must be one of ${TASKS.join(', ')}`);
  const run = runs.start(body.group, body.crawler ?? null, body.task, Array.isArray(body.args) ? body.args : []);
  return c.json(run, 201);
});

const runOr404 = (id: string): Run => {
  const r = runs.get(Number(id));
  if (!r) throw new HttpError(404, `no run ${id}`);
  return r;
};

app.get('/api/runs/:id', (c) => c.json(runOr404(c.req.param('id'))));
app.post('/api/runs/:id/stop', (c) => c.json(runs.stop(runOr404(c.req.param('id')).id)));

app.get('/api/runs/:id/log', (c) => {
  const r = runOr404(c.req.param('id'));
  const lines = runs.readLog(r.id);
  if (c.req.query('format') === 'text') {
    return c.text(lines.map((l) => `${new Date(l.t).toISOString()} [${l.s}] ${l.l}`).join('\n') + '\n');
  }
  return c.json(lines);
});

/** SSE: replays the log so far, then streams new lines; ends with an `end` event carrying the final run. */
app.get('/api/runs/:id/stream', (c) => {
  const r = runOr404(c.req.param('id'));
  return streamSSE(c, async (stream) => {
    const queue: LogLine[] = [];
    let wake: (() => void) | null = null;
    let ended: Run | null = null;
    const onLog = (l: LogLine) => {
      queue.push(l);
      wake?.();
    };
    const onEnd = (run: Run) => {
      ended = run;
      wake?.();
    };
    // subscribe first, then replay; drop live lines already covered by the replay
    runs.events.on(`log:${r.id}`, onLog);
    runs.events.on(`end:${r.id}`, onEnd);
    stream.onAbort(() => {
      runs.events.off(`log:${r.id}`, onLog);
      runs.events.off(`end:${r.id}`, onEnd);
      wake?.();
    });
    const past = runs.readLog(r.id);
    await stream.writeSSE({ event: 'replay', data: JSON.stringify(past) });
    // lines emitted between subscribing and reading the file are in both: drop the duplicates
    const seen = new Set(past.slice(-500).map((l) => `${l.t}|${l.s}|${l.l}`));
    for (let i = queue.length - 1; i >= 0; i--) if (seen.has(`${queue[i]!.t}|${queue[i]!.s}|${queue[i]!.l}`)) queue.splice(i, 1);

    if (!runs.isActive(r.id)) ended = runs.get(r.id);
    while (!stream.aborted) {
      while (queue.length) await stream.writeSSE({ event: 'log', data: JSON.stringify(queue.shift()) });
      if (ended) {
        await stream.writeSSE({ event: 'end', data: JSON.stringify(ended) });
        break;
      }
      await new Promise<void>((res) => {
        wake = res;
        setTimeout(res, 15000); // heartbeat
      });
      wake = null;
      if (!queue.length && !ended && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
    }
    runs.events.off(`log:${r.id}`, onLog);
    runs.events.off(`end:${r.id}`, onEnd);
  });
});

/* ---------- datasets ---------- */

app.get('/api/datasets', async (c) => c.json(await listDatasets()));
app.get('/api/datasets/:group', async (c) => c.json(await describeDataset(c.req.param('group'))));
app.get('/api/datasets/:group/items', async (c) =>
  c.json(await queryDataset(c.req.param('group'), new URL(c.req.url).searchParams)),
);
app.get('/api/datasets/:group/items/:id{.+}', async (c) =>
  c.json(await getItem(c.req.param('group'), decodeURIComponent(c.req.param('id')))),
);

app.route('/api/review/curriculum', review);

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

/* ---------- static (production build) ---------- */

const DIST = join(ROOT, 'web', 'dist');
if (existsSync(DIST)) {
  app.use('/*', serveStatic({ root: DIST }));
  app.get('*', serveStatic({ path: join(DIST, 'index.html') }));
} else {
  app.get('/', (c) => c.text('API is running. Frontend not built: use `npm run web:dev` (http://127.0.0.1:5173) or `npm run web:build`.'));
}

/* ---------- group migrations (idempotent; failures are logged, never block startup) ---------- */

for (const g of discoverGroups()) {
  if (!g.migrateFile) continue;
  try {
    const mod = (await import(pathToFileURL(join(ROOT, g.migrateFile)).href)) as { migrate?: () => unknown };
    mod.migrate?.();
  } catch (err) {
    console.error(`[migrate] ${g.name} failed:`, err);
  }
}

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`spiders web: http://${info.address}:${info.port}  (no auth — keep it on localhost)`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    runs.stopAll();
    setTimeout(() => process.exit(0), 300);
  });
}
