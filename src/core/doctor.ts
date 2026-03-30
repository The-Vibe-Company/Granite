import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { GraniteConfig, DoctorIssue } from './types.js';
import { listNotes } from './note.js';
import { parseWikilinks, resolveWikilinks } from './wikilinks.js';

export function runDoctor(vaultRoot: string, config: GraniteConfig, db: Database.Database): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const notes = listNotes(vaultRoot, config);

  // 1. Config: check that all type folders exist
  for (const [name, typeConfig] of Object.entries(config.note_types)) {
    const folder = path.join(vaultRoot, typeConfig.folder);
    if (!fs.existsSync(folder)) {
      issues.push({
        level: 'error',
        file: `granite.yml`,
        message: `Note type "${name}" folder does not exist: ${typeConfig.folder}`,
      });
    }
  }

  // 2. Frontmatter validation
  for (const note of notes) {
    const fm = note.frontmatter;
    if (!fm.id) {
      issues.push({ level: 'error', file: note.filepath, message: 'Missing frontmatter field: id' });
    }
    if (!fm.title) {
      issues.push({ level: 'error', file: note.filepath, message: 'Missing frontmatter field: title' });
    }
    if (!fm.type) {
      issues.push({ level: 'warning', file: note.filepath, message: 'Missing frontmatter field: type' });
    }
    if (!fm.created) {
      issues.push({ level: 'warning', file: note.filepath, message: 'Missing frontmatter field: created' });
    }
  }

  // 3. Broken wikilinks
  for (const note of notes) {
    const links = parseWikilinks(note.body);
    const resolved = resolveWikilinks(links, notes);
    for (const link of resolved) {
      if (!link.resolved) {
        issues.push({
          level: 'warning',
          file: note.filepath,
          message: `Broken wikilink: [[${link.target}]]`,
        });
      }
    }
  }

  // 4. Duplicate slugs across type folders
  const slugMap = new Map<string, string[]>();
  for (const note of notes) {
    const existing = slugMap.get(note.slug) ?? [];
    existing.push(note.filepath);
    slugMap.set(note.slug, existing);
  }
  for (const [slug, files] of slugMap) {
    if (files.length > 1) {
      issues.push({
        level: 'warning',
        file: files.join(', '),
        message: `Duplicate slug "${slug}" found in multiple locations`,
      });
    }
  }

  // 5. Duplicate IDs
  const idMap = new Map<string, string[]>();
  for (const note of notes) {
    if (!note.frontmatter.id) continue;
    const existing = idMap.get(note.frontmatter.id) ?? [];
    existing.push(note.filepath);
    idMap.set(note.frontmatter.id, existing);
  }
  for (const [id, files] of idMap) {
    if (files.length > 1) {
      issues.push({
        level: 'error',
        file: files.join(', '),
        message: `Duplicate note ID "${id}"`,
      });
    }
  }

  // 6. Line limit violations
  for (const note of notes) {
    const typeConfig = config.note_types[note.frontmatter.type];
    if (!typeConfig) continue;
    const lineCount = note.body.split('\n').length;
    if (typeConfig.line_limit && lineCount > typeConfig.line_limit) {
      issues.push({
        level: typeConfig.warn_only ? 'warning' : 'error',
        file: note.filepath,
        message: `Note has ${lineCount} lines, exceeds limit of ${typeConfig.line_limit} for type "${note.frontmatter.type}". Consider splitting into smaller notes with [[wikilinks]].`,
      });
    }
  }

  // 7. Orphan notes (no incoming or outgoing links)
  const hasIncoming = new Set<string>();
  const hasOutgoing = new Set<string>();
  for (const note of notes) {
    const links = parseWikilinks(note.body);
    if (links.length > 0) hasOutgoing.add(note.slug);
    const resolved = resolveWikilinks(links, notes);
    for (const link of resolved) {
      if (link.resolved_slug) hasIncoming.add(link.resolved_slug);
    }
  }
  for (const note of notes) {
    if (!hasIncoming.has(note.slug) && !hasOutgoing.has(note.slug)) {
      issues.push({
        level: 'info',
        file: note.filepath,
        message: 'Orphan note: no incoming or outgoing links',
      });
    }
  }

  return issues;
}
