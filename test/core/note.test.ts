import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNote, readNote, listNotes, findNoteBySlug } from '../../src/core/note.js';
import { writeDefaultConfig, loadConfig } from '../../src/core/config.js';
import type { GraniteConfig } from '../../src/core/types.js';

describe('note', () => {
  let tmpDir: string;
  let config: GraniteConfig;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-note-'));
    writeDefaultConfig(tmpDir);
    config = loadConfig(tmpDir);
    // Create type folders
    for (const tc of Object.values(config.note_types)) {
      fs.mkdirSync(path.join(tmpDir, tc.folder), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a note with correct frontmatter', () => {
    const note = createNote(tmpDir, config, 'permanent', 'My Test Note');
    expect(note.slug).toBe('my-test-note');
    expect(note.frontmatter.title).toBe('My Test Note');
    expect(note.frontmatter.type).toBe('permanent');
    expect(note.frontmatter.id).toBeTruthy();
    expect(note.frontmatter.review_state).toBe('draft');
    expect(note.frontmatter.durability).toBe('canonical');
    expect(note.frontmatter.derived_from).toEqual([]);
    expect(fs.existsSync(note.filepath)).toBe(true);
  });

  it('creates a fleeting note with date-based slug', () => {
    const note = createNote(tmpDir, config, 'fleeting', 'Quick thought');
    expect(note.slug).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/);
    expect(note.frontmatter.title).toBe('Quick thought');
    expect(note.frontmatter.type).toBe('fleeting');
    expect(note.frontmatter.durability).toBe('working');
  });

  it('creates a note with custom body', () => {
    const note = createNote(tmpDir, config, 'permanent', 'Quick', 'Custom body text\n');
    expect(note.body).toBe('Custom body text\n');
  });

  it('handles slug collision', () => {
    const note1 = createNote(tmpDir, config, 'permanent', 'Duplicate');
    const note2 = createNote(tmpDir, config, 'permanent', 'Duplicate');
    expect(note1.slug).toBe('duplicate');
    expect(note2.slug).toBe('duplicate-2');
  });

  it('throws for unknown note type', () => {
    expect(() => createNote(tmpDir, config, 'unknown', 'Test')).toThrow('Unknown note type');
  });

  it('reads a note back correctly', () => {
    const created = createNote(tmpDir, config, 'permanent', 'Readable');
    const read = readNote(created.filepath);
    expect(read.slug).toBe('readable');
    expect(read.frontmatter.title).toBe('Readable');
    expect(read.frontmatter.type).toBe('permanent');
  });

  it('lists all notes across types', () => {
    createNote(tmpDir, config, 'fleeting', 'Note A');
    createNote(tmpDir, config, 'permanent', 'Note B');
    createNote(tmpDir, config, 'reference', 'Note C');
    const notes = listNotes(tmpDir, config);
    expect(notes).toHaveLength(3);
  });

  it('finds a note by slug', () => {
    createNote(tmpDir, config, 'permanent', 'Findable Note');
    const found = findNoteBySlug(tmpDir, config, 'findable-note');
    expect(found).not.toBeNull();
    expect(found!.frontmatter.title).toBe('Findable Note');
  });

  it('returns null for non-existent slug', () => {
    const found = findNoteBySlug(tmpDir, config, 'does-not-exist');
    expect(found).toBeNull();
  });
});
