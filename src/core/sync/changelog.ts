import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ChangelogEntry, SyncOperation } from '../types.js';

const SYNC_DB_FILE = 'sync.db';

const SYNC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS changelog (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id     TEXT NOT NULL,
  operation   TEXT NOT NULL,
  timestamp   TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  synced      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_changelog_note_id ON changelog(note_id);
CREATE INDEX IF NOT EXISTS idx_changelog_synced ON changelog(synced);

CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

function getSyncDbPath(vaultRoot: string): string {
  const graniteDir = path.join(vaultRoot, '.granite');
  fs.mkdirSync(graniteDir, { recursive: true });
  return path.join(graniteDir, SYNC_DB_FILE);
}

export function openSyncDb(vaultRoot: string): Database.Database {
  const dbPath = getSyncDbPath(vaultRoot);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SYNC_SCHEMA_SQL);
  return db;
}

export function computeChecksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function recordChange(
  db: Database.Database,
  noteId: string,
  operation: SyncOperation,
  deviceId: string,
  fileContent: string,
): ChangelogEntry {
  const now = new Date().toISOString();
  const checksum = computeChecksum(fileContent);

  const stmt = db.prepare(`
    INSERT INTO changelog (note_id, operation, timestamp, device_id, checksum, synced)
    VALUES (?, ?, ?, ?, ?, 0)
  `);
  const result = stmt.run(noteId, operation, now, deviceId, checksum);

  return {
    seq: result.lastInsertRowid as number,
    note_id: noteId,
    operation,
    timestamp: now,
    device_id: deviceId,
    checksum,
    synced: false,
  };
}

export function getPendingChanges(db: Database.Database): ChangelogEntry[] {
  return db.prepare('SELECT * FROM changelog WHERE synced = 0 ORDER BY seq ASC').all() as ChangelogEntry[];
}

export function markChangesSynced(db: Database.Database, upToSeq: number): void {
  db.prepare('UPDATE changelog SET synced = 1 WHERE seq <= ?').run(upToSeq);
}

export function getLastServerSeq(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_server_seq'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function setLastServerSeq(db: Database.Database, seq: number): void {
  db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_server_seq', ?)").run(String(seq));
}

export function getLastSyncTime(db: Database.Database): string | null {
  const row = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_sync'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function setLastSyncTime(db: Database.Database): void {
  db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync', ?)").run(new Date().toISOString());
}

export function getPendingCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as c FROM changelog WHERE synced = 0').get() as { c: number };
  return row.c;
}
