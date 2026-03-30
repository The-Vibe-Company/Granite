import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { ensureIndex } from '../core/index-db.js';
import { findNoteBySlug } from '../core/note.js';
import { suggestLinks } from '../core/suggest.js';

export function suggestLinksCommand(slug: string): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const note = findNoteBySlug(vaultRoot, config, slug);

  if (!note) {
    console.error(`Note not found: "${slug}"`);
    process.exit(1);
  }

  const db = ensureIndex(vaultRoot, config);
  const suggestions = suggestLinks(db, note);
  db.close();

  if (suggestions.length === 0) {
    console.log('No link suggestions found.');
    return;
  }

  console.log(`Suggested links for "${note.frontmatter.title}":`);
  console.log('');
  for (const s of suggestions) {
    console.log(`  → [[${s.target_title}]] — ${s.mentions} mention${s.mentions > 1 ? 's' : ''}`);
  }
}
