import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNote, readNote, listNotes } from '../../src/core/note.js';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { serializeFrontmatter } from '../../src/core/frontmatter.js';
import type { GraniteConfig, SyncChange } from '../../src/core/types.js';
import { getOrCreateDeviceId, getDeviceId } from '../../src/core/sync/device.js';
import {
  openSyncDb,
  recordChange,
  getPendingChanges,
  markChangesSynced,
  computeChecksum,
  getLastServerSeq,
  setLastServerSeq,
  getPendingCount,
} from '../../src/core/sync/changelog.js';
import { detectConflict, listConflicts, resolveConflict, clearResolvedConflicts } from '../../src/core/sync/conflict.js';
import { getSyncManager } from '../../src/core/sync/manager.js';

describe('sync/device', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-sync-'));
    fs.mkdirSync(path.join(tmpDir, '.granite'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a device ID on first call and persists it', () => {
    const info = getOrCreateDeviceId(tmpDir);
    expect(info.device_id).toBeTruthy();
    expect(info.device_name).toBeTruthy();
    expect(info.created).toBeTruthy();

    // Second call returns same ID
    const info2 = getOrCreateDeviceId(tmpDir);
    expect(info2.device_id).toBe(info.device_id);
  });

  it('getDeviceId returns the same id', () => {
    const id1 = getDeviceId(tmpDir);
    const id2 = getDeviceId(tmpDir);
    expect(id1).toBe(id2);
  });

  it('respects custom device name', () => {
    const info = getOrCreateDeviceId(tmpDir, 'my-laptop');
    expect(info.device_name).toBe('my-laptop');
  });
});

describe('sync/changelog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-sync-'));
    fs.mkdirSync(path.join(tmpDir, '.granite'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records a change and retrieves it as pending', () => {
    const db = openSyncDb(tmpDir);
    try {
      const entry = recordChange(db, 'note-uuid-1', 'create', 'device-1', 'some content');
      expect(entry.note_id).toBe('note-uuid-1');
      expect(entry.operation).toBe('create');
      expect(entry.synced).toBe(false);

      const pending = getPendingChanges(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].note_id).toBe('note-uuid-1');
    } finally {
      db.close();
    }
  });

  it('marks changes as synced', () => {
    const db = openSyncDb(tmpDir);
    try {
      const e1 = recordChange(db, 'note-1', 'create', 'device-1', 'content 1');
      const e2 = recordChange(db, 'note-2', 'create', 'device-1', 'content 2');

      markChangesSynced(db, e1.seq);

      const pending = getPendingChanges(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].note_id).toBe('note-2');
    } finally {
      db.close();
    }
  });

  it('computes consistent checksums', () => {
    const c1 = computeChecksum('hello world');
    const c2 = computeChecksum('hello world');
    const c3 = computeChecksum('different');

    expect(c1).toBe(c2);
    expect(c1).not.toBe(c3);
    expect(c1).toHaveLength(64); // SHA-256 hex
  });

  it('tracks server seq', () => {
    const db = openSyncDb(tmpDir);
    try {
      expect(getLastServerSeq(db)).toBe(0);
      setLastServerSeq(db, 42);
      expect(getLastServerSeq(db)).toBe(42);
    } finally {
      db.close();
    }
  });

  it('counts pending changes', () => {
    const db = openSyncDb(tmpDir);
    try {
      expect(getPendingCount(db)).toBe(0);
      recordChange(db, 'note-1', 'create', 'device-1', 'c1');
      recordChange(db, 'note-2', 'update', 'device-1', 'c2');
      expect(getPendingCount(db)).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('sync/conflict', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-sync-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const tc of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, tc.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects a conflict when both local and remote are modified', () => {
    const note = createNote(tmpDir, config, 'note', 'Conflict Test');
    const remoteChange: SyncChange = {
      note_id: note.frontmatter.id,
      operation: 'update',
      timestamp: new Date().toISOString(),
      checksum: 'different-checksum',
      slug: note.slug,
      frontmatter: {
        ...note.frontmatter,
        modified: new Date(Date.now() + 60000).toISOString(), // 1 min later
      },
      body: 'Remote body content',
    };

    expect(detectConflict(note, remoteChange)).toBe(true);
  });

  it('does not detect conflict for delete operations', () => {
    const note = createNote(tmpDir, config, 'note', 'Delete Test');
    const remoteChange: SyncChange = {
      note_id: note.frontmatter.id,
      operation: 'delete',
      timestamp: new Date().toISOString(),
      checksum: '',
      slug: note.slug,
    };

    expect(detectConflict(note, remoteChange)).toBe(false);
  });

  it('resolves conflict with LWW and saves backup', () => {
    const note = createNote(tmpDir, config, 'note', 'LWW Test');
    const remoteChange: SyncChange = {
      note_id: note.frontmatter.id,
      operation: 'update',
      timestamp: new Date().toISOString(),
      checksum: 'remote-checksum',
      slug: note.slug,
      frontmatter: {
        ...note.frontmatter,
        modified: new Date(Date.now() + 60000).toISOString(),
      },
      body: 'Remote wins body',
    };

    const conflict = resolveConflict(tmpDir, note, remoteChange, 'device-1');
    expect(conflict).not.toBeNull();
    expect(conflict!.resolved).toBe(true);
    expect(fs.existsSync(conflict!.conflict_file)).toBe(true);
  });

  it('lists and clears conflicts', () => {
    // Create a conflict file manually
    const conflictsDir = path.join(tmpDir, '.granite', 'conflicts');
    fs.mkdirSync(conflictsDir, { recursive: true });
    fs.writeFileSync(path.join(conflictsDir, 'test_conflict.md'), 'backup content');

    const files = listConflicts(tmpDir);
    expect(files).toHaveLength(1);

    const cleared = clearResolvedConflicts(tmpDir);
    expect(cleared).toBe(1);

    expect(listConflicts(tmpDir)).toHaveLength(0);
  });
});

describe('sync/manager', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-sync-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const tc of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, tc.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getSyncManager returns null when sync is disabled', () => {
    const manager = getSyncManager(tmpDir, config);
    expect(manager).toBeNull();
  });

  it('getSyncManager returns manager when sync is enabled', () => {
    const syncConfig: GraniteConfig = {
      ...config,
      sync: {
        enabled: true,
        server: 'https://sync.example.com',
        api_key: 'test-key',
        device_name: 'test-device',
        auto_sync: true,
        interval: 30,
      },
    };
    const manager = getSyncManager(tmpDir, syncConfig);
    expect(manager).not.toBeNull();
  });

  it('trackAndPush records change in changelog without throwing', () => {
    const syncConfig: GraniteConfig = {
      ...config,
      sync: {
        enabled: true,
        server: 'https://sync.example.com',
        api_key: 'test-key',
        device_name: 'test-device',
        auto_sync: true,
        interval: 30,
      },
    };
    const manager = getSyncManager(tmpDir, syncConfig)!;
    const note = createNote(tmpDir, config, 'note', 'Sync Track Test');

    // Should not throw even though server is unreachable
    expect(() => manager.trackAndPush(note, 'create')).not.toThrow();

    // Verify it was recorded in the changelog
    const db = openSyncDb(tmpDir);
    try {
      const pending = getPendingChanges(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].note_id).toBe(note.frontmatter.id);
      expect(pending[0].operation).toBe('create');
    } finally {
      db.close();
    }
  });

  it('status returns device info and pending count', () => {
    const syncConfig: GraniteConfig = {
      ...config,
      sync: {
        enabled: true,
        server: 'https://sync.example.com',
        api_key: 'test-key',
        device_name: 'test-device',
        auto_sync: true,
        interval: 30,
      },
    };
    const manager = getSyncManager(tmpDir, syncConfig)!;
    const status = manager.status();

    expect(status.device_id).toBeTruthy();
    expect(status.pending_changes).toBe(0);
    expect(status.last_sync).toBeNull();
  });
});
