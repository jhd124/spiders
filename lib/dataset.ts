/**
 * Query-layer contract for the web UI.
 * Each crawler group may export a default `DatasetConfig` from `<GROUP>/dataset.ts`;
 * the web server picks it up automatically and exposes a search page for it.
 * Only SQLite is implemented for now (`kind: 'sqlite'`).
 */

export interface FilterDef {
  /** query-string key, e.g. "school" */
  key: string;
  label: string;
  /** SQL column the filter applies to */
  column: string;
  /** select: equality on distinct values (options auto-loaded); boolean: 1/0 column */
  type: 'select' | 'boolean';
  /** optional fixed labels for select values */
  labels?: Record<string, string>;
}

export interface ColumnDef {
  column: string;
  label: string;
  /** how the UI renders it */
  format?: 'text' | 'link' | 'boolean' | 'list' | 'number' | 'date';
}

/**
 * A named topic preset (shown as a "主题" filter). A row matches when ANY of the terms matches
 * as a whole word / phrase in any of `columns`.
 */
export interface TopicDef {
  key: string;
  label: string;
  /** columns to look in; defaults to the dataset's fts.columns */
  columns?: string[];
  /** case-insensitive whole-word terms or phrases, e.g. "machine learning", "neural networks" */
  terms: string[];
  /**
   * short tokens that only count when written exactly like this as a whole word
   * (e.g. "AI" — so "ai" in Spanish/Italian text, or "Ai" in a name, don't match)
   */
  caseSensitiveTerms?: string[];
}

export interface FtsConfig {
  /** name of the FTS5 virtual table to (re)build next to `table` */
  table: string;
  /** text columns indexed for keyword search (JSON array columns are fine: punctuation is ignored) */
  columns: string[];
  /** column that changes on every ingest (used to detect a stale index); optional */
  updatedColumn?: string;
}

export interface DatasetConfig {
  /**
   * sub-key when a group's dataset.ts default-exports several datasets (an array);
   * the dataset id becomes `<GROUP>.<key>`. Not needed for a single dataset.
   */
  key?: string;
  /** display name */
  title: string;
  description?: string;
  kind: 'sqlite';
  /** absolute path to the DB file */
  dbPath: string;
  table: string;
  idColumn: string;
  /** column shown as the row title in the detail view */
  titleColumn: string;
  /** full-text index used by keyword search and topics (whole-word, case-insensitive; see lib/fts.ts) */
  fts: FtsConfig;
  /** topic presets, e.g. AI */
  topics?: TopicDef[];
  filters: FilterDef[];
  /** columns in the result table */
  listColumns: ColumnDef[];
  /** columns that hold JSON arrays/objects (parsed before sending to the UI) */
  jsonColumns?: string[];
  /** default ORDER BY column (ascending) */
  defaultSort?: string;
}

export const defineDataset = (c: DatasetConfig) => c;

/** A group's dataset.ts may default-export one DatasetConfig or an array of them (each with a `key`). */
export type DatasetModule = DatasetConfig | DatasetConfig[];
