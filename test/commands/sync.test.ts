import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSyncApp } from '../../src/commands/sync.js';
import { loadSyncState, readSyncFilePayload, saveSyncState, type SyncFilePayload } from '../../src/core/sync.js';

describe('sync command transport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-sync-command-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires the local sync token for direct HTTP sync', async () => {
    const app = createSyncApp(tmpDir);
    const response = await app.request('/sync/manifest');

    expect(response.status).toBe(401);
  });

  it('allows health checks without a sync token', async () => {
    const app = createSyncApp(tmpDir);
    const response = await app.request('/sync/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('rejects sync tokens passed in query strings', async () => {
    const state = loadSyncState(tmpDir);
    const app = createSyncApp(tmpDir);

    const response = await app.request(`/sync/manifest?token=${state.local_token}`);

    expect(response.status).toBe(401);
  });

  it('serves manifests without detecting deletions as a read side effect', async () => {
    const state = loadSyncState(tmpDir);
    const notePath = path.join(tmpDir, 'notes/notes/local.md');
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, 'local content\n', 'utf-8');
    const payload = readSyncFilePayload(tmpDir, 'notes/notes/local.md', state);
    state.baselines[payload.path] = { hash: payload.hash, modified: payload.modified };
    saveSyncState(tmpDir, state);
    fs.unlinkSync(notePath);

    const app = createSyncApp(tmpDir);
    const response = await app.request('/sync/manifest', {
      headers: { Authorization: `Bearer ${state.local_token}` },
    });
    const after = loadSyncState(tmpDir);

    expect(response.status).toBe(200);
    expect(after.tombstones['notes/notes/local.md']).toBeUndefined();
  });

  it('accepts an incoming file over the direct sync API', async () => {
    const state = loadSyncState(tmpDir);
    const app = createSyncApp(tmpDir);
    const content = 'remote note\n';
    const payload: SyncFilePayload = {
      path: 'notes/notes/remote.md',
      hash: sha(content),
      size: Buffer.byteLength(content),
      modified: '2026-05-28T12:00:00.000Z',
      device_id: 'remote',
      content_base64: Buffer.from(content).toString('base64'),
      base_hash: null,
    };

    const response = await app.request('/sync/file', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.local_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: 'notes/notes/remote.md', action: 'created' });
    expect(fs.readFileSync(path.join(tmpDir, 'notes/notes/remote.md'), 'utf-8')).toBe(content);
  });

  it('preserves existing files when delete payload hashes are unknown', async () => {
    const state = loadSyncState(tmpDir);
    const notePath = path.join(tmpDir, 'notes/notes/local.md');
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, 'local content\n', 'utf-8');
    const app = createSyncApp(tmpDir);

    const response = await app.request('/sync/delete', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.local_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: 'notes/notes/local.md',
        hash: sha('forged content\n'),
        deleted_at: '2026-05-28T12:00:00.000Z',
        device_id: 'remote-primary',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      path: 'notes/notes/local.md',
      action: 'delete_rejected_unknown_hash',
    });
    expect(fs.readFileSync(notePath, 'utf-8')).toBe('local content\n');
  });

  it('treats unknown deletes for absent files as idempotent skips', async () => {
    const state = loadSyncState(tmpDir);
    const app = createSyncApp(tmpDir);

    const response = await app.request('/sync/delete', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.local_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: 'notes/notes/missing.md',
        hash: sha('unknown content\n'),
        deleted_at: '2026-05-28T12:00:00.000Z',
        device_id: 'remote',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      path: 'notes/notes/missing.md',
      action: 'delete_ignored_missing',
    });
  });
});

function sha(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
