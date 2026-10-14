/**
 * Student-facing occupation names (expert 2026-10-14): seeds/occupation_display_names.csv -> occupation_display (028).
 * Upsert; rows that left the CSV are removed (the CSV is the source of truth). official_name is checked against occupation.name.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { parseCsv } from '../lib/csv.js';

export const DISPLAY_CSV = join(dirname(fileURLToPath(import.meta.url)), 'seeds', 'occupation_display_names.csv');

export function loadOccupationDisplay(db: Database.Database, path = DISPLAY_CSV, log: (s: string) => void = console.log) {
  const up = db.prepare(`INSERT INTO occupation_display (code, official_name, display_name, search_aliases, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (code) DO UPDATE SET official_name = excluded.official_name, display_name = excluded.display_name, search_aliases = excluded.search_aliases, updated_at = excluded.updated_at`);
  const occ = db.prepare('SELECT name FROM occupation WHERE code = ?');
  const keep: string[] = [], mismatch: string[] = [];
  const now = new Date().toISOString();
  for (const r of parseCsv(readFileSync(path, 'utf8'))) {
    const code = r.code?.trim();
    if (!code || !r.display_name?.trim()) continue;
    const off = r.official_name?.trim() ?? '';
    const db_name = (occ.get(code) as { name: string } | undefined)?.name;
    if (db_name !== off) mismatch.push(`${code}: seed「${off}」 vs DB「${db_name ?? '(no occupation)'}」`);
    up.run(code, off, r.display_name.trim(), (r.search_aliases ?? '').split('|').map((s) => s.trim()).filter(Boolean).join('|'), now);
    keep.push(code);
  }
  const removed = keep.length
    ? db.prepare(`DELETE FROM occupation_display WHERE code NOT IN (${keep.map(() => '?').join(',')})`).run(...keep).changes : 0;
  if (mismatch.length) console.error(`[career] WARNING occupation_display_names.csv official name mismatch:\n  ${mismatch.join('\n  ')}`);
  log(`[career] occupation display names: ${keep.length} loaded, ${removed} removed${mismatch.length ? `, ${mismatch.length} name mismatch` : ''}`);
  return { loaded: keep.length, removed, mismatch };
}
