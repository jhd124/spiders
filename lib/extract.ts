/** Helpers to pull embedded JSON out of HTML pages. */

/** Given text and the index of a '{' or '[', return the index just past its matching close bracket (string-aware). */
export function matchBracket(txt: string, start: number): number {
  const open = txt[start];
  if (open !== '{' && open !== '[') return -1;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < txt.length; i++) {
    const c = txt[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Parse the JSON value that starts at `start` (an object or array). */
export function parseJsonAt<T = unknown>(txt: string, start: number): T | null {
  const end = matchBracket(txt, start);
  if (end < 0) return null;
  try {
    return JSON.parse(txt.slice(start, end)) as T;
  } catch {
    return null;
  }
}

/** Extract `window.__APOLLO_STATE__ = {...}` (Coursera and other Apollo SSR apps). */
export function extractApolloState(html: string): Record<string, any> | null {
  const marker = 'window.__APOLLO_STATE__ = ';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  return parseJsonAt<Record<string, any>>(html, i + marker.length);
}

/** Concatenate the React Server Components payload (`self.__next_f.push([1,"..."])`) of a Next.js app-router page. */
export function extractNextFlight(html: string): string {
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let out = '';
  for (const m of html.matchAll(re)) {
    try {
      out += JSON.parse(m[1]!) as string;
    } catch {
      /* ignore malformed chunk */
    }
  }
  return out;
}

/**
 * Find every JSON object in `txt` that directly contains `"<key>":` and return them, de-duplicated by that key's value.
 * Works by walking backwards from each key occurrence to the smallest enclosing object that parses.
 */
export function findObjectsWithKey(txt: string, key: string, maxBacktrack = 400): Record<string, any>[] {
  const needle = `"${key}":`;
  const seen = new Map<string, Record<string, any>>();
  let pos = txt.indexOf(needle);
  while (pos >= 0) {
    let i = pos;
    for (let tries = 0; tries < maxBacktrack && i > 0; ) {
      i = txt.lastIndexOf('{', i - 1);
      if (i < 0) break;
      tries++;
      const end = matchBracket(txt, i);
      if (end <= pos) continue; // this object closes before the key: not an ancestor
      const obj = parseJsonAt<Record<string, any>>(txt, i);
      if (obj && typeof obj === 'object' && key in obj) {
        const id = String(obj[key]);
        if (!seen.has(id)) seen.set(id, obj);
        break;
      }
    }
    pos = txt.indexOf(needle, pos + needle.length);
  }
  return [...seen.values()];
}
