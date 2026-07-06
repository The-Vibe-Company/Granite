import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteStoredSpritesToken,
  getSpritesCredentialsPath,
  readStoredSpritesToken,
  resolveSpritesToken,
  saveSpritesToken,
} from '../../src/core/deploy/credentials.js';

describe('Sprites credentials', () => {
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-credentials-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    vi.stubEnv('SPRITES_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('stores and reads the token from ~/.granite/config/sprites.json', () => {
    const filePath = saveSpritesToken('  stored-token  ');

    expect(filePath).toBe(path.join(tmpHome, '.granite', 'config', 'sprites.json'));
    expect(readStoredSpritesToken()).toBe('stored-token');
    expect(resolveSpritesToken()).toBe('stored-token');

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { version: number; token: string };
    expect(parsed).toMatchObject({ version: 1, token: 'stored-token' });
  });

  it('prefers explicit and environment tokens over the stored token', () => {
    saveSpritesToken('stored-token');
    process.env.SPRITES_TOKEN = 'env-token';

    expect(resolveSpritesToken('explicit-token')).toBe('explicit-token');
    expect(resolveSpritesToken()).toBe('env-token');
  });

  it('deletes the stored token', () => {
    saveSpritesToken('stored-token');

    expect(deleteStoredSpritesToken()).toBe(true);
    expect(deleteStoredSpritesToken()).toBe(false);
    expect(fs.existsSync(getSpritesCredentialsPath())).toBe(false);
  });

  it('rejects blank tokens', () => {
    expect(() => saveSpritesToken('   ')).toThrow(/Invalid Sprites token/);
  });
});
