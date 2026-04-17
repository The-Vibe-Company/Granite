import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { resolveText, suggestStub } from '../../src/core/resolve.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('resolveText', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-resolve-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const t of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, t.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches by exact slug and surfaces FTS fallbacks', () => {
    createNote(tmpDir, config, 'note', 'Monka Care', 'Health startup in France.\n');
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const bySlug = resolveText(db, 'monka-care');
    expect(bySlug[0].slug).toBe('monka-care');
    expect(bySlug[0].reason).toBe('slug');

    const byContent = resolveText(db, 'France');
    expect(byContent[0]?.slug).toBe('monka-care');
    expect(byContent[0]?.reason).toBe('fts');

    db.close();
  });

  it('returns no matches for unknown text', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    expect(resolveText(db, 'nonexistent')).toEqual([]);
    db.close();
  });

  it('returns [] for empty input and filters by target_type', () => {
    createNote(tmpDir, config, 'note', 'Apollo', 'Space note.\n');
    createNote(tmpDir, config, 'source', 'Apollo Source', 'content.\n');
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    expect(resolveText(db, '   ')).toEqual([]);

    const onlyNotes = resolveText(db, 'Apollo', { target_type: 'note' });
    expect(onlyNotes.every(m => m.type === 'note')).toBe(true);

    db.close();
  });

  it('matches by exact title and alias', () => {
    createNote(tmpDir, config, 'note', 'Exact Title', 'body.\n', {
      extraFrontmatter: { aliases: ['Nickname'] },
    });
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const byTitle = resolveText(db, 'Exact Title');
    expect(byTitle[0].reason === 'slug' || byTitle[0].reason === 'title').toBe(true);

    const byAlias = resolveText(db, 'Nickname');
    expect(byAlias[0]?.slug).toBe('exact-title');

    db.close();
  });

  it('suggestStub produces a sluggified stub', () => {
    expect(suggestStub('Acme Corp', 'organization')).toEqual({
      type: 'organization',
      title: 'Acme Corp',
      slug: 'acme-corp',
    });
    expect(suggestStub('  ', 'organization').slug).toBe('untitled');
  });
});
