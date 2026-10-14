/**
 * Polite HTTP client shared by all crawlers:
 *  - identifies itself with a UA string
 *  - checks robots.txt (Allow/Disallow with * and $ wildcards, Crawl-delay)
 *  - enforces a minimum delay between requests to the same host
 *  - retries on 429 / 5xx with exponential backoff
 */

export const USER_AGENT =
  process.env.SPIDERS_UA ??
  'Mozilla/5.0 (compatible; spiders-bot/0.1; +https://github.com/jhd124/spiders)';
const UA_TOKEN = 'spiders-bot';

/** Default minimum delay between two requests to the same host (ms). */
export const DEFAULT_DELAY_MS = Number(process.env.SPIDERS_DELAY_MS ?? 1500);

interface RobotsRule {
  allow: boolean;
  pattern: string;
  re: RegExp;
}
interface RobotsInfo {
  rules: RobotsRule[];
  crawlDelayMs: number | null;
}

const robotsCache = new Map<string, Promise<RobotsInfo>>();
const lastRequestAt = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

export function parseRobots(txt: string): RobotsInfo {
  // Collect groups; pick the one matching our UA token, else '*'.
  type Group = { agents: string[]; lines: [string, string][] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], lines: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur) cur.lines.push([key, val]);
    }
  }
  const mine =
    groups.find((g) => g.agents.some((a) => a !== '*' && UA_TOKEN.includes(a))) ??
    groups.find((g) => g.agents.includes('*'));
  const info: RobotsInfo = { rules: [], crawlDelayMs: null };
  if (!mine) return info;
  for (const [k, v] of mine.lines) {
    if ((k === 'allow' || k === 'disallow') && v) {
      info.rules.push({ allow: k === 'allow', pattern: v, re: patternToRegExp(v) });
    } else if (k === 'crawl-delay') {
      const n = Number(v);
      if (Number.isFinite(n)) info.crawlDelayMs = n * 1000;
    }
  }
  return info;
}

async function getRobots(origin: string): Promise<RobotsInfo> {
  let p = robotsCache.get(origin);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(origin + '/robots.txt', { headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok) return { rules: [], crawlDelayMs: null };
        return parseRobots(await res.text());
      } catch {
        return { rules: [], crawlDelayMs: null };
      }
    })();
    robotsCache.set(origin, p);
  }
  return p;
}

export function isAllowed(info: RobotsInfo, pathAndQuery: string): boolean {
  let best: RobotsRule | null = null;
  for (const r of info.rules) {
    if (!r.re.test(pathAndQuery)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) {
      best = r;
    }
  }
  return best ? best.allow : true;
}

export class RobotsDisallowedError extends Error {}

export interface PoliteFetchOptions {
  delayMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** default GET; POST is for public search endpoints that the site's own (anonymous) UI calls the same way */
  method?: 'GET' | 'POST';
  body?: string;
}

/** Fetch a URL politely and return the body text. Throws on non-2xx after retries. */
export async function politeFetch(url: string, opts: PoliteFetchOptions = {}): Promise<string> {
  return (await politeResponse(url, opts)).text();
}

/** Same as politeFetch but returns the raw bytes (PDFs etc.) and the final content-type. */
export async function politeFetchBytes(
  url: string,
  opts: PoliteFetchOptions = {},
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const res = await politeResponse(url, { ...opts, headers: { Accept: '*/*', ...opts.headers } });
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
}

async function politeResponse(url: string, opts: PoliteFetchOptions): Promise<Response> {
  const u = new URL(url);
  const robots = await getRobots(u.origin);
  if (!isAllowed(robots, u.pathname + u.search)) {
    throw new RobotsDisallowedError(`robots.txt disallows ${url}`);
  }
  const delay = Math.max(opts.delayMs ?? DEFAULT_DELAY_MS, robots.crawlDelayMs ?? 0);
  const retries = opts.retries ?? 3;

  for (let attempt = 0; ; attempt++) {
    const last = lastRequestAt.get(u.host) ?? 0;
    const wait = last + delay - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt.set(u.host, Date.now());

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', ...opts.headers },
        redirect: 'follow',
        method: opts.method ?? 'GET',
        body: opts.body,
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(2 ** attempt * 2000);
      continue;
    }
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2 ** attempt * 3000);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
}
