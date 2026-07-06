import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGraniteDir } from './vault.js';

const SYNC_STATE_FILENAME = 'sync.json';
const SYNC_PROTOCOL_VERSION = 1;

export type SyncConflictPolicy = 'manual' | 'primary_wins';
export type SyncAccessRole = 'read' | 'write';

export interface SyncRemote {
  url: string;
  token?: string;
}

export interface SyncAccessToken {
  name: string;
  token: string;
  role: SyncAccessRole;
  created_at: string;
}

export interface SyncBaseline {
  hash: string;
  modified: string;
}

export interface SyncTombstone {
  hash: string;
  deleted_at: string;
  device_id: string;
}

export interface SyncState {
  version: 1;
  device_id: string;
  device_name: string;
  local_token: string;
  conflict_policy: SyncConflictPolicy;
  primary_device_id: string;
  remotes: Record<string, SyncRemote>;
  access_tokens: Record<string, SyncAccessToken>;
  baselines: Record<string, SyncBaseline>;
  tombstones: Record<string, SyncTombstone>;
}

export interface SyncManifestFile {
  path: string;
  hash: string;
  size: number;
  modified: string;
}

export interface SyncManifestDeletion {
  path: string;
  hash: string;
  deleted_at: string;
  device_id: string;
}

export interface SyncManifest {
  version: 1;
  device_id: string;
  device_name: string;
  conflict_policy: SyncConflictPolicy;
  primary_device_id: string;
  files: SyncManifestFile[];
  deletions: SyncManifestDeletion[];
}

export interface SyncFilePayload extends SyncManifestFile {
  device_id: string;
  content_base64: string;
  base_hash?: string | null;
}

export interface SyncDeletionPayload {
  path: string;
  hash: string;
  deleted_at: string;
  device_id: string;
  base_hash?: string | null;
}

export type SyncApplyAction =
  | 'unchanged'
  | 'created'
  | 'updated'
  | 'overwrote_local_primary'
  | 'kept_local_primary'
  | 'conflict_copy_created'
  | 'deleted'
  | 'delete_ignored_missing'
  | 'delete_conflict_copy_created'
  | 'delete_rejected_unknown_hash';

export interface SyncApplyResult {
  path: string;
  action: SyncApplyAction;
  conflict_path?: string;
}

export function getSyncStatePath(vaultRoot: string): string {
  return path.join(getGraniteDir(vaultRoot), SYNC_STATE_FILENAME);
}

export function loadSyncState(vaultRoot: string): SyncState {
  const statePath = getSyncStatePath(vaultRoot);
  if (!fs.existsSync(statePath)) {
    const state = createDefaultSyncState();
    saveSyncState(vaultRoot, state);
    return state;
  }

  const raw = fs.readFileSync(statePath, 'utf-8');
  let parsed: Partial<SyncState>;
  try {
    parsed = JSON.parse(raw) as Partial<SyncState>;
  } catch {
    preserveCorruptSyncState(statePath, raw);
    const state = createDefaultSyncState();
    saveSyncState(vaultRoot, state);
    return state;
  }
  const deviceId = parsed.device_id || createDeviceId();
  const localToken = parsed.local_token || createToken();
  const state: SyncState = {
    version: SYNC_PROTOCOL_VERSION,
    device_id: deviceId,
    device_name: parsed.device_name || os.hostname(),
    local_token: localToken,
    conflict_policy: normalizeConflictPolicy(parsed.conflict_policy),
    primary_device_id: parsed.primary_device_id || deviceId,
    remotes: parsed.remotes ?? {},
    access_tokens: normalizeAccessTokens(parsed.access_tokens, localToken),
    baselines: parsed.baselines ?? {},
    tombstones: parsed.tombstones ?? {},
  };

  if (state.primary_device_id === '' || state.primary_device_id === undefined) {
    state.primary_device_id = state.device_id;
  }

  return state;
}

export function saveSyncState(vaultRoot: string, state: SyncState): void {
  const statePath = getSyncStatePath(vaultRoot);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function createDefaultSyncState(): SyncState {
  const deviceId = createDeviceId();
  const localToken = createToken();
  return {
    version: SYNC_PROTOCOL_VERSION,
    device_id: deviceId,
    device_name: os.hostname(),
    local_token: localToken,
    conflict_policy: 'manual',
    primary_device_id: deviceId,
    remotes: {},
    access_tokens: {
      default: {
        name: 'default',
        token: localToken,
        role: 'write',
        created_at: new Date().toISOString(),
      },
    },
    baselines: {},
    tombstones: {},
  };
}

export function grantSyncAccess(
  state: SyncState,
  name: string,
  role: SyncAccessRole,
  now = new Date(),
): SyncAccessToken {
  const safeName = normalizeAccessName(name);
  const grant: SyncAccessToken = {
    name: safeName,
    token: createToken(),
    role,
    created_at: now.toISOString(),
  };
  state.access_tokens[safeName] = grant;
  return grant;
}

export function revokeSyncAccess(state: SyncState, name: string): boolean {
  const safeName = normalizeAccessName(name);
  if (!state.access_tokens[safeName]) {
    return false;
  }
  delete state.access_tokens[safeName];
  return true;
}

export function resolveSyncAccessRole(state: SyncState, token: string | null | undefined): SyncAccessRole | null {
  if (!token) return null;

  for (const grant of Object.values(state.access_tokens)) {
    if (grant.token === token) return grant.role;
  }

  return null;
}

export function setSyncConflictPolicy(
  state: SyncState,
  policy: SyncConflictPolicy,
  primaryDeviceId?: string,
): void {
  state.conflict_policy = policy;
  if (primaryDeviceId) {
    state.primary_device_id = primaryDeviceId;
  }
}

export function buildSyncManifest(vaultRoot: string, state: SyncState): SyncManifest {
  const files = listSyncFiles(vaultRoot);
  const filePaths = new Set(files.map(file => file.path));
  const deletions = new Map<string, SyncManifestDeletion>();

  for (const [relativePath, tombstone] of Object.entries(state.tombstones)) {
    if (filePaths.has(relativePath)) continue;
    deletions.set(relativePath, {
      path: relativePath,
      hash: tombstone.hash,
      deleted_at: tombstone.deleted_at,
      device_id: tombstone.device_id,
    });
  }

  for (const [relativePath, baseline] of Object.entries(state.baselines)) {
    if (filePaths.has(relativePath) || deletions.has(relativePath)) continue;
    deletions.set(relativePath, {
      path: relativePath,
      hash: baseline.hash,
      deleted_at: new Date().toISOString(),
      device_id: state.device_id,
    });
  }

  return {
    version: SYNC_PROTOCOL_VERSION,
    device_id: state.device_id,
    device_name: state.device_name,
    conflict_policy: state.conflict_policy,
    primary_device_id: state.primary_device_id,
    files,
    deletions: [...deletions.values()]
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function listSyncFiles(vaultRoot: string): SyncManifestFile[] {
  const root = path.resolve(vaultRoot);
  const files: SyncManifestFile[] = [];
  walkVault(root, '', files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function readSyncFilePayload(
  vaultRoot: string,
  relativePath: string,
  state: SyncState,
): SyncFilePayload {
  const safePath = normalizeSyncPath(relativePath);
  const absolutePath = resolveSyncPath(vaultRoot, safePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`Sync file not found: ${safePath}`);
  }

  const stat = fs.statSync(absolutePath);
  const content = fs.readFileSync(absolutePath);
  return {
    path: safePath,
    hash: hashBuffer(content),
    size: stat.size,
    modified: stat.mtime.toISOString(),
    device_id: state.device_id,
    content_base64: content.toString('base64'),
    base_hash: state.baselines[safePath]?.hash ?? null,
  };
}

export function getSyncFileHash(vaultRoot: string, relativePath: string): string | null {
  const safePath = normalizeSyncPath(relativePath);
  const absolutePath = resolveSyncPath(vaultRoot, safePath);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    return null;
  }
  return hashFile(absolutePath);
}

export function detectLocalDeletions(vaultRoot: string, state: SyncState, now = new Date()): boolean {
  let changed = false;
  const existing = new Set(listSyncFiles(vaultRoot).map(file => file.path));

  for (const [relativePath, baseline] of Object.entries(state.baselines)) {
    if (existing.has(relativePath) || state.tombstones[relativePath]) continue;
    state.tombstones[relativePath] = {
      hash: baseline.hash,
      deleted_at: now.toISOString(),
      device_id: state.device_id,
    };
    delete state.baselines[relativePath];
    changed = true;
  }

  return changed;
}

export function applyIncomingFile(
  vaultRoot: string,
  state: SyncState,
  incoming: SyncFilePayload,
  now = new Date(),
): SyncApplyResult {
  const safePath = normalizeSyncPath(incoming.path);
  const content = decodeBase64Strict(incoming.content_base64, safePath);
  const incomingHash = hashBuffer(content);
  if (incomingHash !== incoming.hash) {
    throw new Error(`Hash mismatch for ${safePath}`);
  }

  const absolutePath = resolveSyncPath(vaultRoot, safePath);
  const localHash = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
    ? hashFile(absolutePath)
    : null;
  const baseHash = state.baselines[safePath]?.hash ?? incoming.base_hash ?? null;
  const tombstone = state.tombstones[safePath];

  if (localHash === incoming.hash) {
    markBaseline(state, safePath, incoming.hash, incoming.modified);
    delete state.tombstones[safePath];
    return { path: safePath, action: 'unchanged' };
  }

  if (!localHash && tombstone) {
    if (tombstone.hash === incoming.hash) {
      return { path: safePath, action: 'unchanged' };
    }

    if (state.conflict_policy === 'primary_wins') {
      if (incoming.device_id === state.primary_device_id) {
        writeSyncedFile(absolutePath, content, incoming.modified);
        markBaseline(state, safePath, incoming.hash, incoming.modified);
        delete state.tombstones[safePath];
        return { path: safePath, action: 'created' };
      }

      if (state.device_id === state.primary_device_id) {
        const conflictPath = writeConflictCopy(vaultRoot, safePath, incoming.device_id, content, incoming.modified, now);
        return { path: safePath, action: 'kept_local_primary', conflict_path: conflictPath };
      }
    }

    const conflictPath = writeConflictCopy(vaultRoot, safePath, incoming.device_id, content, incoming.modified, now);
    return { path: safePath, action: 'conflict_copy_created', conflict_path: conflictPath };
  }

  if (!localHash) {
    writeSyncedFile(absolutePath, content, incoming.modified);
    markBaseline(state, safePath, incoming.hash, incoming.modified);
    delete state.tombstones[safePath];
    return { path: safePath, action: 'created' };
  }

  if (baseHash && incoming.hash === baseHash) {
    return { path: safePath, action: 'unchanged' };
  }

  if (baseHash && localHash === baseHash) {
    writeSyncedFile(absolutePath, content, incoming.modified);
    markBaseline(state, safePath, incoming.hash, incoming.modified);
    delete state.tombstones[safePath];
    return { path: safePath, action: 'updated' };
  }

  if (state.conflict_policy === 'primary_wins') {
    if (incoming.device_id === state.primary_device_id) {
      writeSyncedFile(absolutePath, content, incoming.modified);
      markBaseline(state, safePath, incoming.hash, incoming.modified);
      delete state.tombstones[safePath];
      return { path: safePath, action: 'overwrote_local_primary' };
    }

    if (state.device_id === state.primary_device_id) {
      const conflictPath = writeConflictCopy(vaultRoot, safePath, incoming.device_id, content, incoming.modified, now);
      return { path: safePath, action: 'kept_local_primary', conflict_path: conflictPath };
    }
  }

  const conflictPath = writeConflictCopy(vaultRoot, safePath, incoming.device_id, content, incoming.modified, now);
  return { path: safePath, action: 'conflict_copy_created', conflict_path: conflictPath };
}

export function applyIncomingDeletion(
  vaultRoot: string,
  state: SyncState,
  incoming: SyncDeletionPayload,
  now = new Date(),
): SyncApplyResult {
  const safePath = normalizeSyncPath(incoming.path);
  const absolutePath = resolveSyncPath(vaultRoot, safePath);
  const localHash = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
    ? hashFile(absolutePath)
    : null;
  const baseHash = state.baselines[safePath]?.hash ?? null;
  const tombstone = state.tombstones[safePath];
  const incomingDeletesKnownBase = baseHash !== null && incoming.hash === baseHash;

  if (!localHash) {
    if (!incomingDeletesKnownBase && tombstone?.hash !== incoming.hash) {
      return { path: safePath, action: 'delete_ignored_missing' };
    }

    state.tombstones[safePath] = {
      hash: incoming.hash,
      deleted_at: incoming.deleted_at,
      device_id: incoming.device_id,
    };
    delete state.baselines[safePath];
    return { path: safePath, action: 'delete_ignored_missing' };
  }

  if (tombstone?.hash === incoming.hash) {
    return { path: safePath, action: 'unchanged' };
  }

  if (localHash !== incoming.hash && !incomingDeletesKnownBase) {
    return { path: safePath, action: 'delete_rejected_unknown_hash' };
  }

  if (localHash === incoming.hash || (baseHash !== null && localHash === baseHash)) {
    fs.unlinkSync(absolutePath);
    state.tombstones[safePath] = {
      hash: incoming.hash,
      deleted_at: incoming.deleted_at,
      device_id: incoming.device_id,
    };
    delete state.baselines[safePath];
    return { path: safePath, action: 'deleted' };
  }

  if (state.conflict_policy === 'primary_wins') {
    if (incoming.device_id === state.primary_device_id && incomingDeletesKnownBase) {
      fs.unlinkSync(absolutePath);
      state.tombstones[safePath] = {
        hash: incoming.hash,
        deleted_at: incoming.deleted_at,
        device_id: incoming.device_id,
      };
      delete state.baselines[safePath];
      return { path: safePath, action: 'deleted' };
    }

    if (state.device_id === state.primary_device_id) {
      state.tombstones[safePath] = {
        hash: incoming.hash,
        deleted_at: incoming.deleted_at,
        device_id: incoming.device_id,
      };
      return { path: safePath, action: 'kept_local_primary' };
    }
  }

  const content = fs.readFileSync(absolutePath);
  const conflictPath = writeConflictCopy(vaultRoot, safePath, incoming.device_id, content, now.toISOString(), now);
  fs.unlinkSync(absolutePath);
  state.tombstones[safePath] = {
    hash: incoming.hash,
    deleted_at: incoming.deleted_at,
    device_id: incoming.device_id,
  };
  delete state.baselines[safePath];
  return { path: safePath, action: 'delete_conflict_copy_created', conflict_path: conflictPath };
}

export function markBaseline(
  state: SyncState,
  relativePath: string,
  hash: string,
  modified: string,
): void {
  state.baselines[relativePath] = { hash, modified };
}

export function normalizeSyncPath(relativePath: string): string {
  const withSlashes = relativePath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(withSlashes);

  if (
    !withSlashes ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    path.isAbsolute(withSlashes)
  ) {
    throw new Error(`Unsafe sync path: ${relativePath}`);
  }

  if (isIgnoredSyncPath(normalized)) {
    throw new Error(`Path is not syncable: ${relativePath}`);
  }

  return normalized;
}

export function isIgnoredSyncPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const first = normalized.split('/')[0];
  if (first === '.git' || first === 'node_modules') return true;
  if (first === '.granite') return true;
  if (normalized === '.DS_Store') return true;

  const rootDerivedFiles = new Set([
    'config/sprites.json',
    'index.db',
    'mcp.pid',
    'mcp.url',
    'mcp.log',
    'daemon.pid',
    'daemon.state.json',
    'daemon.log',
    SYNC_STATE_FILENAME,
  ]);

  return rootDerivedFiles.has(normalized) || normalized.startsWith('index.db-');
}

function createDefaultRemoteName(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '');
}

export function normalizeRemoteUrl(address: string, port?: string): string {
  const withScheme = /^https?:\/\//.test(address) ? address : `http://${address}`;
  const url = new URL(withScheme);
  if (port && !url.port) {
    url.port = port;
  }
  if (url.pathname === '/sync' || url.pathname.endsWith('/sync/')) {
    url.pathname = url.pathname.replace(/\/sync\/?$/, '');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function suggestedRemoteName(address: string): string {
  return createDefaultRemoteName(normalizeRemoteUrl(address)) || 'remote';
}

function createDeviceId(): string {
  return `dev_${crypto.randomUUID()}`;
}

function createToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function normalizeConflictPolicy(value: unknown): SyncConflictPolicy {
  return value === 'primary_wins' ? 'primary_wins' : 'manual';
}

function normalizeAccessTokens(
  value: unknown,
  localToken: string,
): Record<string, SyncAccessToken> {
  const grants: Record<string, SyncAccessToken> = {};
  let shouldMigrateLocalToken = value === undefined;

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    shouldMigrateLocalToken = true;
    for (const [rawName, rawGrant] of entries) {
      if (!rawGrant || typeof rawGrant !== 'object' || Array.isArray(rawGrant)) continue;
      const grant = rawGrant as Partial<SyncAccessToken>;
      const token = typeof grant.token === 'string' && grant.token ? grant.token : null;
      if (!token) continue;
      const name = normalizeOptionalAccessName(grant.name) ?? normalizeOptionalAccessName(rawName);
      if (!name) continue;
      grants[name] = {
        name,
        token,
        role: normalizeAccessRole(grant.role),
        created_at: typeof grant.created_at === 'string' && grant.created_at
          ? grant.created_at
          : new Date(0).toISOString(),
      };
      shouldMigrateLocalToken = false;
    }
  } else if (value !== undefined) {
    shouldMigrateLocalToken = true;
  }

  if (shouldMigrateLocalToken && !Object.values(grants).some(grant => grant.token === localToken)) {
    grants.default = {
      name: 'default',
      token: localToken,
      role: 'write',
      created_at: new Date(0).toISOString(),
    };
  }

  return grants;
}

function normalizeAccessRole(value: unknown): SyncAccessRole {
  return value === 'read' ? 'read' : 'write';
}

function normalizeAccessName(name: string): string {
  const normalized = normalizeOptionalAccessName(name);
  if (!normalized) {
    throw new Error(`Invalid sync access name: ${name}`);
  }
  return normalized;
}

function normalizeOptionalAccessName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const normalized = name.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) return null;
  return normalized;
}

function preserveCorruptSyncState(statePath: string, raw: string): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupPath = `${statePath}.corrupt.${stamp}`;
  try {
    fs.writeFileSync(backupPath, raw, 'utf-8');
  } catch {
    // If preserving the corrupt file fails, still recover the sync service with
    // a fresh local state. The vault contents remain untouched.
  }
}

function walkVault(root: string, relativeDir: string, out: SyncManifestFile[]): void {
  const absoluteDir = relativeDir ? path.join(root, ...relativeDir.split('/')) : root;
  if (!fs.existsSync(absoluteDir)) return;

  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (isIgnoredSyncPath(relativePath)) continue;

    const absolutePath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      walkVault(root, relativePath, out);
      continue;
    }
    if (!entry.isFile()) continue;

    const stat = fs.statSync(absolutePath);
    out.push({
      path: relativePath,
      hash: hashFile(absolutePath),
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }
}

function resolveSyncPath(vaultRoot: string, relativePath: string): string {
  const root = path.resolve(vaultRoot);
  const absolutePath = path.resolve(root, ...relativePath.split('/'));
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe sync path: ${relativePath}`);
  }
  return absolutePath;
}

function hashFile(filePath: string): string {
  return hashBuffer(fs.readFileSync(filePath));
}

function hashBuffer(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function decodeBase64Strict(value: string, relativePath: string): Buffer {
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!validBase64.test(value)) {
    throw new Error(`Invalid base64 content for ${relativePath}`);
  }

  const content = Buffer.from(value, 'base64');
  if (content.toString('base64') !== value) {
    throw new Error(`Invalid base64 content for ${relativePath}`);
  }
  return content;
}

function writeSyncedFile(absolutePath: string, content: Buffer, modified: string): void {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  const mtime = new Date(modified);
  if (!Number.isNaN(mtime.getTime())) {
    fs.utimesSync(absolutePath, mtime, mtime);
  }
}

function writeConflictCopy(
  vaultRoot: string,
  originalPath: string,
  deviceId: string,
  content: Buffer,
  modified: string,
  now: Date,
): string {
  const conflictPath = buildConflictPath(originalPath, deviceId, now);
  const absolutePath = resolveSyncPath(vaultRoot, conflictPath);
  writeSyncedFile(absolutePath, content, modified);
  return conflictPath;
}

function buildConflictPath(originalPath: string, deviceId: string, now: Date): string {
  const dir = path.posix.dirname(originalPath);
  const ext = path.posix.extname(originalPath);
  const base = path.posix.basename(originalPath, ext);
  const safeDevice = deviceId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const filename = `${base}.conflict.${safeDevice}.${stamp}${ext}`;
  return dir === '.' ? filename : `${dir}/${filename}`;
}
