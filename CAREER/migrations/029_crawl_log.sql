-- 029 (2026-10-15): crawler run logs (lib/crawllog.ts), written by every crawler run (CLI, cron or the web console).
--  Files per run: data/logs/crawl/<crawler>/<run_id>/{run.json, requests.jsonl, records.jsonl}; the DB holds the index,
--  the request log and failures (records stay in files). Old runs are pruned (SPIDERS_CRAWL_KEEP per crawler, default 30).
CREATE TABLE IF NOT EXISTS crawl_run (
  id           TEXT PRIMARY KEY,
  crawler      TEXT NOT NULL,
  web_run_id   INTEGER,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  duration_ms  INTEGER,
  status       TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
  requests     INTEGER NOT NULL DEFAULT 0,
  request_errors INTEGER NOT NULL DEFAULT 0,
  pages        INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0,
  records      INTEGER NOT NULL DEFAULT 0,
  new_records  INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  duplicate    INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  failures     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  dir          TEXT NOT NULL,
  summary_json TEXT
);
CREATE INDEX IF NOT EXISTS crawl_run_crawler ON crawl_run (crawler, started_at);
CREATE TABLE IF NOT EXISTS crawl_request (
  run_id      TEXT NOT NULL REFERENCES crawl_run(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  at          TEXT NOT NULL,
  method      TEXT NOT NULL,
  url         TEXT NOT NULL,
  keyword     TEXT,
  page        INTEGER,
  status      INTEGER,
  bytes       INTEGER,
  elapsed_ms  INTEGER,
  attempt     INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS crawl_failure (
  run_id      TEXT NOT NULL REFERENCES crawl_run(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  at          TEXT NOT NULL,
  reason      TEXT NOT NULL,
  context_json TEXT,
  PRIMARY KEY (run_id, seq)
);
