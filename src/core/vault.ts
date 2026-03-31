import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILENAME } from './config.js';

const DEFAULT_VAULT_DIRNAME = '.granite';

function hasVaultConfig(dir: string): boolean {
  return fs.existsSync(path.join(dir, CONFIG_FILENAME));
}

export function getDefaultVaultRoot(homeDir = os.homedir()): string {
  return path.resolve(homeDir, DEFAULT_VAULT_DIRNAME);
}

export function findVaultRoot(from?: string): string | null {
  let dir = from ? path.resolve(from) : process.cwd();
  while (true) {
    if (hasVaultConfig(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const defaultVaultRoot = getDefaultVaultRoot();
  return hasVaultConfig(defaultVaultRoot) ? defaultVaultRoot : null;
}

export function requireVaultRoot(from?: string): string {
  const root = findVaultRoot(from);
  if (!root) {
    throw new Error(`No Granite vault found. Run "granite init" to create ${getDefaultVaultRoot()}.`);
  }
  return root;
}

export function getIndexDbPath(vaultRoot: string): string {
  if (path.basename(path.resolve(vaultRoot)) === DEFAULT_VAULT_DIRNAME) {
    return path.join(vaultRoot, 'index.db');
  }
  return path.join(vaultRoot, '.granite', 'index.db');
}

export function resolveNotePath(vaultRoot: string, folder: string, slug: string): string {
  return path.join(vaultRoot, folder, `${slug}.md`);
}
