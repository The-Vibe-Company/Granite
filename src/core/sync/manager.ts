import fs from 'node:fs';
import path from 'node:path';
import type { GraniteConfig, Note, SyncChange, SyncConfig, SyncOperation, SyncStatus } from '../types.js';
import { findNoteBySlug, listNotes, readNote } from '../note.js';
import { parseFrontmatter, serializeFrontmatter } from '../frontmatter.js';
import { SyncClient } from './client.js';
import { getDeviceId, getOrCreateDeviceId } from './device.js';
import {
  computeChecksum,
  getLastServerSeq,
  getLastSyncTime,
  getPendingChanges,
  getPendingCount,
  markChangesSynced,
  openSyncDb,
  recordChange,
  setLastServerSeq,
  setLastSyncTime,
} from './changelog.js';
import { detectConflict, listConflicts, resolveConflict } from './conflict.js';

export class SyncManager {
  private vaultRoot: string;
  private config: GraniteConfig;
  private syncConfig: SyncConfig;
  private client: SyncClient;
  private deviceId: string;

  constructor(vaultRoot: string, config: GraniteConfig) {
    if (!config.sync?.enabled) {
      throw new Error('Sync is not enabled. Add a sync section to granite.yml.');
    }
    this.vaultRoot = vaultRoot;
    this.config = config;
    this.syncConfig = config.sync;
    this.client = new SyncClient(this.syncConfig);
    this.deviceId = getDeviceId(vaultRoot);
  }

  /**
   * Track a local mutation and push it in the background (fire-and-forget).
   * This is the hook called after every note create/update/delete.
   */
  trackAndPush(note: Note, operation: SyncOperation): void {
    const db = openSyncDb(this.vaultRoot);
    try {
      const content = fs.existsSync(note.filepath)
        ? fs.readFileSync(note.filepath, 'utf-8')
        : '';
      recordChange(db, note.frontmatter.id, operation, this.deviceId, content);
    } finally {
      db.close();
    }

    // Fire-and-forget push — don't block the CLI
    this.push().catch(() => {
      // Silently fail — will retry on next operation or manual sync
    });
  }

  /**
   * Push all pending local changes to the relay server.
   */
  async push(): Promise<{ pushed: number; server_seq: number }> {
    const db = openSyncDb(this.vaultRoot);
    try {
      const pending = getPendingChanges(db);
      if (pending.length === 0) {
        return { pushed: 0, server_seq: getLastServerSeq(db) };
      }

      const changes: SyncChange[] = [];
      for (const entry of pending) {
        const note = this.findNoteById(entry.note_id);
        changes.push({
          note_id: entry.note_id,
          operation: entry.operation as SyncOperation,
          timestamp: entry.timestamp,
          checksum: entry.checksum,
          slug: note?.slug ?? '',
          frontmatter: note?.frontmatter,
          body: note?.body,
        });
      }

      const lastSeq = getLastServerSeq(db);
      const result = await this.client.push({
        device_id: this.deviceId,
        last_server_seq: lastSeq,
        changes,
      });

      const maxSeq = Math.max(...pending.map(p => p.seq));
      markChangesSynced(db, maxSeq);
      setLastServerSeq(db, result.server_seq);
      setLastSyncTime(db);

      return { pushed: result.accepted, server_seq: result.server_seq };
    } finally {
      db.close();
    }
  }

  /**
   * Pull remote changes and apply them locally.
   */
  async pull(): Promise<{ applied: number; conflicts: number }> {
    const db = openSyncDb(this.vaultRoot);
    try {
      const lastSeq = getLastServerSeq(db);
      const response = await this.client.pull(lastSeq, this.deviceId);

      let applied = 0;
      let conflicts = 0;

      for (const change of response.changes) {
        const result = this.applyRemoteChange(change);
        if (result === 'applied') applied++;
        if (result === 'conflict') conflicts++;
      }

      setLastServerSeq(db, response.server_seq);
      setLastSyncTime(db);

      return { applied, conflicts };
    } finally {
      db.close();
    }
  }

  /**
   * Quick pull with a tight timeout — used before read commands.
   * Returns silently if server is unreachable.
   */
  async quickPull(): Promise<void> {
    const db = openSyncDb(this.vaultRoot);
    try {
      const lastSeq = getLastServerSeq(db);
      const response = await this.client.quickPull(lastSeq, this.deviceId);
      if (!response) return;

      for (const change of response.changes) {
        this.applyRemoteChange(change);
      }

      setLastServerSeq(db, response.server_seq);
      setLastSyncTime(db);
    } finally {
      db.close();
    }
  }

  /**
   * Full bidirectional sync: push then pull.
   */
  async sync(): Promise<{ pushed: number; pulled: number; conflicts: number }> {
    const pushResult = await this.push();
    const pullResult = await this.pull();
    return {
      pushed: pushResult.pushed,
      pulled: pullResult.applied,
      conflicts: pullResult.conflicts,
    };
  }

  /**
   * Get current sync status.
   */
  status(): SyncStatus {
    const db = openSyncDb(this.vaultRoot);
    try {
      const deviceInfo = getOrCreateDeviceId(this.vaultRoot);
      return {
        device_id: deviceInfo.device_id,
        device_name: deviceInfo.device_name,
        last_sync: getLastSyncTime(db),
        pending_changes: getPendingCount(db),
        server_seq: getLastServerSeq(db),
      };
    } finally {
      db.close();
    }
  }

  /**
   * List connected devices.
   */
  async devices(): Promise<Array<{ device_id: string; device_name: string; last_seen: string }>> {
    return this.client.listDevices();
  }

  /**
   * List unresolved conflict files.
   */
  conflicts(): string[] {
    return listConflicts(this.vaultRoot);
  }

  private applyRemoteChange(change: SyncChange): 'applied' | 'conflict' | 'skipped' {
    switch (change.operation) {
      case 'create':
        return this.applyRemoteCreate(change);
      case 'update':
        return this.applyRemoteUpdate(change);
      case 'delete':
        return this.applyRemoteDelete(change);
      default:
        return 'skipped';
    }
  }

  private applyRemoteCreate(change: SyncChange): 'applied' | 'skipped' {
    if (!change.frontmatter || change.body === undefined) return 'skipped';

    // Check if note already exists locally (by id)
    const existing = this.findNoteById(change.note_id);
    if (existing) return 'skipped'; // Already have it

    const typeConfig = this.config.note_types[change.frontmatter.type];
    if (!typeConfig) return 'skipped';

    const folder = path.join(this.vaultRoot, typeConfig.folder);
    fs.mkdirSync(folder, { recursive: true });

    const slug = change.slug || change.note_id;
    const filepath = path.join(folder, `${slug}.md`);
    const content = serializeFrontmatter(change.frontmatter, change.body);
    fs.writeFileSync(filepath, content, 'utf-8');

    return 'applied';
  }

  private applyRemoteUpdate(change: SyncChange): 'applied' | 'conflict' | 'skipped' {
    if (!change.frontmatter || change.body === undefined) return 'skipped';

    const localNote = this.findNoteById(change.note_id);
    if (!localNote) {
      // Note doesn't exist locally — treat as create
      return this.applyRemoteCreate(change);
    }

    // Check for conflict
    const localContent = fs.readFileSync(localNote.filepath, 'utf-8');
    const localChecksum = computeChecksum(localContent);

    if (localChecksum === change.checksum) return 'skipped'; // Already identical

    if (detectConflict(localNote, change)) {
      resolveConflict(this.vaultRoot, localNote, change, this.deviceId);

      // LWW: apply whichever is newer
      const localTime = new Date(localNote.frontmatter.modified).getTime();
      const remoteTime = new Date(change.frontmatter.modified).getTime();

      if (remoteTime > localTime) {
        const content = serializeFrontmatter(change.frontmatter, change.body);
        fs.writeFileSync(localNote.filepath, content, 'utf-8');
      }

      return 'conflict';
    }

    // No conflict — apply remote
    const content = serializeFrontmatter(change.frontmatter, change.body);
    fs.writeFileSync(localNote.filepath, content, 'utf-8');
    return 'applied';
  }

  private applyRemoteDelete(change: SyncChange): 'applied' | 'skipped' {
    const localNote = this.findNoteById(change.note_id);
    if (!localNote) return 'skipped';

    if (fs.existsSync(localNote.filepath)) {
      fs.unlinkSync(localNote.filepath);
    }
    return 'applied';
  }

  private findNoteById(noteId: string): Note | null {
    const allNotes = listNotes(this.vaultRoot, this.config);
    return allNotes.find(n => n.frontmatter.id === noteId) ?? null;
  }
}

/**
 * Create a SyncManager if sync is enabled, otherwise return null.
 * This is the safe entry point used by the transparent hooks.
 */
export function getSyncManager(vaultRoot: string, config: GraniteConfig): SyncManager | null {
  if (!config.sync?.enabled) return null;
  try {
    return new SyncManager(vaultRoot, config);
  } catch {
    return null;
  }
}
