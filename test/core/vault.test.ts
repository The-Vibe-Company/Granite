import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDefaultConfig } from '../../src/core/config.js';
import { findVaultRoot, getDefaultVaultRoot, getIndexDbPath, requireVaultRoot } from '../../src/core/vault.js';

describe('vault', () => {
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function createGlobalVault(): string {
    const vaultRoot = getDefaultVaultRoot();
    fs.mkdirSync(vaultRoot, { recursive: true });
    writeDefaultConfig(vaultRoot);
    return vaultRoot;
  }

  it('falls back to the default vault in the home directory', () => {
    const vaultRoot = createGlobalVault();
    const outsideDir = path.join(tmpHome, 'workspace');
    fs.mkdirSync(outsideDir, { recursive: true });

    expect(findVaultRoot(outsideDir)).toBe(vaultRoot);
  });

  it('prefers the nearest local vault over the default home vault', () => {
    createGlobalVault();
    const localVaultRoot = path.join(tmpHome, 'projects', 'local-vault');
    const nestedDir = path.join(localVaultRoot, 'notes', 'scratch');

    fs.mkdirSync(localVaultRoot, { recursive: true });
    writeDefaultConfig(localVaultRoot);
    fs.mkdirSync(nestedDir, { recursive: true });

    expect(findVaultRoot(nestedDir)).toBe(localVaultRoot);
  });

  it('stores the index at the vault root when the vault itself is ~/.granite', () => {
    const vaultRoot = getDefaultVaultRoot();
    const localVaultRoot = path.join(tmpHome, 'projects', 'vault');

    expect(getIndexDbPath(vaultRoot)).toBe(path.join(vaultRoot, 'index.db'));
    expect(getIndexDbPath(localVaultRoot)).toBe(path.join(localVaultRoot, '.granite', 'index.db'));
  });

  it('mentions the default vault path when no vault can be found', () => {
    expect(() => requireVaultRoot(path.join(tmpHome, 'nowhere'))).toThrow(
      `No Granite vault found. Run "granite init" to create ${getDefaultVaultRoot()}.`,
    );
  });
});
