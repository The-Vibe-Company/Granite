import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadConfig } from '../core/config.js';
import { openDatabase, rebuildIndex } from '../core/index-db.js';
import { requireVaultRoot } from '../core/vault.js';
import { jsonSuccess } from '../core/json-output.js';
import {
  applyIncomingDeletion,
  applyIncomingFile,
  buildSyncManifest,
  detectLocalDeletions,
  getSyncFileHash,
  getSyncStatePath,
  loadSyncState,
  markBaseline,
  normalizeSyncPath,
  normalizeRemoteUrl,
  readSyncFilePayload,
  saveSyncState,
  setSyncConflictPolicy,
  suggestedRemoteName,
  type SyncApplyAction,
  type SyncApplyResult,
  type SyncConflictPolicy,
  type SyncDeletionPayload,
  type SyncFilePayload,
  type SyncManifest,
  type SyncRemote,
  type SyncState,
} from '../core/sync.js';

const DEFAULT_SYNC_PORT = 8765;

interface CommonOptions {
  vault?: string;
  json?: boolean;
}

interface SyncServeOptions extends CommonOptions {
  host?: string;
  port?: string;
}

interface SyncConfigOptions extends CommonOptions {
  policy?: string;
  primaryDevice?: string;
  primaryThisDevice?: boolean;
}

interface SyncRemoteAddOptions extends CommonOptions {
  port?: string;
  token?: string;
}

interface SyncRemoteOptions extends CommonOptions {
  token?: string;
  quiet?: boolean;
}

interface SyncWatchOptions extends CommonOptions {
  interval?: string;
}

interface SyncSummary {
  remote: string;
  direction: 'pull' | 'push' | 'run';
  checked: number;
  changed: number;
  skipped: number;
  conflicts: number;
  deleted: number;
  actions: SyncApplyResult[];
}

export function syncStatusCommand(options: CommonOptions = {}): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const state = loadSyncState(vaultRoot);
  const manifest = withDetectedDeletions(vaultRoot, state);

  if (options.json) {
    console.log(jsonSuccess({
      vault: vaultRoot,
      state_file: getSyncStatePath(vaultRoot),
      device_id: state.device_id,
      device_name: state.device_name,
      local_token: state.local_token,
      conflict_policy: state.conflict_policy,
      primary_device_id: state.primary_device_id,
      remotes: state.remotes,
      files: manifest.files.length,
      deletions: manifest.deletions.length,
    }));
    return;
  }

  console.log('Granite sync');
  console.log(`  Vault:          ${vaultRoot}`);
  console.log(`  Device:         ${state.device_name} (${state.device_id})`);
  console.log(`  Token:          ${state.local_token}`);
  console.log(`  Policy:         ${formatPolicy(state)}`);
  console.log(`  Files:          ${manifest.files.length}`);
  if (manifest.deletions.length > 0) {
    console.log(`  Pending deletes:${manifest.deletions.length}`);
  }

  const remotes = Object.entries(state.remotes);
  console.log('');
  if (remotes.length === 0) {
    console.log('No remotes configured.');
    console.log('Add one: granite sync remote add macbook http://100.x.y.z:8765 --token <token>');
    return;
  }

  console.log('Remotes:');
  for (const [name, remote] of remotes) {
    console.log(`  ${name}  ${remote.url}${remote.token ? '' : '  (no token)'}`);
  }
}

export function syncConfigCommand(options: SyncConfigOptions = {}): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const state = loadSyncState(vaultRoot);

  if (options.policy !== undefined) {
    setSyncConflictPolicy(state, parsePolicy(options.policy), state.primary_device_id);
  }
  if (options.primaryThisDevice) {
    state.primary_device_id = state.device_id;
  }
  if (options.primaryDevice) {
    state.primary_device_id = options.primaryDevice;
  }

  saveSyncState(vaultRoot, state);

  if (options.json) {
    console.log(jsonSuccess({
      conflict_policy: state.conflict_policy,
      primary_device_id: state.primary_device_id,
      device_id: state.device_id,
    }));
    return;
  }

  console.log(`Sync policy: ${formatPolicy(state)}`);
}

export function syncRemoteListCommand(options: CommonOptions = {}): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const state = loadSyncState(vaultRoot);

  if (options.json) {
    console.log(jsonSuccess(state.remotes));
    return;
  }

  const remotes = Object.entries(state.remotes);
  if (remotes.length === 0) {
    console.log('No remotes configured.');
    return;
  }

  for (const [name, remote] of remotes) {
    console.log(`${name}\t${remote.url}${remote.token ? '' : '\t(no token)'}`);
  }
}

export function syncRemoteAddCommand(
  nameOrAddress: string,
  addressMaybe?: string,
  options: SyncRemoteAddOptions = {},
): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const state = loadSyncState(vaultRoot);
  const address = addressMaybe ?? nameOrAddress;
  const name = addressMaybe ? nameOrAddress : suggestedRemoteName(address);
  const url = normalizeRemoteUrl(address, options.port);

  state.remotes[name] = {
    url,
    ...(options.token ? { token: options.token } : {}),
  };
  saveSyncState(vaultRoot, state);

  if (options.json) {
    console.log(jsonSuccess({ name, remote: state.remotes[name] }));
    return;
  }

  console.log(`Added remote "${name}" at ${url}`);
  if (!options.token) {
    console.log('No token stored. Add one with: granite sync remote add ' + name + ' ' + url + ' --token <token>');
  }
}

export function syncRemoteRemoveCommand(name: string, options: CommonOptions = {}): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const state = loadSyncState(vaultRoot);

  if (!state.remotes[name]) {
    console.error(`Unknown sync remote: ${name}`);
    process.exit(1);
  }

  delete state.remotes[name];
  saveSyncState(vaultRoot, state);

  if (options.json) {
    console.log(jsonSuccess({ removed: name }));
    return;
  }

  console.log(`Removed remote "${name}"`);
}

export function syncServeCommand(options: SyncServeOptions = {}): void {
  const vaultRoot = resolveVaultRoot(options.vault);
  const state = loadSyncState(vaultRoot);
  const host = options.host ?? '0.0.0.0';
  const port = parsePort(options.port, DEFAULT_SYNC_PORT);
  const app = createSyncApp(vaultRoot);

  console.log('Granite sync server running');
  console.log(`  Vault:    ${vaultRoot}`);
  console.log(`  Device:   ${state.device_name} (${state.device_id})`);
  console.log(`  Listen:   http://${host}:${port}/sync`);
  console.log(`  Token:    ${state.local_token}`);
  console.log('');
  console.log('On the other machine:');
  console.log(`  granite sync remote add ${state.device_name} http://<tailscale-ip-or-dns>:${port} --token ${state.local_token}`);

  serve({ fetch: app.fetch, hostname: host, port });
}

export async function syncPullCommand(remoteName: string, options: SyncRemoteOptions = {}): Promise<SyncSummary> {
  const vaultRoot = resolveVaultRoot(options.vault);
  const state = loadSyncState(vaultRoot);
  const remote = resolveRemote(state, remoteName, options.token);
  withDetectedDeletions(vaultRoot, state);

  const manifest = await fetchRemoteJson<SyncManifest>(remote, '/sync/manifest');
  const summary = createSummary(remoteName, 'pull');

  for (const remoteFile of manifest.files) {
    summary.checked++;
    const localHash = getSyncFileHash(vaultRoot, remoteFile.path);
    if (localHash === remoteFile.hash) {
      markBaseline(state, remoteFile.path, remoteFile.hash, remoteFile.modified);
      summary.skipped++;
      continue;
    }

    const incoming = await fetchRemoteJson<SyncFilePayload>(
      remote,
      `/sync/file?path=${encodeURIComponent(remoteFile.path)}`,
    );
    const result = applyIncomingFile(vaultRoot, state, incoming);
    recordAction(summary, result);
  }

  for (const deletion of manifest.deletions) {
    summary.checked++;
    const validation = validateIncomingDeletion(vaultRoot, state, deletion);
    if (validation) {
      recordAction(summary, validation);
      continue;
    }
    const result = applyIncomingDeletion(vaultRoot, state, deletion);
    recordAction(summary, result);
  }

  saveSyncState(vaultRoot, state);
  if (summary.changed > 0 || summary.deleted > 0 || summary.conflicts > 0) {
    rebuildVaultIndex(vaultRoot);
  }
  if (!options.quiet) printSummary(summary, options.json);
  return summary;
}

export async function syncPushCommand(remoteName: string, options: SyncRemoteOptions = {}): Promise<SyncSummary> {
  const vaultRoot = resolveVaultRoot(options.vault);
  const state = loadSyncState(vaultRoot);
  const remote = resolveRemote(state, remoteName, options.token);
  const manifest = withDetectedDeletions(vaultRoot, state);
  const remoteManifest = await fetchRemoteJson<SyncManifest>(remote, '/sync/manifest');
  const remoteHashes = new Map(remoteManifest.files.map(file => [file.path, file.hash]));
  const remoteDeletions = new Set(remoteManifest.deletions.map(deletion => deletion.path));
  const summary = createSummary(remoteName, 'push');

  for (const localFile of manifest.files) {
    summary.checked++;
    if (remoteHashes.get(localFile.path) === localFile.hash) {
      markBaseline(state, localFile.path, localFile.hash, localFile.modified);
      summary.skipped++;
      continue;
    }

    const payload = readSyncFilePayload(vaultRoot, localFile.path, state);
    const result = await fetchRemoteJson<SyncApplyResult>(remote, '/sync/file', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    recordAction(summary, result);
    if (isAcceptedRemoteAction(result.action)) {
      markBaseline(state, localFile.path, localFile.hash, localFile.modified);
    }
  }

  for (const deletion of manifest.deletions) {
    if (remoteDeletions.has(deletion.path)) {
      summary.skipped++;
      continue;
    }
    summary.checked++;
    const payload: SyncDeletionPayload = {
      path: deletion.path,
      hash: deletion.hash,
      deleted_at: deletion.deleted_at,
      device_id: state.device_id,
    };
    const result = await fetchRemoteJson<SyncApplyResult>(remote, '/sync/delete', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    recordAction(summary, result);
  }

  saveSyncState(vaultRoot, state);
  if (!options.quiet) printSummary(summary, options.json);
  return summary;
}

export async function syncRunCommand(remoteName: string, options: SyncRemoteOptions = {}): Promise<void> {
  const pull = await syncPullCommand(remoteName, { ...options, quiet: true });
  const push = await syncPushCommand(remoteName, { ...options, quiet: true });
  const summary: SyncSummary = {
    remote: remoteName,
    direction: 'run',
    checked: pull.checked + push.checked,
    changed: pull.changed + push.changed,
    skipped: pull.skipped + push.skipped,
    conflicts: pull.conflicts + push.conflicts,
    deleted: pull.deleted + push.deleted,
    actions: [...pull.actions, ...push.actions],
  };
  printSummary(summary, options.json);
}

export async function syncWatchCommand(remoteName: string, options: SyncWatchOptions = {}): Promise<void> {
  const intervalSeconds = parsePort(options.interval, 30);
  console.error(`Granite sync watch running every ${intervalSeconds}s for remote "${remoteName}".`);
  while (true) {
    try {
      await syncRunCommand(remoteName, { ...options, json: false });
    } catch (error) {
      console.error(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
  }
}

export function createSyncApp(vaultRoot: string): Hono {
  const app = new Hono();

  app.get('/sync/health', (c) => {
    const state = loadSyncState(vaultRoot);
    return c.json({
      ok: true,
      device_id: state.device_id,
      device_name: state.device_name,
      conflict_policy: state.conflict_policy,
      primary_device_id: state.primary_device_id,
    });
  });

  app.use('/sync/*', async (c, next) => {
    const state = loadSyncState(vaultRoot);
    const token = readBearerToken(c.req.header('authorization'));
    if (!state.local_token || !token || token !== state.local_token) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  app.get('/sync/manifest', (c) => {
    const state = loadSyncState(vaultRoot);
    const manifest = buildSyncManifest(vaultRoot, state);
    return c.json(manifest);
  });

  app.get('/sync/file', (c) => {
    try {
      const relativePath = c.req.query('path');
      if (!relativePath) return c.json({ error: 'path is required' }, 400);
      const state = loadSyncState(vaultRoot);
      return c.json(readSyncFilePayload(vaultRoot, relativePath, state));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post('/sync/file', async (c) => {
    try {
      const incoming = await c.req.json() as SyncFilePayload;
      const state = loadSyncState(vaultRoot);
      const result = applyIncomingFile(vaultRoot, state, incoming);
      saveSyncState(vaultRoot, state);
      if (result.action !== 'unchanged') rebuildVaultIndex(vaultRoot);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post('/sync/delete', async (c) => {
    try {
      const incoming = await c.req.json() as SyncDeletionPayload;
      const state = loadSyncState(vaultRoot);
      const validation = validateIncomingDeletion(vaultRoot, state, incoming);
      if (validation) return c.json(validation);
      const result = applyIncomingDeletion(vaultRoot, state, incoming);
      saveSyncState(vaultRoot, state);
      if (result.action !== 'delete_ignored_missing') rebuildVaultIndex(vaultRoot);
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return app;
}

function resolveVaultRoot(explicitVault?: string): string {
  if (explicitVault) return path.resolve(explicitVault);
  if (process.env.GRANITE_VAULT) return path.resolve(process.env.GRANITE_VAULT);
  return requireVaultRoot();
}

function withDetectedDeletions(vaultRoot: string, state: SyncState): SyncManifest {
  if (detectLocalDeletions(vaultRoot, state)) {
    saveSyncState(vaultRoot, state);
  }
  return buildSyncManifest(vaultRoot, state);
}

function parsePort(value: string | undefined, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid number: ${raw}`);
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0 || parsed > 65535) throw new Error(`Invalid number: ${raw}`);
  return parsed;
}

function parsePolicy(value: string): SyncConflictPolicy {
  if (value === 'manual') return 'manual';
  if (value === 'primary-wins' || value === 'primary_wins') return 'primary_wins';
  throw new Error('Invalid sync policy. Expected manual or primary-wins.');
}

function formatPolicy(state: SyncState): string {
  if (state.conflict_policy === 'primary_wins') {
    return `primary-wins (${state.primary_device_id})`;
  }
  return 'manual';
}

function resolveRemote(state: SyncState, remoteName: string, tokenOverride?: string): SyncRemote {
  const remote = state.remotes[remoteName];
  if (!remote) {
    throw new Error(`Unknown sync remote: ${remoteName}`);
  }
  return {
    ...remote,
    ...(tokenOverride ? { token: tokenOverride } : {}),
  };
}

async function fetchRemoteJson<T>(remote: SyncRemote, route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(remoteUrl(remote, route), {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(remote.token ? { Authorization: `Bearer ${remote.token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Remote returned non-JSON response (${response.status})`);
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data && 'error' in data
      ? String((data as { error: unknown }).error)
      : `Remote request failed (${response.status})`;
    throw new Error(message);
  }

  return data as T;
}

function remoteUrl(remote: SyncRemote, route: string): string {
  const base = remote.url.replace(/\/+$/, '');
  return `${base}${route}`;
}

function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function validateIncomingDeletion(
  vaultRoot: string,
  state: SyncState,
  incoming: SyncDeletionPayload,
): SyncApplyResult | null {
  const safePath = normalizeSyncPath(incoming.path);
  const localHash = getSyncFileHash(vaultRoot, safePath);
  const baselineHash = state.baselines[safePath]?.hash;
  const tombstoneHash = state.tombstones[safePath]?.hash;

  if (incoming.hash === localHash || incoming.hash === baselineHash || incoming.hash === tombstoneHash) {
    return null;
  }

  if (!localHash && !baselineHash && !tombstoneHash) {
    return { path: safePath, action: 'delete_ignored_missing' };
  }

  return { path: safePath, action: 'delete_rejected_unknown_hash' };
}

function createSummary(remote: string, direction: SyncSummary['direction']): SyncSummary {
  return {
    remote,
    direction,
    checked: 0,
    changed: 0,
    skipped: 0,
    conflicts: 0,
    deleted: 0,
    actions: [],
  };
}

function recordAction(summary: SyncSummary, result: SyncApplyResult): void {
  summary.actions.push(result);
  if (isConflictAction(result.action)) {
    summary.conflicts++;
    return;
  }
  if (result.action === 'unchanged' || result.action === 'delete_ignored_missing') {
    summary.skipped++;
    return;
  }
  if (result.action === 'delete_rejected_unknown_hash') {
    summary.conflicts++;
    return;
  }
  if (result.action === 'deleted') {
    summary.deleted++;
    return;
  }
  summary.changed++;
}

function isConflictAction(action: SyncApplyAction): boolean {
  return action === 'conflict_copy_created' ||
    action === 'delete_conflict_copy_created' ||
    action === 'kept_local_primary';
}

function isAcceptedRemoteAction(action: SyncApplyAction): boolean {
  return action === 'unchanged' ||
    action === 'created' ||
    action === 'updated' ||
    action === 'overwrote_local_primary' ||
    action === 'deleted' ||
    action === 'delete_ignored_missing';
}

function printSummary(summary: SyncSummary, asJson?: boolean): void {
  if (asJson) {
    console.log(jsonSuccess(summary));
    return;
  }

  console.log(
    `Sync ${summary.direction} ${summary.remote}: ` +
    `${summary.changed} changed, ${summary.deleted} deleted, ${summary.conflicts} conflict(s), ${summary.skipped} skipped`,
  );
  for (const action of summary.actions.filter(item => item.conflict_path)) {
    console.log(`  conflict: ${action.path} -> ${action.conflict_path}`);
  }
}

function rebuildVaultIndex(vaultRoot: string): void {
  try {
    const config = loadConfig(vaultRoot);
    const db = openDatabase(vaultRoot);
    rebuildIndex(vaultRoot, config, db);
    db.close();
  } catch {
    // Sync has already written the vault files. Index rebuild can be retried by
    // any normal read command, so avoid turning a successful file sync into a failure.
  }
}

export function ensureSyncStateExistsForTests(vaultRoot: string): SyncState {
  if (!fs.existsSync(getSyncStatePath(vaultRoot))) {
    const state = loadSyncState(vaultRoot);
    saveSyncState(vaultRoot, state);
    return state;
  }
  return loadSyncState(vaultRoot);
}
