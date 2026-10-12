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

export interface DatasetConfig {
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
  /** columns matched by the keyword search (LIKE %q%) */
  searchColumns: string[];
  filters: FilterDef[];
  /** columns in the result table */
  listColumns: ColumnDef[];
  /** columns that hold JSON arrays/objects (parsed before sending to the UI) */
  jsonColumns?: string[];
  /** default ORDER BY column (ascending) */
  defaultSort?: string;
}

export const defineDataset = (c: DatasetConfig) => c;
