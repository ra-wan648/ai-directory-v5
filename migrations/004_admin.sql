-- 004_admin.sql — tables for the hidden admin dashboard.
-- All statements are IF NOT EXISTS so the migration is idempotent.

-- Apify API keys (slots). Tokens are stored here so the dashboard can
-- manage them without touching GitHub secrets. Access is restricted to
-- admin-token-authenticated Worker endpoints only.
CREATE TABLE IF NOT EXISTS apify_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slot          INTEGER NOT NULL UNIQUE,
  label         TEXT NOT NULL DEFAULT '',
  token         TEXT NOT NULL DEFAULT '',
  assigned_job  TEXT NOT NULL DEFAULT 'ai-directory-scrape',
  monthly_cap_usd REAL NOT NULL DEFAULT 5.0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Manifest (LLM router) endpoints. The pipeline picks the enabled endpoint
-- with remaining monthly quota before each LLM call (rollover).
CREATE TABLE IF NOT EXISTS manifest_endpoints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL DEFAULT '',
  base_url        TEXT NOT NULL DEFAULT 'https://app.manifest.build/v1',
  api_key         TEXT NOT NULL DEFAULT '',
  monthly_limit   INTEGER NOT NULL DEFAULT 1000,
  used_this_month INTEGER NOT NULL DEFAULT 0,
  reset_day       INTEGER NOT NULL DEFAULT 1,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pipeline run history for the dashboard.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  tools_added INTEGER NOT NULL DEFAULT 0,
  errors      TEXT NOT NULL DEFAULT '',
  trigger     TEXT NOT NULL DEFAULT 'cron'
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started ON pipeline_runs(started_at DESC);
