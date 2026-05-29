import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRANITE_VERSION } from '../src/version.js';

describe('GRANITE_VERSION', () => {
  it('matches package.json', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version: string };
    expect(GRANITE_VERSION).toBe(packageJson.version);
  });
});
