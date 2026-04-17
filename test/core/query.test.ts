import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { runQuery } from '../../src/core/query.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('runQuery', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-query-'));
    const cfg: GraniteConfig = {
      vault_name: 't', version: 1,
      note_types: {
        note: { folder: 'notes', description: '', template: '', line_limit: 200, warn_only: false },
        meeting: {
          folder: 'meetings',
          description: '',
          template: '## Summary\n',
          line_limit: 300,
          warn_only: true,
          fields: {
            date: { type: 'date' },
            organization: { type: 'wikilink', target_types: ['organization'] },
          },
          indexed_fields: ['date', 'organization'],
        },
        organization: {
          folder: 'orgs',
          description: '',
          template: '',
          line_limit: 300,
          warn_only: true,
          fields: { kind: { type: 'enum', options: ['client'] } },
          indexed_fields: ['kind'],
        },
      },
      defaults: { note_type: 'note', editor: '$EDITOR' },
      index: { auto_rebuild: true },
    };
    fs.writeFileSync(path.join(tmpDir, 'granite.yml'), yaml.dump(cfg));
    for (const t of Object.values(cfg.note_types)) {
      fs.mkdirSync(path.join(tmpDir, t.folder), { recursive: true });
    }
    config = loadConfig(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters by type and indexed field equality', () => {
    createNote(tmpDir, config, 'meeting', 'Kickoff', '## Summary\n', {
      extraFrontmatter: { date: '2026-03-01', organization: 'acme' },
    });
    createNote(tmpDir, config, 'meeting', 'Review', '## Summary\n', {
      extraFrontmatter: { date: '2026-03-15', organization: 'beta' },
    });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const results = runQuery(db, config, {
      type: 'meeting',
      where: { organization: 'acme' },
    });
    expect(results.map(r => r.slug)).toEqual(['kickoff']);

    db.close();
  });

  it('rejects filtering on a non-indexed field', () => {
    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);
    expect(() => runQuery(db, config, { type: 'meeting', where: { body: 'foo' } }))
      .toThrow(/not indexed/);
    db.close();
  });

  it('supports gte/lte range filters on dates', () => {
    createNote(tmpDir, config, 'meeting', 'Old', '## Summary\n', {
      extraFrontmatter: { date: '2025-01-01' },
    });
    createNote(tmpDir, config, 'meeting', 'Recent', '## Summary\n', {
      extraFrontmatter: { date: '2026-03-15' },
    });

    const db = createDatabase(path.join(tmpDir, '.granite', 'index.db'));
    rebuildIndex(tmpDir, config, db);

    const results = runQuery(db, config, {
      type: 'meeting',
      where: { date: { gte: '2026-01-01' } },
    });
    expect(results.map(r => r.slug)).toEqual(['recent']);
    db.close();
  });
});
