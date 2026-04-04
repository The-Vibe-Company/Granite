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
    console.log(`"${existingNote.frontmatter.title}" is well-connected. No actions needed.`);
    console.log('');
    console.log('Keep the loop going: granite status');
    return;
  }

  console.log(`Recommendations for "${existingNote.frontmatter.title}" (${existingNote.frontmatter.type}):`);
  console.log('');
  for (const line of lines) {
    console.log(line);
  }

  // Contextual guidance based on what's recommended
  console.log('');
  if (recommendations.next_steps.length > 0) {
    const step = recommendations.next_steps[0];
    const hint = step.title_hint ? ` "${step.title_hint}"` : '';
    console.log(`The vault is asking for: granite new${hint} --type ${step.type}`);
  } else if (recommendations.links.length > 0) {
    console.log(`Strengthen this note: granite edit ${slug} --append $'See also: [[${recommendations.links[0].slug}]]'`);
  }
}
