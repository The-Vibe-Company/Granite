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
    createNote(tmpDir, config, 'permanent', 'Stable Note', 'Persistent note.\n');
    const deleted = createNote(tmpDir, config, 'permanent', 'Deleted Note', 'Unique deleted content.\n');

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
      type: 'permanent',
      body: 'No extra metadata.\n',
    });

    expect(result.note.frontmatter.created).toBe(result.note.frontmatter.modified);
    runtime.close();
  });
});
