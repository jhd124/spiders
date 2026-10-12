/** Polite download of one 培养方案 (robots.txt, per-host delay, honest UA via lib/http). */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { politeFetchBytes } from '../../lib/http.js';
import { CAREER_RAW } from '../fetchdoc.js';
import type { DocFormat } from './manifest.js';

export const CURRICULUM_RAW = join(CAREER_RAW, 'curriculum');

export interface FetchedFile {
  url: string;
  path: string;
  sha256: string;
  bytes: number;
  content_type: string | null;
  fetched_at: string;
}

/** Format is decided by magic bytes only; servers often send application/octet-stream or wrong types. */
export const MAGIC: Partial<Record<DocFormat, (b: Uint8Array) => boolean>> = {
  pdf: (b) => Buffer.from(b.slice(0, 5)).toString('latin1') === '%PDF-',
  docx: (b) => b[0] === 0x50 && b[1] === 0x4b, // zip
};

export function looksLike(format: DocFormat, data: Uint8Array): boolean {
  const check = MAGIC[format];
  return check ? check(data) : true;
}

export async function fetchFile(id: string, url: string, format: DocFormat, localFile?: string): Promise<{ meta: FetchedFile; data: Uint8Array }> {
  mkdirSync(CURRICULUM_RAW, { recursive: true });
  let data: Uint8Array;
  let content_type: string | null = null;
  if (localFile) data = new Uint8Array(readFileSync(localFile));
  else {
    const r = await politeFetchBytes(url);
    data = r.bytes;
    content_type = r.contentType;
  }
  if (!looksLike(format, data)) throw new Error(`${url}: content is not ${format} (content-type ${content_type}); a login page or anti-bot page?`);
  const path = join(CURRICULUM_RAW, `${id}.${format}`);
  writeFileSync(path, data);
  return {
    data,
    meta: { url, path, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, content_type, fetched_at: new Date().toISOString() },
  };
}
