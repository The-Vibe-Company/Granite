import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initVault } from '../../src/commands/init.js';
import { loadConfig } from '../../src/core/config.js';
import { getDefaultVaultRoot, getIndexDbPath } from '../../src/core/vault.js';

describe('initVault', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let previousHome: string | undefined;
  let previousCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-init-home-'));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-init-cwd-'));
    previousHome = process.env.HOME;
    previousCwd = process.cwd();
    process.env.HOME = tmpHome;
    process.chdir(tmpCwd);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(previousCwd);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('initializes the default vault in the home directory instead of the current working directory', () => {
    initVault();

    const vaultRoot = getDefaultVaultRoot();
    const config = loadConfig(vaultRoot);

    expect(vaultRoot).toBe(path.join(tmpHome, '.granite'));
    expect(fs.existsSync(path.join(vaultRoot, 'granite.yml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpCwd, 'granite.yml'))).toBe(false);
    expect(path.dirname(getIndexDbPath(vaultRoot))).toBe(vaultRoot);

    for (const typeConfig of Object.values(config.note_types)) {
      expect(fs.existsSync(path.join(vaultRoot, typeConfig.folder))).toBe(true);
    }
  });
});
