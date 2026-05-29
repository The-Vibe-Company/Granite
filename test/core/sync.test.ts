import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyIncomingDeletion,
  applyIncomingFile,
  buildSyncManifest,
  createDefaultSyncState,
  detectLocalDeletions,
  grantSyncAccess,
  getSyncStatePath,
  loadSyncState,
  normalizeRemoteUrl,
  readSyncFilePayload,
  resolveSyncAccessRole,
  revokeSyncAccess,
  saveSyncState,
  type SyncFilePayload,
  type SyncState,
} from '../../src/core/sync.js';

describe('sync core', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-sync-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds a vault manifest without derived local state', () => {
    writeFile('granite.yml', 'vault_name: Test\n');
    writeFile('notes/notes/example.md', '# Example\n');
    writeFile('.granite/index.db', 'derived');
    writeFile('.granite/sync.json', '{}');

    const state = createState('local');
    const manifest = buildSyncManifest(tmpDir, state);

    expect(manifest.files.map(file => file.path)).toEqual([
      'granite.yml',
      'notes/notes/example.md',
    ]);
  });

  it('normalizes remote addresses for direct machine sync', () => {
    expect(normalizeRemoteUrl('100.64.0.10', '8765')).toBe('http://100.64.0.10:8765');
    expect(normalizeRemoteUrl('http://macbook.tailnet.ts.net:8765/sync')).toBe('http://macbook.tailnet.ts.net:8765');
  });

  it('migrates the legacy local sync token as write access', () => {
    writeFile('.granite/sync.json', JSON.stringify({
      version: 1,
      device_id: 'legacy-device',
      device_name: 'legacy',
      local_token: 'legacy-token',
      conflict_policy: 'manual',
      primary_device_id: 'legacy-device',
      remotes: {},
      baselines: {},
      tombstones: {},
    }));

    const state = loadSyncState(tmpDir);

    expect(resolveSyncAccessRole(state, 'legacy-token')).toBe('write');
    expect(Object.values(state.access_tokens)).toContainEqual(expect.objectContaining({
      token: 'legacy-token',
      role: 'write',
    }));
  });

  it('recovers legacy local token when access token state is malformed', () => {
    writeFile('.granite/sync.json', JSON.stringify({
      version: 1,
      device_id: 'legacy-device',
      device_name: 'legacy',
      local_token: 'legacy-token',
      conflict_policy: 'manual',
      primary_device_id: 'legacy-device',
      remotes: {},
      access_tokens: { default: { token: '', role: 'read' } },
      baselines: {},
      tombstones: {},
    }));

    const state = loadSyncState(tmpDir);

    expect(resolveSyncAccessRole(state, 'legacy-token')).toBe('write');
  });

  it('grants and revokes named read/write sync access tokens', () => {
    const state = createState('local');
    const readGrant = grantSyncAccess(state, 'ipad', 'read', new Date('2026-05-28T12:00:00.000Z'));
    const writeGrant = grantSyncAccess(state, 'desktop', 'write', new Date('2026-05-28T12:01:00.000Z'));

    expect(resolveSyncAccessRole(state, readGrant.token)).toBe('read');
    expect(resolveSyncAccessRole(state, writeGrant.token)).toBe('write');
    expect(revokeSyncAccess(state, 'ipad')).toBe(true);
    expect(resolveSyncAccessRole(state, readGrant.token)).toBeNull();
    expect(revokeSyncAccess(state, 'missing')).toBe(false);
  });

  it('recovers legacy local token when access token state is empty', () => {
    writeFile('.granite/sync.json', JSON.stringify({
      version: 1,
      device_id: 'legacy-device',
      device_name: 'legacy',
      local_token: 'legacy-token',
      conflict_policy: 'manual',
      primary_device_id: 'legacy-device',
      remotes: {},
      access_tokens: {},
      baselines: {},
      tombstones: {},
    }));

    const state = loadSyncState(tmpDir);

    expect(resolveSyncAccessRole(state, 'legacy-token')).toBe('write');
  });

  it('persists revocation of named sync access tokens', () => {
    const state = createState('local');
    const readGrant = grantSyncAccess(state, 'reader', 'read');
    expect(revokeSyncAccess(state, 'reader')).toBe(true);
    saveSyncState(tmpDir, state);

    const reloaded = loadSyncState(tmpDir);

    expect(resolveSyncAccessRole(reloaded, readGrant.token)).toBeNull();
  });

  it('creates a conflict copy when both devices changed the same file manually', () => {
    writeFile('notes/notes/topic.md', 'local change\n');
    const state = createState('local');
    state.conflict_policy = 'manual';
    state.baselines['notes/notes/topic.md'] = {
      hash: sha('base\n'),
      modified: '2026-05-28T00:00:00.000Z',
    };

    const incoming = payload('notes/notes/topic.md', 'remote change\n', 'remote', sha('base\n'));
    const result = applyIncomingFile(tmpDir, state, incoming, new Date('2026-05-28T12:00:00.000Z'));

    expect(result.action).toBe('conflict_copy_created');
    expect(result.conflict_path).toBe('notes/notes/topic.conflict.remote.20260528T120000Z.md');
    expect(readFile('notes/notes/topic.md')).toBe('local change\n');
    expect(readFile(result.conflict_path!)).toBe('remote change\n');
  });

  it('rejects malformed base64 file payloads before writing', () => {
    const state = createState('local');
    const incoming = payload('notes/notes/topic.md', '', 'remote', null);
    incoming.content_base64 = '!!!!';
    incoming.hash = sha('');

    expect(() => applyIncomingFile(tmpDir, state, incoming)).toThrow('Invalid base64 content');
    expect(fs.existsSync(path.join(tmpDir, 'notes/notes/topic.md'))).toBe(false);
  });

  it('lets the primary incoming device win a conflict', () => {
    writeFile('notes/notes/topic.md', 'local change\n');
    const state = createState('local');
    state.conflict_policy = 'primary_wins';
    state.primary_device_id = 'remote';
    state.baselines['notes/notes/topic.md'] = {
      hash: sha('base\n'),
      modified: '2026-05-28T00:00:00.000Z',
    };

    const incoming = payload('notes/notes/topic.md', 'remote change\n', 'remote', sha('base\n'));
    const result = applyIncomingFile(tmpDir, state, incoming);

    expect(result.action).toBe('overwrote_local_primary');
    expect(readFile('notes/notes/topic.md')).toBe('remote change\n');
    expect(state.baselines['notes/notes/topic.md'].hash).toBe(sha('remote change\n'));
  });

  it('keeps a local edit when the incoming file is unchanged from baseline', () => {
    writeFile('notes/notes/topic.md', 'local change\n');
    const state = createState('local');
    state.baselines['notes/notes/topic.md'] = {
      hash: sha('base\n'),
      modified: '2026-05-28T00:00:00.000Z',
    };

    const incoming = payload('notes/notes/topic.md', 'base\n', 'remote', sha('base\n'));
    const result = applyIncomingFile(tmpDir, state, incoming);

    expect(result.action).toBe('unchanged');
    expect(readFile('notes/notes/topic.md')).toBe('local change\n');
  });

  it('keeps the local primary file and preserves the incoming version as a conflict copy', () => {
    writeFile('notes/notes/topic.md', 'local primary\n');
    const state = createState('local');
    state.conflict_policy = 'primary_wins';
    state.primary_device_id = 'local';
    state.baselines['notes/notes/topic.md'] = {
      hash: sha('base\n'),
      modified: '2026-05-28T00:00:00.000Z',
    };

    const incoming = payload('notes/notes/topic.md', 'remote change\n', 'remote', sha('base\n'));
    const result = applyIncomingFile(tmpDir, state, incoming, new Date('2026-05-28T12:00:00.000Z'));

    expect(result.action).toBe('kept_local_primary');
    expect(readFile('notes/notes/topic.md')).toBe('local primary\n');
    expect(readFile(result.conflict_path!)).toBe('remote change\n');
  });

  it('does not let a primary deletion remove a file when the deleted hash is unknown', () => {
    writeFile('notes/notes/topic.md', 'local change\n');
    const state = createState('local');
    state.conflict_policy = 'primary_wins';
    state.primary_device_id = 'remote';

    const result = applyIncomingDeletion(tmpDir, state, {
      path: 'notes/notes/topic.md',
      hash: sha('unknown remote base\n'),
      deleted_at: '2026-05-28T13:00:00.000Z',
      device_id: 'remote',
    }, new Date('2026-05-28T14:00:00.000Z'));

    expect(result.action).toBe('delete_rejected_unknown_hash');
    expect(readFile('notes/notes/topic.md')).toBe('local change\n');
  });

  it('records tombstones for files deleted after a sync baseline', () => {
    writeFile('notes/notes/topic.md', 'content\n');
    const state = loadSyncState(tmpDir);
    const file = readSyncFilePayload(tmpDir, 'notes/notes/topic.md', state);
    state.baselines[file.path] = { hash: file.hash, modified: file.modified };
    saveSyncState(tmpDir, state);

    fs.unlinkSync(path.join(tmpDir, 'notes/notes/topic.md'));
    expect(detectLocalDeletions(tmpDir, state, new Date('2026-05-28T12:00:00.000Z'))).toBe(true);

    expect(state.tombstones['notes/notes/topic.md']).toEqual({
      hash: file.hash,
      deleted_at: '2026-05-28T12:00:00.000Z',
      device_id: state.device_id,
    });
  });

  it('does not resurrect a locally deleted file when the remote file is unchanged', () => {
    const state = createState('local');
    state.tombstones['notes/notes/topic.md'] = {
      hash: sha('old content\n'),
      deleted_at: '2026-05-28T12:00:00.000Z',
      device_id: 'local',
    };

    const incoming = payload('notes/notes/topic.md', 'old content\n', 'remote', sha('old content\n'));
    const result = applyIncomingFile(tmpDir, state, incoming);

    expect(result.action).toBe('unchanged');
    expect(fs.existsSync(path.join(tmpDir, 'notes/notes/topic.md'))).toBe(false);
    expect(state.tombstones['notes/notes/topic.md']).toBeDefined();
  });

  it('records handled deletion conflicts without publishing a tombstone for the live file', () => {
    writeFile('notes/notes/topic.md', 'local change\n');
    const state = createState('local');
    state.baselines['notes/notes/topic.md'] = {
      hash: sha('base\n'),
      modified: '2026-05-28T00:00:00.000Z',
    };
    const deletion = {
      path: 'notes/notes/topic.md',
      hash: sha('base\n'),
      deleted_at: '2026-05-28T13:00:00.000Z',
      device_id: 'remote',
      base_hash: sha('base\n'),
    };

    const first = applyIncomingDeletion(tmpDir, state, deletion, new Date('2026-05-28T14:00:00.000Z'));
    const second = applyIncomingDeletion(tmpDir, state, deletion, new Date('2026-05-28T14:01:00.000Z'));
    const manifest = buildSyncManifest(tmpDir, state);

    expect(first.action).toBe('delete_conflict_copy_created');
    expect(second.action).toBe('delete_ignored_missing');
    expect(fs.existsSync(path.join(tmpDir, 'notes/notes/topic.md'))).toBe(false);
    expect(manifest.files.map(file => file.path)).not.toContain('notes/notes/topic.md');
    expect(manifest.files.some(file => file.path.includes('.conflict.remote.'))).toBe(true);
    expect(manifest.deletions.map(item => item.path)).toContain('notes/notes/topic.md');
  });

  it('recovers from a malformed sync state file without touching vault content', () => {
    writeFile('notes/notes/topic.md', 'content\n');
    const statePath = getSyncStatePath(tmpDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{not-json', 'utf-8');

    const state = loadSyncState(tmpDir);
    const backups = fs.readdirSync(path.dirname(statePath)).filter(name => name.startsWith('sync.json.corrupt.'));

    expect(state.device_id).toMatch(/^dev_/);
    expect(backups).toHaveLength(1);
    expect(readFile('notes/notes/topic.md')).toBe('content\n');
  });

  function writeFile(relativePath: string, content: string): void {
    const fullPath = path.join(tmpDir, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  function readFile(relativePath: string): string {
    return fs.readFileSync(path.join(tmpDir, ...relativePath.split('/')), 'utf-8');
  }
});

function createState(deviceId: string): SyncState {
  const state = createDefaultSyncState();
  state.device_id = deviceId;
  state.device_name = deviceId;
  state.primary_device_id = deviceId;
  return state;
}

function payload(
  relativePath: string,
  content: string,
  deviceId: string,
  baseHash: string | null,
): SyncFilePayload {
  return {
    path: relativePath,
    hash: sha(content),
    size: Buffer.byteLength(content),
    modified: '2026-05-28T10:00:00.000Z',
    device_id: deviceId,
    content_base64: Buffer.from(content).toString('base64'),
    base_hash: baseHash,
  };
}

function sha(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
