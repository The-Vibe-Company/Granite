import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import { createNote } from '../../src/core/note.js';
import type { GraniteConfig } from '../../src/core/types.js';
import { GraniteMcpRuntime } from '../../src/mcp/runtime.js';

describe('GraniteMcpRuntime', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-runtime-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);

    for (const typeConfig of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, typeConfig.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rebuilds a stale index on first refresh after a note deletion', () => {
    createNote(tmpDir, config, 'note', 'Stable Note', 'Persistent note.\n');
    const deleted = createNote(tmpDir, config, 'note', 'Deleted Note', 'Unique deleted content.\n');

    let runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    expect(runtime.search('deleted')).toHaveLength(1);
    runtime.close();

    fs.unlinkSync(deleted.filepath);

    runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    expect(runtime.search('deleted')).toHaveLength(0);
    runtime.close();
  });

  it('preserves created and modified timestamps when no metadata mutations are requested', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const result = runtime.createNote({
      title: 'Fresh Note',
      type: 'note',
      body: 'No extra metadata.\n',
    });

    expect(result.note.frontmatter.created).toBe(result.note.frontmatter.modified);
    runtime.close();
  });

  it('revises a note type and keeps it addressable by slug', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const created = runtime.createNote({
      title: 'Type Promotion',
      type: 'note',
      body: 'Promote me.\n',
    });

    const revised = runtime.reviseNote(created.note.slug, { type: 'source' });

    expect(revised.note.type).toBe('source');
    expect(revised.note.slug).toBe(created.note.slug);
    runtime.close();
  });

  it('deletes a note and removes it from search', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const created = runtime.createNote({
      title: 'Disposable',
      type: 'note',
      body: 'Delete me from the index.\n',
    });

    expect(runtime.search('delete')).toHaveLength(1);

    const disposed = runtime.disposeNote(created.note.slug, 'delete');

    expect(disposed.note).toBeNull();
    expect(runtime.search('delete')).toHaveLength(0);
    runtime.close();
  });

  it('imports a document with provided content and exposes the linked asset resource', () => {
    const runtime = new GraniteMcpRuntime(tmpDir, { indexCheckIntervalMs: 0 });
    const inputFile = path.join(tmpDir, 'design-brief.pdf');
    fs.writeFileSync(inputFile, '%PDF-1.4\nbrief\n');

    const imported = runtime.importDocument({
      file_path: inputFile,
      content: 'Design brief for the Q2 launch.\n- Audience: founders\n- Goal: clarify positioning',
    });

    expect(imported.note.type).toBe('source');
    expect(imported.note.status).toBe('inbox');
    expect(imported.note.source).toBe('extraction');
    expect(imported.note.frontmatter.document_file).toBe(imported.document.file);
    expect(imported.document.resource_uri).toBe(`granite://assets/${encodeURIComponent(imported.document.file)}`);
    expect(imported.note.body).toContain('## Content');
    expect(imported.note.body).toContain('Design brief for the Q2 launch.');

    const asset = runtime.readAsset(imported.document.file);
    expect('blob' in asset).toBe(true);
    expect(asset.mimeType).toBe('application/pdf');
    runtime.close();
  });
});
