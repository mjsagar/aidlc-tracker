// SQLite storage (node:sqlite). Schema follows the design doc's data model;
// `sync_jobs` is the queue the worker polls.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('local','github','gitlab')),
  host TEXT,
  account TEXT,
  credentials_enc TEXT,
  webhook_secret TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  platform_repo_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  local_path TEXT,
  default_branch TEXT,
  web_url TEXT,
  tracked INTEGER NOT NULL DEFAULT 1,
  aidlc_version TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (connection_id, platform_repo_id)
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tracked INTEGER NOT NULL DEFAULT 1,
  last_commit_sha TEXT,
  last_tree_sha TEXT,
  last_synced_at TEXT,
  sync_error TEXT,
  UNIQUE (repo_id, name)
);

CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  space TEXT NOT NULL,
  folder TEXT NOT NULL,
  description TEXT,
  scope TEXT,
  phase TEXT,
  stage TEXT,
  status TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  open_questions INTEGER NOT NULL DEFAULT 0,
  waiting INTEGER NOT NULL DEFAULT 0,
  last_activity TEXT,
  warnings INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (branch_id, space, folder)
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  intent_id INTEGER NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  qkey TEXT NOT NULL,
  file TEXT NOT NULL,
  kind TEXT NOT NULL,
  number INTEGER,
  trade TEXT,
  title TEXT NOT NULL,
  phase TEXT,
  stage TEXT,
  unit TEXT,
  line INTEGER,
  answer_line INTEGER,
  answer TEXT,
  open INTEGER NOT NULL,
  open_since TEXT,
  first_seen_open TEXT,
  answered_at TEXT,
  UNIQUE (intent_id, qkey)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  intent_id INTEGER NOT NULL REFERENCES intents(id) ON DELETE CASCADE,
  shard TEXT NOT NULL,
  idx INTEGER NOT NULL,
  timestamp TEXT,
  event TEXT NOT NULL,
  known INTEGER NOT NULL,
  stage TEXT,
  unit TEXT,
  git_name TEXT,
  fields_json TEXT NOT NULL,
  UNIQUE (intent_id, shard, idx)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  event TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS questions_open ON questions (open, open_since);
CREATE INDEX IF NOT EXISTS events_intent ON events (intent_id, timestamp);
CREATE INDEX IF NOT EXISTS jobs_state ON sync_jobs (state, id);
`;

// Each entry upgrades the database by one version (PRAGMA user_version).
const MIGRATIONS = [
  // 1 -> 2: GitHub (milestone 3)
  `
  ALTER TABLE connections ADD COLUMN external_id TEXT;
  CREATE UNIQUE INDEX connections_external ON connections (platform, external_id) WHERE external_id IS NOT NULL;
  ALTER TABLE sync_jobs ADD COLUMN run_after TEXT;
  ALTER TABLE sync_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE github_app (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    app_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    owner TEXT,
    html_url TEXT,
    client_id TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,
    webhook_secret_enc TEXT,
    pem_enc TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  );

  CREATE TABLE connection_jobs (
    id INTEGER PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at TEXT
  );

  CREATE TABLE blobs (sha TEXT PRIMARY KEY, content TEXT NOT NULL);
  CREATE TABLE files (
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    sha TEXT NOT NULL,
    PRIMARY KEY (branch_id, path)
  );
  CREATE TABLE http_cache (url TEXT PRIMARY KEY, etag TEXT NOT NULL, body TEXT NOT NULL, stored_at TEXT NOT NULL);

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    login TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (platform, platform_user_id)
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_enc TEXT NOT NULL,
    repo_ids_json TEXT NOT NULL DEFAULT '[]',
    checked_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE oauth_states (state TEXT PRIMARY KEY, purpose TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL);
  `,
];

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  let version = db.prepare("PRAGMA user_version").get().user_version || 1;
  while (version - 1 < MIGRATIONS.length) {
    tx(db, () => {
      db.exec(MIGRATIONS[version - 1]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    version += 1;
  }
  if (!db.prepare("SELECT 1 FROM workspaces LIMIT 1").get()) db.prepare("INSERT INTO workspaces (name) VALUES (?)").run("Default");
  return db;
}

/** Runs fn inside a transaction; rolls back if it throws. */
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
