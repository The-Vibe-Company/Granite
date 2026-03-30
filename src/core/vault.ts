import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILENAME } from './config.js';

export function findVaultRoot(from?: string): string | null {
  let dir = from ? path.resolve(from) : process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, CONFIG_FILENAME))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireVaultRoot(from?: string): string {
  const root = findVaultRoot(from);
  if (!root) {
    throw new Error('Not inside a Granite vault. Run "mem init" to create one.');
  }
  return root;
}

export function getIndexDbPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.granite', 'index.db');
}

export function resolveNotePath(vaultRoot: string, folder: string, slug: string): string {
  return path.join(vaultRoot, folder, `${slug}.md`);
}
