import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

interface TypeFilterRegistry {
  visibleTypeNames: (typesPayload: unknown, nodes: unknown) => string[];
  noteType: (result: unknown, nodesBySlug: unknown) => string;
}

function loadTypeFilterRegistry(): TypeFilterRegistry {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/web/public/type-filters.js'),
    'utf8',
  );
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context, { filename: 'type-filters.js' });
  return (context.window as { GraniteTypeFilters: TypeFilterRegistry }).GraniteTypeFilters;
}

describe('web type filters', () => {
  const registry = loadTypeFilterRegistry();

  it('keeps configured order while showing standard and custom types that have notes', () => {
    const types = registry.visibleTypeNames({
      note: {},
      source: {},
      meeting: {},
      output: {},
    }, [
      { slug: 'idea', type: 'note' },
      { slug: 'weekly-sync', type: 'meeting' },
    ]);

    expect(Array.from(types)).toEqual(['note', 'meeting']);
  });

  it('hides every configured type when the vault is empty', () => {
    const types = registry.visibleTypeNames({ note: {}, meeting: {} }, []);

    expect(Array.from(types)).toEqual([]);
  });

  it('deduplicates legacy array payloads and appends unregistered note types', () => {
    const types = registry.visibleTypeNames([
      'source',
      { name: 'note' },
      { type: 'source' },
      null,
    ], [
      { slug: 'raw', type: 'source' },
      { slug: 'retro', type: 'retro' },
      { slug: 'decision', type: 'decision' },
    ]);

    expect(Array.from(types)).toEqual(['source', 'decision', 'retro']);
  });

  it('falls back to graph metadata for legacy search results without a type', () => {
    expect(registry.noteType(
      { slug: 'weekly-sync', title: 'Weekly Sync' },
      { 'weekly-sync': { slug: 'weekly-sync', type: 'meeting' } },
    )).toBe('meeting');
    expect(registry.noteType({ slug: 'missing' }, {})).toBe('note');
  });
});
