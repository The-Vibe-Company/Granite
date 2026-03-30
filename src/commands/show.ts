import fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { findNoteBySlug } from '../core/note.js';
import { jsonSuccess, jsonError } from '../core/json-output.js';

export function showCommand(slug: string, options: { json?: boolean; body?: boolean }): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const note = findNoteBySlug(vaultRoot, config, slug);

  if (!note) {
    if (options.json) {
      console.log(jsonError(`Note not found: ${slug}`));
    } else {
      console.error(`Note not found: ${slug}`);
    }
    process.exit(1);
  }

  if (options.json) {
    console.log(jsonSuccess({
      slug: note.slug,
      title: note.frontmatter.title,
      type: note.frontmatter.type,
      created: note.frontmatter.created,
      modified: note.frontmatter.modified,
      tags: note.frontmatter.tags,
      aliases: note.frontmatter.aliases,
      body: note.body,
      filepath: note.filepath,
    }));
    return;
  }

  if (options.body) {
    process.stdout.write(note.body);
    return;
  }

  // Default: print full file content
  console.log(`# ${note.frontmatter.title}  (${note.slug})`);
  console.log(`# type: ${note.frontmatter.type}  |  modified: ${note.frontmatter.modified.slice(0, 10)}`);
  console.log('');
  const content = fs.readFileSync(note.filepath, 'utf-8');
  console.log(content);
}
