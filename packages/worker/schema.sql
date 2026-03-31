-- Granite Cloud D1 Schema
-- Users + Auth + Note Index + Sync

-- === USERS & AUTH ===

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE,
  email TEXT UNIQUE,
  github_username TEXT,
  tier TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  session_id TEXT PRIMARY KEY,
  api_key TEXT,
  username TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

-- === VAULTS (linked to users) ===

CREATE TABLE IF NOT EXISTS vaults (
  vault_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_name TEXT NOT NULL,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_vaults_user ON vaults(user_id);

-- === NOTE INDEX (same as local SQLite) ===

CREATE TABLE IF NOT EXISTS notes (
  slug TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  created TEXT NOT NULL,
  modified TEXT NOT NULL,
  tags TEXT,
  aliases TEXT,
  body TEXT NOT NULL,
  filepath TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'human',
  vault_id TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  PRIMARY KEY (vault_id, slug),
  UNIQUE (vault_id, id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  body,
  tags,
  content='notes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body, tags)
    VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
    VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO notes_fts(rowid, title, body, tags)
    VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TABLE IF NOT EXISTS links (
  source_slug TEXT NOT NULL,
  target_slug TEXT,
  target_raw TEXT NOT NULL,
  context TEXT,
  vault_id TEXT NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  FOREIGN KEY (source_slug) REFERENCES notes(slug)
);

CREATE INDEX IF NOT EXISTS idx_links_target ON links(vault_id, target_slug);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(vault_id, source_slug);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT NOT NULL,
  value TEXT,
  vault_id TEXT NOT NULL,
  PRIMARY KEY (vault_id, key)
);

-- === SYNC ===

CREATE TABLE IF NOT EXISTS sync_changelog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  device_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  slug TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_changelog_vault_seq ON sync_changelog(vault_id, seq);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, device_id)
);

-- === RATE LIMITING ===

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'sync',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup
  ON rate_limits(identifier, action, created_at);
