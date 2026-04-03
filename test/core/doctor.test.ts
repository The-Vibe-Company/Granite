import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNote } from '../../src/core/note.js';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createDatabase, rebuildIndex } from '../../src/core/index-db.js';
import { runDoctor } from '../../src/core/doctor.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('doctor', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-doc-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    for (const tc of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, tc.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function getDb() {
    const dbPath = path.join(tmpDir, '.granite', 'index.db');
    const db = createDatabase(dbPath);
    rebuildIndex(tmpDir, config, db);
    return db;
  }

  it('reports no issues for a healthy vault', () => {
    createNote(tmpDir, config, 'note', 'A', 'Links to [[B]].\n');
    createNote(tmpDir, config, 'note', 'B', 'Links to [[A]].\n');
    const db = getDb();
    const issues = runDoctor(tmpDir, config, db);
    db.close();
    const errors = issues.filter(i => i.level === 'error');
    const warnings = issues.filter(i => i.level === 'warning');
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('detects broken wikilinks', () => {
    createNote(tmpDir, config, 'note', 'Broken Links', 'See [[Ghost Note]] and [[Another Ghost]].\n');
    const db = getDb();
    const issues = runDoctor(tmpDir, config, db);
    db.close();
    const broken = issues.filter(i => i.message.includes('Broken wikilink'));
    expect(broken).toHaveLength(2);
  });

  it('detects orphan notes', () => {
    createNote(tmpDir, config, 'note', 'Lonely', 'No links here.\n');
    const db = getDb();
    const issues = runDoctor(tmpDir, config, db);
    db.close();
    const orphans = issues.filter(i => i.message.includes('Orphan note'));
    expect(orphans).toHaveLength(1);
  });

  it('detects line limit violations', () => {
    const longBody = Array(220).fill('This is a line of text.').join('\n') + '\n';
    createNote(tmpDir, config, 'note', 'Too Long', longBody);
    const db = getDb();
    const issues = runDoctor(tmpDir, config, db);
    db.close();
    const limitIssues = issues.filter(i => i.message.includes('exceeds limit'));
    expect(limitIssues).toHaveLength(1);
    expect(limitIssues[0].level).toBe('error');
  });

  it('warns when a synthesis has no provenance', () => {
    createNote(tmpDir, config, 'synthesis', 'Synthesis Without Sources', '## Scope\n\nBody.\n');
    const db = getDb();
    const issues = runDoctor(tmpDir, config, db);
    db.close();

    const provenanceIssues = issues.filter(issue => issue.message.includes('should declare derived_from'));
    expect(provenanceIssues).toHaveLength(1);
    expect(provenanceIssues[0].level).toBe('warning');
  });
});
