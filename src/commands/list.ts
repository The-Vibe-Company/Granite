import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { listNotes } from '../core/note.js';

export function listCommand(options: { type?: string; json?: boolean }): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  let notes = listNotes(vaultRoot, config);

  if (options.type) {
    notes = notes.filter(n => n.frontmatter.type === options.type);
  }

  // Sort by modified desc
  notes.sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));

  if (options.json) {
    const out = notes.map(n => ({
      slug: n.slug,
      title: n.frontmatter.title,
      type: n.frontmatter.type,
      created: n.frontmatter.created,
      modified: n.frontmatter.modified,
      tags: n.frontmatter.tags,
      filepath: n.filepath,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (notes.length === 0) {
    console.log('No notes found.');
    return;
  }

  for (const note of notes) {
    const date = note.frontmatter.modified.slice(0, 10);
    const type = note.frontmatter.type.padEnd(10);
    console.log(`  ${date}  ${type}  ${note.frontmatter.title}  (${note.slug})`);
  }

  console.log(`\n${notes.length} note(s)`);
}
