import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeDefaultConfig, loadConfig, getDefaultConfig } from '../../src/core/config.js';

describe('config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a valid default config', () => {
    writeDefaultConfig(tmpDir);
    const configPath = path.join(tmpDir, 'granite.yml');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('loads a written config with correct structure', () => {
    writeDefaultConfig(tmpDir);
    const config = loadConfig(tmpDir);
    expect(config.vault_name).toBe('My Vault');
    expect(config.version).toBe(1);
    expect(Object.keys(config.note_types)).toEqual(['note', 'source', 'synthesis', 'output']);
    expect(config.defaults.note_type).toBe('note');
  });

  it('throws when no config exists', () => {
    expect(() => loadConfig(tmpDir)).toThrow('No granite.yml found');
  });

  it('default config has all required fields per type', () => {
    const config = getDefaultConfig();
    for (const [name, type] of Object.entries(config.note_types)) {
      expect(type.folder).toBeDefined();
      expect(type.description).toBeDefined();
      expect(typeof type.line_limit).toBe('number');
      expect(typeof type.warn_only).toBe('boolean');
    }
  });
});
