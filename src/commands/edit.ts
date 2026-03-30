import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { findNoteBySlug, readNote } from '../core/note.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { validateStatus, validateSource } from '../core/json-output.js';
import { recommendNote, formatRecommendations } from '../core/recommendations.js';

interface EditOptions {
  body?: string;
  append?: string;
  title?: string;
  tag?: string;
  alias?: string;
  status?: string;
  source?: string;
}

export function editCommand(slug: string, options: EditOptions): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const note = findNoteBySlug(vaultRoot, config, slug);

  if (!note) {
    console.error(`Note not found: ${slug}`);
    process.exit(1);
  }

  const hasFlags = options.body !== undefined || options.append !== undefined || options.title !== undefined || options.tag !== undefined || options.alias !== undefined || options.status !== undefined || options.source !== undefined;

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

    if (options.alias) {
      const newAliases = options.alias.split(',').map(a => a.trim()).filter(Boolean);
      const existing = new Set(frontmatter.aliases);
      for (const a of newAliases) existing.add(a);
      frontmatter.aliases = [...existing];
    }

    if (options.status) {
      validateStatus(options.status);
      frontmatter.status = options.status;
    }

    if (options.source) {
      validateSource(options.source);
      frontmatter.source = options.source;
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
    printRecommendations(vaultRoot, config, note.filepath);
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
      printRecommendations(vaultRoot, config, note.filepath);
    }
  }
}

function printRecommendations(vaultRoot: string, config: ReturnType<typeof loadConfig>, filepath: string): void {
  const updatedNote = readNote(filepath);
  const recommendations = recommendNote(vaultRoot, config, updatedNote, { strategy: 'incremental' });
  const lines = formatRecommendations(recommendations);

  if (lines.length === 0) return;

  console.log('');
  console.log('Recommendations:');
  for (const line of lines) {
    console.log(line);
  }
}
