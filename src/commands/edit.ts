import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { findNoteBySlug } from '../core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';

interface EditOptions {
  body?: string;
  append?: string;
  title?: string;
  tag?: string;
}

export function editCommand(slug: string, options: EditOptions): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const note = findNoteBySlug(vaultRoot, config, slug);

  if (!note) {
    console.error(`Note not found: ${slug}`);
    process.exit(1);
  }

  const hasFlags = options.body !== undefined || options.append !== undefined || options.title !== undefined || options.tag !== undefined;

  if (hasFlags) {
    // Programmatic edit (agent mode)
    let { frontmatter, body } = parseFrontmatter(fs.readFileSync(note.filepath, 'utf-8'));

    if (options.title) {
      frontmatter.title = options.title;
    }

    if (options.tag) {
      const newTags = options.tag.split(',').map(t => t.trim()).filter(Boolean);
      const existing = new Set(frontmatter.tags);
      for (const t of newTags) existing.add(t);
      frontmatter.tags = [...existing];
    }

    if (options.body !== undefined) {
      body = options.body + '\n';
    }

    if (options.append !== undefined) {
      body = body.trimEnd() + '\n' + options.append + '\n';
    }

    frontmatter.modified = new Date().toISOString();
    fs.writeFileSync(note.filepath, serializeFrontmatter(frontmatter, body), 'utf-8');

    console.log(note.filepath);
  } else {
    // Interactive edit (human mode) — open in $EDITOR
    const editor = process.env.EDITOR || 'vi';
    const statBefore = fs.statSync(note.filepath).mtimeMs;

    try {
      execSync(`${editor} "${note.filepath}"`, { stdio: 'inherit' });
    } catch {
      console.error(`Failed to open editor: ${editor}`);
      process.exit(1);
    }

    // If file was modified, update the modified timestamp in frontmatter
    const statAfter = fs.statSync(note.filepath).mtimeMs;
    if (statAfter !== statBefore) {
      const { frontmatter, body } = parseFrontmatter(fs.readFileSync(note.filepath, 'utf-8'));
      frontmatter.modified = new Date().toISOString();
      fs.writeFileSync(note.filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
      console.log(`Updated: ${note.filepath}`);
    }
  }
}
