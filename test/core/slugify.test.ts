import { describe, it, expect } from 'vitest';
import { slugify } from '../../src/core/slugify.js';

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('My First Note')).toBe('my-first-note');
  });

  it('strips accents', () => {
    expect(slugify('Café résumé')).toBe('cafe-resume');
  });

  it('removes special characters', () => {
    expect(slugify('Hello, World! #2024')).toBe('hello-world-2024');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('---test---')).toBe('test');
  });

  it('truncates at 60 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  it('collapses multiple spaces/hyphens', () => {
    expect(slugify('foo   bar---baz')).toBe('foo-bar-baz');
  });
});
