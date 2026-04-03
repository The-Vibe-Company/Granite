import fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { createNote } from '../core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import {
  jsonSuccess,
  validateDurability,
  validateReviewState,
  validateStatus,
  validateSource,
} from '../core/json-output.js';
import { recommendNote, formatRecommendations } from '../core/recommendations.js';

export function newNote(
  title: string,
  options: {
    type?: string;
    source?: string;
    status?: string;
    reviewState?: string;
    durability?: string;
    derivedFrom?: string;
    json?: boolean;
  },
): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const resolvedType = options.type || config.defaults.note_type;
  const typeConfig = config.note_types[resolvedType];

  // For date-slug types, the title doubles as the initial body content.
  const bodyOverride = typeConfig?.slug_format === 'date' ? title + '\n' : undefined;
  const note = createNote(vaultRoot, config, resolvedType, title, bodyOverride);

  // Apply frontmatter overrides
  if (
    options.source !== undefined ||
    options.status !== undefined ||
    options.reviewState !== undefined ||
    options.durability !== undefined ||
    options.derivedFrom !== undefined
  ) {
    if (options.source !== undefined) validateSource(options.source);
    if (options.status !== undefined) validateStatus(options.status);
    if (options.reviewState !== undefined) validateReviewState(options.reviewState);
    if (options.durability !== undefined) validateDurability(options.durability);
    const raw = fs.readFileSync(note.filepath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    if (options.source !== undefined) frontmatter.source = options.source as typeof frontmatter.source;
    if (options.status !== undefined) frontmatter.status = options.status as typeof frontmatter.status;
    if (options.reviewState !== undefined) frontmatter.review_state = options.reviewState as typeof frontmatter.review_state;
    if (options.durability !== undefined) frontmatter.durability = options.durability as typeof frontmatter.durability;
    if (options.derivedFrom !== undefined) {
      frontmatter.derived_from = options.derivedFrom.split(',').map(value => value.trim()).filter(Boolean);
    }
    fs.writeFileSync(note.filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
    note.frontmatter = frontmatter;
  }

  const recommendationStrategy = typeConfig?.slug_format === 'date' ? 'incremental' : 'rebuild';
  const recommendations = recommendNote(vaultRoot, config, note, { strategy: recommendationStrategy });

  const lines = note.body.split('\n').length;
  const overLimit = typeConfig && typeConfig.line_limit && lines > typeConfig.line_limit;

  if (options.json) {
    console.log(jsonSuccess({
      slug: note.slug,
      title: note.frontmatter.title,
      type: resolvedType,
      status: note.frontmatter.status,
      source: note.frontmatter.source,
      review_state: note.frontmatter.review_state,
      durability: note.frontmatter.durability,
      derived_from: note.frontmatter.derived_from,
      filepath: note.filepath,
      suggestions: recommendations.links.map(link => ({
        slug: link.slug,
        title: link.title,
        type: link.type,
      })),
      recommendations,
    }));
    return;
  }

  if (overLimit) {
    const action = typeConfig.warn_only ? 'Warning' : 'Error';
    console.warn(`${action}: Note exceeds ${typeConfig.line_limit} line limit for type "${resolvedType}"`);
  }

  console.log(note.filepath);

  // Show instructions if available
  if (typeConfig?.instructions) {
    console.log('');
    console.log(`  💡 ${typeConfig.instructions}`);
  }

  const recommendationLines = formatRecommendations(recommendations);
  if (recommendationLines.length > 0) {
    console.log('');
    console.log('Recommendations:');
    for (const line of recommendationLines) {
      console.log(line);
    }
  }
}
