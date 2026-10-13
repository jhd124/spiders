/**
 * Expert skill aliases (alias -> skill), maintained in the admin (#/aliases) and seeded from CAREER/seeds/skill_aliases.csv.
 * The DB is where edits live; the seed is insert-only (an alias deleted in the admin is tombstoned in skill_alias_deleted and
 * not re-added). GET /api/aliases/export.csv gives the current DB list in the seed format, to commit back to git.
 * Every change re-applies the deterministic alias tagging (tag.ts applyAliasTags + classifyCoreNames), no LLM.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { parseCsv } from '../lib/csv.js';
import { applyAliasTags, classifyCoreNames } from './curriculum/tag.js';
import { applyBlockTypeConfig, backfillImpliedTypes } from './curriculum/load.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ALIAS_CSV = join(HERE, 'seeds', 'skill_aliases.csv');

const skillId = (db: Database.Database, nameOrId: string) =>
  (db.prepare('SELECT id FROM skill WHERE name = @n UNION ALL SELECT id FROM skill WHERE id = @n').get({ n: nameOrId.trim() }) as { id: string } | undefined)?.id;

export function loadSkillAliases(db: Database.Database, path = ALIAS_CSV, log: (s: string) => void = console.log) {
  const ins = db.prepare(`INSERT INTO skill_alias (alias, skill_id, source, created_by, created_at) VALUES (?, ?, ?, 'seed', ?) ON CONFLICT (alias) DO NOTHING`);
  const dead = db.prepare('SELECT 1 FROM skill_alias_deleted WHERE alias = ?');
  const bad: string[] = [];
  let added = 0;
  for (const r of parseCsv(readFileSync(path, 'utf8'))) {
    const alias = r.alias?.trim();
    if (!alias) continue;
    const id = skillId(db, r.skill_name || r.skill_id || '');
    if (!id) { bad.push(`${alias} -> ${r.skill_name}: unknown skill`); continue; }
    if (dead.get(alias)) continue;
    added += ins.run(alias, id, r.source?.trim() || 'expert', new Date().toISOString()).changes;
  }
  if (bad.length) console.error(`[career] ERROR skill_aliases.csv: ${bad.length} row(s) NOT loaded:\n  ${bad.join('\n  ')}`);
  log(`[career] skill aliases: +${added} from seed${bad.length ? `, ${bad.length} bad` : ''}`);
  return { added, bad };
}

/** deterministic re-derivation after alias / type changes: alias tags, 核心课名 classification, implied course types */
export function applyAliasRules(db: Database.Database) {
  const types = backfillImpliedTypes(db);
  const blocks = applyBlockTypeConfig(db);
  const tags = applyAliasTags(db);
  const core = classifyCoreNames(db);
  return { types, blocks, tags, core_name_retyped: core.updated };
}

export interface AliasRow { alias: string; skill_id: string; skill: string; skill_type: string; source: string; created_by: string | null; created_at: string | null; courses: number }
export function listAliases(db: Database.Database): AliasRow[] {
  return db.prepare(`SELECT a.alias, a.skill_id, s.name skill, s.skill_type, a.source, a.created_by, a.created_at,
      (SELECT count(*) FROM course_skill cs WHERE cs.skill_id = a.skill_id AND cs.source = 'rule:alias'
         AND instr(lower(replace((SELECT name FROM course WHERE id = cs.course_id), ' ', '')), lower(replace(a.alias, ' ', ''))) > 0) courses
    FROM skill_alias a JOIN skill s ON s.id = a.skill_id ORDER BY s.name, a.alias`).all() as AliasRow[];
}

export function addAlias(db: Database.Database, alias: string, skill: string, by: string) {
  const a = alias.trim();
  if (a.length < 2) throw new Error('alias must have at least 2 characters');
  const id = skillId(db, skill);
  if (!id) throw new Error(`unknown skill ${skill}`);
  const clash = db.prepare('SELECT 1 FROM skill WHERE name = ?').get(a);
  if (clash) throw new Error(`"${a}" is already a skill name`);
  return db.transaction(() => {
    db.prepare(`INSERT INTO skill_alias (alias, skill_id, source, created_by, created_at) VALUES (?, ?, 'expert', ?, ?)
      ON CONFLICT (alias) DO UPDATE SET skill_id = excluded.skill_id, source = 'expert', created_by = excluded.created_by, created_at = excluded.created_at`).run(a, id, by, new Date().toISOString());
    db.prepare('DELETE FROM skill_alias_deleted WHERE alias = ?').run(a);
    return applyAliasRules(db);
  })();
}

export function deleteAlias(db: Database.Database, alias: string, by: string) {
  return db.transaction(() => {
    const row = db.prepare('SELECT skill_id FROM skill_alias WHERE alias = ?').get(alias) as { skill_id: string } | undefined;
    if (!row) throw new Error(`no alias ${alias}`);
    db.prepare('DELETE FROM skill_alias WHERE alias = ?').run(alias);
    db.prepare(`INSERT INTO skill_alias_deleted (alias, skill_id, deleted_by, deleted_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (alias) DO UPDATE SET skill_id = excluded.skill_id, deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at`).run(alias, row.skill_id, by, new Date().toISOString());
    return applyAliasRules(db);
  })();
}

export function exportAliasesCsv(db: Database.Database): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = db.prepare('SELECT a.alias, s.name skill, a.source, a.created_by FROM skill_alias a JOIN skill s ON s.id = a.skill_id ORDER BY s.name, a.alias').all() as { alias: string; skill: string; source: string; created_by: string | null }[];
  return ['alias,skill_name,source,note', ...rows.map((r) => [r.alias, r.skill, r.source, r.created_by && r.created_by !== 'seed' ? `added by ${r.created_by}` : ''].map(q).join(','))].join('\n') + '\n';
}
