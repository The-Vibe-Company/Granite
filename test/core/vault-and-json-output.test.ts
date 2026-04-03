import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findVaultRoot,
  getIndexDbPath,
  requireVaultRoot,
  resolveNotePath,
} from '../../src/core/vault.js';
import {
  jsonError,
  jsonSuccess,
  validateSource,
  validateStatus,
} from '../../src/core/json-output.js';

describe('vault helpers', () => {
  let tmpDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-vault-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds the vault root from a nested directory', () => {
    const nestedDir = path.join(tmpDir, 'notes', 'deep');
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'granite.yml'), 'vault_name: test\n', 'utf-8');

    expect(findVaultRoot(nestedDir)).toBe(tmpDir);
    expect(requireVaultRoot(nestedDir)).toBe(tmpDir);
  });

  it('throws when no vault root is found', () => {
    expect(findVaultRoot(tmpDir)).toBeNull();
    expect(() => requireVaultRoot(tmpDir)).toThrow('No Granite vault found');
  });

  it('builds vault-relative file paths', () => {
    expect(getIndexDbPath('/vault')).toBe(path.join('/vault', '.granite', 'index.db'));
    expect(getIndexDbPath(path.join('/vault', '.granite'))).toBe(path.join('/vault', '.granite', 'index.db'));
    expect(resolveNotePath('/vault', 'note', 'my-note')).toBe(path.join('/vault', 'note', 'my-note.md'));
  });
});

describe('json output helpers', () => {
  it('serializes success and error payloads', () => {
    expect(JSON.parse(jsonSuccess({ slug: 'test' }))).toEqual({
      success: true,
      data: { slug: 'test' },
    });

    expect(JSON.parse(jsonError('boom'))).toEqual({
      success: false,
      error: 'boom',
    });
  });

  it('accepts valid status and source values', () => {
    expect(() => validateStatus('inbox')).not.toThrow();
    expect(() => validateStatus('active')).not.toThrow();
    expect(() => validateStatus('archived')).not.toThrow();

    expect(() => validateSource('human')).not.toThrow();
    expect(() => validateSource('agent')).not.toThrow();
    expect(() => validateSource('extraction')).not.toThrow();
  });

  it('rejects invalid status and source values', () => {
    expect(() => validateStatus('draft')).toThrow('Invalid status');
    expect(() => validateSource('import')).toThrow('Invalid source');
  });
});
