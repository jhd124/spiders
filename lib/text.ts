import * as cheerio from 'cheerio';

/** Strip tags, decode entities, collapse whitespace. Returns null for empty. */
export function cleanText(input: string | null | undefined): string | null {
  if (input == null) return null;
  let s = String(input);
  if (/[<&]/.test(s)) s = cheerio.load(`<div>${s}</div>`)('div').first().text();
  s = s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length ? s : null;
}

export function uniq(arr: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const t = cleanText(v ?? null);
    if (!t) continue;
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** ISO datetime/epoch -> YYYY-MM-DD */
export function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Map assorted level words onto the schema's Level enum. */
export function normalizeLevel(v: unknown): 'introductory' | 'intermediate' | 'advanced' | 'mixed' | null {
  const s = String(v ?? '').toLowerCase();
  if (!s) return null;
  if (/(intro|beginner|basic)/.test(s)) return 'introductory';
  if (/intermediate/.test(s)) return 'intermediate';
  if (/advanced/.test(s)) return 'advanced';
  if (/mixed|all/.test(s)) return 'mixed';
  return null;
}

/** "ravit-reichman" -> "Ravit Reichman" (edX gives staff as slugs only). */
export function slugToName(slug: string): string {
  return slug
    .replace(/-\d+$/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
