import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { slugify } from './slugify.js';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import type { GraniteConfig, Note, NoteFrontmatter } from './types.js';

export function createNote(
  vaultRoot: string,
  config: GraniteConfig,
  typeName: string,
  title: string,
  bodyOverride?: string,
): Note {
  const typeConfig = config.note_types[typeName];
  if (!typeConfig) {
    throw new Error(`Unknown note type: "${typeName}". Available: ${Object.keys(config.note_types).join(', ')}`);
  }

  const folder = path.join(vaultRoot, typeConfig.folder);
  let finalSlug: string;

  if (typeConfig.slug_format === 'date') {
    // Date-based slug: 2026-03-30-a1b2
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const rand = Math.random().toString(36).slice(2, 6);
    finalSlug = `${date}-${rand}`;
    while (fs.existsSync(path.join(folder, `${finalSlug}.md`))) {
      const r = Math.random().toString(36).slice(2, 6);
      finalSlug = `${date}-${r}`;
    }
  } else {
    let slug = slugify(title);
    if (!slug) slug = 'untitled';
    finalSlug = slug;
    let counter = 2;
    while (fs.existsSync(path.join(folder, `${finalSlug}.md`))) {
      finalSlug = `${slug}-${counter}`;
      counter++;
    }
  }

  const now = new Date().toISOString();
  const defaults = typeConfig.frontmatter_defaults ?? {};
  const frontmatter: NoteFrontmatter = {
    id: uuidv4(),
    title,
    type: typeName,
    created: now,
    modified: now,
    tags: [],
    aliases: [],
    status: defaults.status ?? 'active',
    source: defaults.source ?? 'human',
    review_state: defaults.review_state ?? 'draft',
    durability: defaults.durability ?? 'working',
    derived_from: defaults.derived_from ?? [],
  };

  const body = bodyOverride ?? typeConfig.template;
  const content = serializeFrontmatter(frontmatter, body);
  const filepath = path.join(folder, `${finalSlug}.md`);

  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');

  return {
    slug: finalSlug,
    filepath,
    frontmatter,
    body,
    outgoing_links: [],
  };
}

export function readNote(filepath: string): Note {
  const content = fs.readFileSync(filepath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);
  const slug = path.basename(filepath, '.md');
  return { slug, filepath, frontmatter, body, outgoing_links: [] };
}

export function listNotes(vaultRoot: string, config: GraniteConfig): Note[] {
  const notes: Note[] = [];
  for (const typeConfig of Object.values(config.note_types)) {
    const folder = path.join(vaultRoot, typeConfig.folder);
    if (!fs.existsSync(folder)) continue;
    const files = fs.readdirSync(folder).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const filepath = path.join(folder, file);
      notes.push(readNote(filepath));
    }
  }
  return notes;
}

export function findNoteBySlug(vaultRoot: string, config: GraniteConfig, slug: string): Note | null {
  for (const typeConfig of Object.values(config.note_types)) {
    const filepath = path.join(vaultRoot, typeConfig.folder, `${slug}.md`);
    if (fs.existsSync(filepath)) {
      return readNote(filepath);
    }
  }
  return null;
}
