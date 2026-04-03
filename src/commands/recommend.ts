import { loadConfig } from '../core/config.js';
import { jsonError, jsonSuccess } from '../core/json-output.js';
import { findNoteBySlug } from '../core/note.js';
import { recommendNote, formatRecommendations } from '../core/recommendations.js';
import { requireVaultRoot } from '../core/vault.js';

export function recommendCommand(slug: string, options: { json?: boolean }): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const note = findNoteBySlug(vaultRoot, config, slug);

  if (!note) {
    if (options.json) {
      console.log(jsonError(`Note not found: ${slug}`));
    } else {
      console.error(`Note not found: "${slug}"`);
    }
    process.exit(1);
  }
  const existingNote = note;

  const recommendations = recommendNote(vaultRoot, config, existingNote);

  if (options.json) {
    console.log(jsonSuccess({
      slug: existingNote.slug,
      title: existingNote.frontmatter.title,
      type: existingNote.frontmatter.type,
      recommendations,
    }));
    return;
  }

  const lines = formatRecommendations(recommendations);
  if (lines.length === 0) {
    console.log(`No recommendations found for "${existingNote.frontmatter.title}".`);
    return;
  }

  console.log(`Recommendations for "${existingNote.frontmatter.title}":`);
  console.log('');
  for (const line of lines) {
    console.log(line);
  }
}
