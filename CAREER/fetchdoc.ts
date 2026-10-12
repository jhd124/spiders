/** Download an official document politely, keep the bytes under data/raw/career/, return metadata. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_DIR } from '../lib/io.js';
import { politeFetchBytes } from '../lib/http.js';
import type { SourceDoc } from './sources.js';

export const CAREER_RAW = join(RAW_DIR, 'career');

export interface FetchedDoc {
  doc: SourceDoc;
  path: string;
  fetched_url: string;
  fetched_at: string;
  sha256: string;
  bytes: number;
}

/** `--file=<id>=<path>` lets an operator supply a manually downloaded official copy. */
export async function fetchDoc(doc: SourceDoc, argv = process.argv.slice(2)): Promise<{ meta: FetchedDoc; data: Uint8Array }> {
  mkdirSync(CAREER_RAW, { recursive: true });
  const path = join(CAREER_RAW, `${doc.id}.pdf`);
  const local = argv.find((a) => a.startsWith(`--file=${doc.id}=`))?.split('=').slice(2).join('=');
  let data: Uint8Array | null = null;
  let fetched_url = '';
  const errors: string[] = [];
  if (local) {
    data = new Uint8Array(readFileSync(local));
    fetched_url = `file:${local}`;
  } else {
    for (const u of doc.fetch) {
      try {
        const r = await politeFetchBytes(u);
        const head = Buffer.from(r.bytes.slice(0, 5)).toString('latin1');
        if (head !== '%PDF-') throw new Error(`not a PDF (content-type ${r.contentType})`);
        data = r.bytes;
        fetched_url = u;
        break;
      } catch (e) {
        errors.push(`${u}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (!data) {
    if (existsSync(path)) {
      console.warn(`[career] download failed, reusing cached ${path}\n  ${errors.join('\n  ')}`);
      data = new Uint8Array(readFileSync(path));
      fetched_url = 'cache:' + path;
    } else throw new Error(`could not download ${doc.id}:\n  ${errors.join('\n  ')}`);
  } else writeFileSync(path, data);
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { meta: { doc, path, fetched_url, fetched_at: new Date().toISOString(), sha256, bytes: data.length }, data };
}
