import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { resolveText } from '../../src/core/resolve.js';
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
});
