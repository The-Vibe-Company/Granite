-- Granite Cloud D1 Schema
-- Identical to src/core/index-db.ts SCHEMA_SQL + multi-tenant sync tables

-- === NOTE INDEX (same as local SQLite) ===

CREATE TABLE IF NOT EXISTS notes (
  slug        TEXT PRIMARY KEY,
  id          TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL,
  created     TEXT NOT NULL,
  modified    TEXT NOT NULL,
  tags        TEXT,
  aliases     TEXT,
  body        TEXT NOT NULL,
  filepath    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  source      TEXT NOT NULL DEFAULT 'human'
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
  source_slug   TEXT NOT NULL,
  target_slug   TEXT,
  target_raw    TEXT NOT NULL,
  context       TEXT,
  FOREIGN KEY (source_slug) REFERENCES notes(slug)
);

CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_slug);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_slug);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- === MULTI-TENANT SYNC ===

CREATE TABLE IF NOT EXISTS vaults (
  vault_id      TEXT PRIMARY KEY,
  api_key_hash  TEXT UNIQUE NOT NULL,
  vault_name    TEXT NOT NULL,
  created       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_changelog (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id    TEXT NOT NULL,
  note_id     TEXT NOT NULL,
  operation   TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  slug        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_changelog_vault_seq ON sync_changelog(vault_id, seq);

CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  vault_id    TEXT NOT NULL,
  device_name TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  last_seq    INTEGER NOT NULL DEFAULT 0
);
