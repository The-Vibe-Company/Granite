import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, writeDefaultConfig } from '../../src/core/config.js';
import { createDatabase, openDatabase, rebuildIndex, syncNoteInIndex } from '../../src/core/index-db.js';
import { createNote, findNoteBySlug, readNote } from '../../src/core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/core/frontmatter.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('index-db incremental flows', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-idx-incremental-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recreates the index when the schema version is outdated', () => {
    const dbPath = path.join(tmpDir, '.granite', 'index.db');
    const firstDb = createDatabase(dbPath);
    firstDb.prepare('UPDATE meta SET value = ? WHERE key = ?').run('1', 'schema_version');
    firstDb.close();

    const reopened = openDatabase(tmpDir);
    const version = reopened.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string };
    expect(version.value).toBe('2');
    reopened.close();
  });

  it('syncs a single note incrementally and resolves alias links', () => {
    createNote(tmpDir, config, 'permanent', 'Target Note', 'Target.\n');

    const targetPath = path.join(tmpDir, config.note_types.permanent.folder, 'target-note.md');
    const targetContent = fs.readFileSync(targetPath, 'utf-8');
    fs.writeFileSync(
      targetPath,
      targetContent.replace('aliases: []', 'aliases:\n  - TN'),
      'utf-8',
    );

    const draft = createNote(tmpDir, config, 'permanent', 'Draft', 'Start.\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const draftNote = findNoteBySlug(tmpDir, config, draft.slug);
    expect(draftNote).not.toBeNull();

    const updatedDraft = {
      ...draftNote!,
      body: 'Updated body with [[TN]].\n',
    };

    syncNoteInIndex(tmpDir, config, db, updatedDraft);

    const stored = db.prepare('SELECT body FROM notes WHERE slug = ?').get('draft') as { body: string };
    const link = db.prepare('SELECT target_slug FROM links WHERE source_slug = ?').get('draft') as { target_slug: string };

    expect(stored.body).toContain('[[TN]]');
    expect(link.target_slug).toBe('target-note');

    db.close();
  });

  it('rebuilds the whole index when note counts drift from disk', () => {
    const keep = createNote(tmpDir, config, 'permanent', 'Keep', 'Still here.\n');
    const remove = createNote(tmpDir, config, 'permanent', 'Remove', 'Will be deleted.\n');

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    fs.unlinkSync(remove.filepath);

    syncNoteInIndex(tmpDir, config, db, readNote(keep.filepath));

    const count = db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number };
    expect(count.c).toBe(1);
    expect(
      db.prepare('SELECT slug FROM notes').all() as Array<{ slug: string }>,
    ).toEqual([{ slug: 'keep' }]);

    db.close();
  });

  it('keeps malformed alias JSON from crashing link resolution', () => {
    createNote(tmpDir, config, 'permanent', 'Target Note', 'Target.\n');

    const targetPath = path.join(tmpDir, config.note_types.permanent.folder, 'target-note.md');
    const targetContent = fs.readFileSync(targetPath, 'utf-8');
    const parsed = parseFrontmatter(targetContent);
    parsed.frontmatter.aliases = [] as string[];
    fs.writeFileSync(
      targetPath,
      serializeFrontmatter(parsed.frontmatter, parsed.body),
      'utf-8',
    );

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    db.prepare('UPDATE notes SET aliases = ? WHERE slug = ?').run('not-json', 'target-note');

    const note = createNote(tmpDir, config, 'permanent', 'Draft', 'Link to [[Target Note]].\n');
    syncNoteInIndex(tmpDir, config, db, readNote(note.filepath));

    const link = db.prepare('SELECT target_slug FROM links WHERE source_slug = ?').get('draft') as { target_slug: string };
    expect(link.target_slug).toBe('target-note');

    db.close();
  });
});
