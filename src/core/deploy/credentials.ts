import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GRANITE_DIRNAME = '.granite';
const CONFIG_DIRNAME = 'config';
const SPRITES_CREDENTIALS_FILENAME = 'sprites.json';

export interface StoredSpritesCredentials {
  version: 1;
  token: string;
  updated: string;
}

export function getSpritesCredentialsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, GRANITE_DIRNAME, CONFIG_DIRNAME, SPRITES_CREDENTIALS_FILENAME);
}

export function resolveSpritesToken(explicit?: string): string | null {
  const fromExplicit = normalizeToken(explicit);
  if (fromExplicit) return fromExplicit;

  const fromEnv = normalizeToken(process.env.SPRITES_TOKEN);
  if (fromEnv) return fromEnv;

  return readStoredSpritesToken();
}

export function readStoredSpritesToken(homeDir = os.homedir()): string | null {
  const filePath = getSpritesCredentialsPath(homeDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<StoredSpritesCredentials>;
    return normalizeToken(parsed.token);
  } catch {
    return null;
  }
}

export function saveSpritesToken(token: string, homeDir = os.homedir()): string {
  const normalized = normalizeToken(token);
  if (!normalized) {
    throw new Error('Invalid Sprites token.');
  }

  const filePath = getSpritesCredentialsPath(homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const payload: StoredSpritesCredentials = {
    version: 1,
    token: normalized,
    updated: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod is best-effort on Windows and some filesystems.
  }
  return filePath;
}

export function deleteStoredSpritesToken(homeDir = os.homedir()): boolean {
  const filePath = getSpritesCredentialsPath(homeDir);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function normalizeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
