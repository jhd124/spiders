import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface LlmCache {
  get(key: string): string | undefined;
  set(key: string, v: { model: string; promptVersion: string; response: string; promptTokens?: number; completionTokens?: number }): void;
}

export const cacheKey = (model: string, promptVersion: string, content: string) =>
  createHash('sha256').update(`${model}\u0000${promptVersion}\u0000${content}`).digest('hex');

export class MemoryCache implements LlmCache {
  private m = new Map<string, string>();
  get(k: string) { return this.m.get(k); }
  set(k: string, v: { response: string }) { this.m.set(k, v.response); }
}

/** Persistent cache in career.db (table llm_cache, migration 005). */
export class SqliteLlmCache implements LlmCache {
  constructor(private db: Database.Database) {}
  get(k: string) {
    return (this.db.prepare('SELECT response FROM llm_cache WHERE cache_key = ?').get(k) as { response: string } | undefined)?.response;
  }
  set(k: string, v: { model: string; promptVersion: string; response: string; promptTokens?: number; completionTokens?: number }) {
    this.db
      .prepare(`INSERT INTO llm_cache (cache_key, model, prompt_version, response, prompt_tokens, completion_tokens, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (cache_key) DO UPDATE SET response = excluded.response, prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens, created_at = excluded.created_at`)
      .run(k, v.model, v.promptVersion, v.response, v.promptTokens ?? null, v.completionTokens ?? null, new Date().toISOString());
  }
}
