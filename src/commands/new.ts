import fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { createNote } from '../core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { jsonSuccess, validateStatus, validateSource } from '../core/json-output.js';
import { recommendNote, formatRecommendations } from '../core/recommendations.js';
import { getSyncManager } from '../core/sync/manager.js';

export function newNote(title: string, options: { type?: string; source?: string; status?: string; json?: boolean }): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const resolvedType = options.type || config.defaults.note_type;
  const typeConfig = config.note_types[resolvedType];

  // For date-slug types (like fleeting), the title IS the content
  const bodyOverride = typeConfig?.slug_format === 'date' ? title + '\n' : undefined;
  const note = createNote(vaultRoot, config, resolvedType, title, bodyOverride);

  // Apply source/status overrides
  if (options.source || options.status) {
    if (options.source) validateSource(options.source);
    if (options.status) validateStatus(options.status);
    const raw = fs.readFileSync(note.filepath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    if (options.source) frontmatter.source = options.source as typeof frontmatter.source;
    if (options.status) frontmatter.status = options.status as typeof frontmatter.status;
    fs.writeFileSync(note.filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
    note.frontmatter = frontmatter;
  }

  const recommendationStrategy = typeConfig?.slug_format === 'date' ? 'incremental' : 'rebuild';
  const recommendations = recommendNote(vaultRoot, config, note, { strategy: recommendationStrategy });

  const lines = note.body.split('\n').length;
  const overLimit = typeConfig && typeConfig.line_limit && lines > typeConfig.line_limit;

  // Transparent sync: track + push in background
  const sync = getSyncManager(vaultRoot, config);
  sync?.trackAndPush(note, 'create');

  if (options.json) {
    console.log(jsonSuccess({
      slug: note.slug,
      title: note.frontmatter.title,
      type: resolvedType,
      status: note.frontmatter.status,
      source: note.frontmatter.source,
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
