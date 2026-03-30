import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { GraniteConfig, Note } from './types.js';
import { listNotes } from './note.js';
import { parseWikilinks, resolveWikilinks } from './wikilinks.js';
import { getIndexDbPath } from './vault.js';

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
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
`;

export function createDatabase(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  return db;
}

export function openDatabase(vaultRoot: string): Database.Database {
  const dbPath = getIndexDbPath(vaultRoot);
  if (!fs.existsSync(dbPath)) {
    return createDatabase(dbPath);
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export function rebuildIndex(vaultRoot: string, config: GraniteConfig, db: Database.Database): void {
  const notes = listNotes(vaultRoot, config);

  db.exec('DELETE FROM links');
  db.exec('DELETE FROM notes');
  // Rebuild FTS
  db.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");

  const insertNote = db.prepare(`
    INSERT INTO notes (slug, id, title, type, created, modified, tags, aliases, body, filepath, status, source)
    VALUES (@slug, @id, @title, @type, @created, @modified, @tags, @aliases, @body, @filepath, @status, @source)
  `);

  const insertLink = db.prepare(`
    INSERT INTO links (source_slug, target_slug, target_raw, context)
    VALUES (@source_slug, @target_slug, @target_raw, @context)
  `);

  const transaction = db.transaction(() => {
    for (const note of notes) {
      insertNote.run({
        slug: note.slug,
        id: note.frontmatter.id,
        title: note.frontmatter.title,
        type: note.frontmatter.type,
        created: note.frontmatter.created,
        modified: note.frontmatter.modified,
        tags: JSON.stringify(note.frontmatter.tags),
        aliases: JSON.stringify(note.frontmatter.aliases),
        body: note.body,
        filepath: note.filepath,
        status: note.frontmatter.status ?? 'active',
        source: note.frontmatter.source ?? 'human',
      });

      // Parse and resolve wikilinks
      const links = parseWikilinks(note.body);
      const resolved = resolveWikilinks(links, notes);

      for (const link of resolved) {
        // Find context line
        const bodyLines = note.body.split('\n');
        const contextLine = bodyLines.find(l => l.includes(link.raw)) ?? '';

        insertLink.run({
          source_slug: note.slug,
          target_slug: link.resolved_slug ?? null,
          target_raw: link.target,
          context: contextLine.trim(),
        });
      }
    }

    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_rebuild', new Date().toISOString());
  });

  transaction();
}

export function ensureIndex(vaultRoot: string, config: GraniteConfig): Database.Database {
  const db = openDatabase(vaultRoot);

  if (config.index.auto_rebuild) {
    rebuildIndex(vaultRoot, config, db);
  }

  return db;
}
