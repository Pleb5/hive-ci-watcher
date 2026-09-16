export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS followed_repos (
  repo_addr      TEXT PRIMARY KEY,
  repo_owner     TEXT NOT NULL,
  d_tag          TEXT NOT NULL,
  default_branch TEXT,
  added_by       TEXT NOT NULL,
  added_at       INTEGER NOT NULL,
  -- NULL until the first 30618 has been recorded. That first state seeds
  -- ref_state without dispatching; otherwise following a repo with 200 tags
  -- would fire 200 runs on sight.
  seeded_at      INTEGER,
  -- JSON array of relay URLs the follower supplied (an naddr's hints).
  -- Unioned into the announcement and state subscriptions for this repo.
  relay_hints    TEXT NOT NULL DEFAULT '[]'
);

-- ref is the full name: refs/heads/main, refs/tags/v1.2.0
-- A ref that disappears from the state event is tombstoned (deleted_at set),
-- not dropped, so a reappearance at the same commit is not a new push.
CREATE TABLE IF NOT EXISTS ref_state (
  repo_addr  TEXT NOT NULL,
  ref        TEXT NOT NULL,
  commit_id  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (repo_addr, ref)
);

CREATE TABLE IF NOT EXISTS schedules (
  repo_addr     TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  cron          TEXT NOT NULL,
  last_fired_at INTEGER NOT NULL,
  PRIMARY KEY (repo_addr, workflow_path)
);

CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  repo_addr     TEXT NOT NULL,
  ref           TEXT NOT NULL,
  commit_id     TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  runner_pubkey TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs (created_at DESC);
CREATE INDEX IF NOT EXISTS runs_repo_idx ON runs (repo_addr, created_at DESC);

CREATE TABLE IF NOT EXISTS allowlist (
  pubkey   TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL
);

-- private, never published
CREATE TABLE IF NOT EXISTS runner_pool (
  pubkey   TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL
);

-- round-robin cursor, cached runner-script blob URL, relay bookkeeping
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
