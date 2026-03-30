import fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { createNote, listNotes } from '../core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { jsonSuccess, validateStatus, validateSource } from '../core/json-output.js';

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

  const lines = note.body.split('\n').length;
  const overLimit = typeConfig && typeConfig.line_limit && lines > typeConfig.line_limit;

  // Suggest links: check if any existing note titles/aliases appear in the note content
  const textToScan = (note.body + ' ' + title).toLowerCase();
  const allNotes = listNotes(vaultRoot, config).filter(n => n.slug !== note.slug);
  const suggestions: Array<{ slug: string; title: string; type: string }> = [];

  for (const other of allNotes) {
    const otherTitle = other.frontmatter.title.toLowerCase();
    if (otherTitle.length < 3) continue; // skip very short titles
    if (textToScan.includes(otherTitle)) {
      suggestions.push({ slug: other.slug, title: other.frontmatter.title, type: other.frontmatter.type });
      continue;
    }
    // Check aliases
    for (const alias of other.frontmatter.aliases) {
      if (alias.length < 3) continue;
      if (textToScan.includes(alias.toLowerCase())) {
        suggestions.push({ slug: other.slug, title: other.frontmatter.title, type: other.frontmatter.type });
        break;
      }
    }
  }

  if (options.json) {
    console.log(jsonSuccess({
      slug: note.slug,
      title: note.frontmatter.title,
      type: resolvedType,
      status: note.frontmatter.status,
      source: note.frontmatter.source,
      filepath: note.filepath,
      suggestions,
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

  if (suggestions.length > 0) {
    console.log('');
    console.log('  🔗 Linked notes detected:');
    for (const s of suggestions) {
      console.log(`     [[${s.slug}]] — ${s.title} (${s.type})`);
    }
  }
}
