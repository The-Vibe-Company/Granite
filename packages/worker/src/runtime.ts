import matter from 'gray-matter';
import type { R2NoteStorage } from './storage/r2.js';
import type { D1IndexDatabase } from './storage/d1.js';
import { parseJsonArray } from './lib/json.js';
import { DEFAULT_TYPE_FOLDERS, resolveTypeFolder } from './lib/config.js';

// --- Pure function imports (same logic as src/core/) ---

function slugify(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'untitled';
}

interface WikiLink {
  raw: string;
  target: string;
  display: string;
  resolved: boolean;
  resolved_slug?: string;
}

function parseWikilinks(body: string): WikiLink[] {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');

  const links: WikiLink[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(cleaned)) !== null) {
    const inner = match[1];
    const pipeIndex = inner.indexOf('|');
    const target = pipeIndex >= 0 ? inner.slice(0, pipeIndex).trim() : inner.trim();
    const display = pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : inner.trim();

    links.push({
      raw: match[0],
      target,
      display,
      resolved: false,
    });
  }

  return links;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const { data, content: body } = matter(content);
  return {
    frontmatter: {
      id: String(data.id ?? ''),
      title: String(data.title ?? ''),
      type: String(data.type ?? ''),
      created: data.created instanceof Date ? data.created.toISOString() : String(data.created ?? ''),
      modified: data.modified instanceof Date ? data.modified.toISOString() : String(data.modified ?? ''),
      tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : [],
      aliases: Array.isArray(data.aliases) ? data.aliases : data.aliases ? [data.aliases] : [],
      status: data.status ?? 'active',
      source: data.source ?? 'human',
      ...Object.fromEntries(
        Object.entries(data).filter(([k]) => !['id', 'title', 'type', 'created', 'modified', 'tags', 'aliases', 'status', 'source'].includes(k))
      ),
    },
    body,
  };
}

function serializeFrontmatter(fm: Record<string, unknown>, body: string): string {
  return matter.stringify(body, fm);
}

// --- Types ---

interface GraniteConfig {
  vault_name: string;
  version: number;
  note_types: Record<string, NoteTypeConfig>;
  defaults: { note_type: string; editor: string };
  index: { auto_rebuild: boolean };
}

interface NoteTypeConfig {
  folder: string;
  description: string;
  template: string;
  line_limit: number;
  warn_only: boolean;
  slug_format?: 'title' | 'date';
  instructions?: string;
  fields?: Record<string, unknown>;
}

export interface NoteSummary {
  slug: string;
  title: string;
  type: string;
  created: string;
  modified: string;
  tags: string[];
  aliases: string[];
  status: string;
  source: string;
  filepath: string;
  resource_uri: string;
}

export interface NoteDetails extends NoteSummary {
  body: string;
  frontmatter: Record<string, unknown>;
  outgoing_links: WikiLink[];
}

export interface SearchResult {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

export interface BacklinkEntry {
  source_slug: string;
  source_title: string;
  context: string;
}

export interface LinkSuggestion {
  target_slug: string;
  target_title: string;
  mentions: number;
}

export interface NoteRecommendations {
  additions: Array<{ text: string }>;
  links: Array<{ slug: string; title: string; type: string; reason: string; source: 'mention' | 'search' }>;
  tags: Array<{ tag: string; weight: number; source_slugs: string[] }>;
  next_steps: Array<{ type: string; title_hint?: string; reason: string }>;
}

interface NoteMutationResult {
  note: NoteDetails;
  recommendations: NoteRecommendations;
}

export interface ListNotesInput {
  type?: string;
  status?: string;
  source?: string;
  since?: string;
  limit?: number;
}

export interface CreateNoteInput {
  title: string;
  type?: string;
  body?: string;
  tags?: string[];
  aliases?: string[];
  status?: string;
  source?: string;
}

export interface UpdateNoteInput {
  title?: string;
  body?: string;
  append?: string;
  tags?: string[];
  aliases?: string[];
  status?: string;
  source?: string;
}

// --- Runtime ---

export class CloudMcpRuntime {
  private config: GraniteConfig | null = null;

  constructor(
    private storage: R2NoteStorage,
    private db: D1IndexDatabase,
    private maxNotesPerVault = Infinity,
  ) {}

  private async getConfig(): Promise<GraniteConfig> {
    if (this.config) return this.config;
    try {
      const raw = await this.storage.readConfig();
      const yaml = await import('js-yaml');
      this.config = yaml.load(raw) as GraniteConfig;
    } catch {
      // Return default config if not found in R2
      this.config = getDefaultConfig();
    }
    return this.config!;
  }

  async getVaultOverview(recentLimit = 10): Promise<{
    vault_name: string;
    default_type: string;
    note_count: number;
    notes_by_type: Record<string, number>;
    recent_notes: NoteSummary[];
  }> {
    const config = await this.getConfig();
    const allNotes = await this.db.getAllNotesMeta();

    const byType: Record<string, number> = {};
    for (const n of allNotes) {
      byType[n.type] = (byType[n.type] ?? 0) + 1;
    }

    const limit = Math.max(1, Math.min(recentLimit, 20));
    const recent = allNotes.slice(0, limit).map(n => this.toNoteSummary(n));

    return {
      vault_name: config.vault_name,
      default_type: config.defaults.note_type,
      note_count: allNotes.length,
      notes_by_type: byType,
      recent_notes: recent,
    };
  }

  async listNoteTypes(): Promise<Array<{ name: string; description: string; folder: string; slug_format: string; instructions?: string }>> {
    const config = await this.getConfig();
    return Object.entries(config.note_types).map(([name, tc]) => ({
      name,
      description: tc.description,
      folder: tc.folder,
      slug_format: tc.slug_format ?? 'title',
      instructions: tc.instructions,
    }));
  }

  async listNotes(input: ListNotesInput = {}): Promise<NoteSummary[]> {
    let notes = await this.db.getAllNotesMeta();

    if (input.type) notes = notes.filter(n => n.type === input.type);
    if (input.status) notes = notes.filter(n => n.status === input.status);
    if (input.source) notes = notes.filter(n => n.source === input.source);
    if (input.since) {
      const since = input.since;
      notes = notes.filter(n => n.modified >= since);
    }

    const limit = Math.max(1, Math.min(input.limit ?? 25, 200));
    return notes.slice(0, limit).map(n => this.toNoteSummary(n));
  }

  async getNote(slug: string): Promise<NoteDetails> {
    const config = await this.getConfig();
    const indexed = await this.db.getNote(slug);
    if (!indexed) throw new Error(`Note not found: ${slug}`);

    const typeConfig = config.note_types[indexed.type];
    const folder = resolveTypeFolder(indexed.type, typeConfig?.folder);
    const content = await this.storage.readNote(folder, slug);
    const { frontmatter, body } = parseFrontmatter(content);

    const allNotes = await this.db.getAllNotesMeta();
    const links = parseWikilinks(body);
    const resolvedLinks = links.map(link => {
      const targetSlug = slugify(link.target);
      const found = allNotes.find(n =>
        n.slug === targetSlug ||
        n.title.toLowerCase() === link.target.toLowerCase()
      );
      return { ...link, resolved: !!found, resolved_slug: found?.slug };
    });

    return {
      ...this.toNoteSummary(indexed),
      body,
      frontmatter,
      outgoing_links: resolvedLinks,
    };
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    return this.db.searchNotes(query, limit);
  }

  async getBacklinks(slug: string): Promise<BacklinkEntry[]> {
    return this.db.getBacklinks(slug);
  }

  async suggestLinks(slug: string): Promise<LinkSuggestion[]> {
    const indexed = await this.db.getNote(slug);
    if (!indexed) throw new Error(`Note not found: ${slug}`);

    const existingLinks = new Set(parseWikilinks(indexed.body).map(l => l.target.toLowerCase()));
    const allNotes = await this.db.getAllNotesMeta();
    const bodyLower = indexed.body.toLowerCase();
    const suggestions: LinkSuggestion[] = [];

    for (const other of allNotes) {
      if (other.slug === slug) continue;
      const titleLower = other.title.toLowerCase();
      if (!titleLower) continue;
      if (existingLinks.has(titleLower) || existingLinks.has(other.slug)) continue;

      let mentions = 0;
      let idx = 0;
      while ((idx = bodyLower.indexOf(titleLower, idx)) !== -1) {
        mentions++;
        idx += titleLower.length;
      }

      if (mentions > 0) {
        suggestions.push({ target_slug: other.slug, target_title: other.title, mentions });
      }
    }

    return suggestions.sort((a, b) => b.mentions - a.mentions);
  }

  async createNote(input: CreateNoteInput): Promise<NoteMutationResult> {
    // Enforce per-vault note limit
    if (this.maxNotesPerVault < Infinity) {
      const count = await this.db.countNotes();
      if (count >= this.maxNotesPerVault) {
        throw new Error(`Vault note limit reached (${this.maxNotesPerVault}). Upgrade to pro for more.`);
      }
    }

    const config = await this.getConfig();
    const typeName = input.type ?? config.defaults.note_type;
    const typeConfig = config.note_types[typeName];
    if (!typeConfig) throw new Error(`Unknown note type: "${typeName}"`);

    let finalSlug: string;
    if (typeConfig.slug_format === 'date') {
      const date = new Date().toISOString().slice(0, 10);
      const rand = Math.random().toString(36).slice(2, 6);
      finalSlug = `${date}-${rand}`;
    } else {
      finalSlug = slugify(input.title) || 'untitled';
      if (await this.storage.noteExists(typeConfig.folder, finalSlug)) {
        let counter = 2;
        while (await this.storage.noteExists(typeConfig.folder, `${finalSlug}-${counter}`)) {
          counter++;
        }
        finalSlug = `${finalSlug}-${counter}`;
      }
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const frontmatter: Record<string, unknown> = {
      id,
      title: input.title,
      type: typeName,
      created: now,
      modified: now,
      tags: input.tags ?? [],
      aliases: input.aliases ?? [],
      status: input.status ?? 'active',
      source: input.source ?? 'human',
    };

    const body = input.body !== undefined
      ? (input.body.endsWith('\n') ? input.body : input.body + '\n')
      : typeConfig.slug_format === 'date'
        ? input.title + '\n'
        : typeConfig.template;

    const content = serializeFrontmatter(frontmatter, body);

    await this.storage.writeNote(typeConfig.folder, finalSlug, content);

    const links = parseWikilinks(body);
    await this.db.upsertNote({
      slug: finalSlug,
      id,
      title: input.title,
      type: typeName,
      created: now,
      modified: now,
      tags: JSON.stringify(input.tags ?? []),
      aliases: JSON.stringify(input.aliases ?? []),
      body,
      filepath: `${typeConfig.folder}/${finalSlug}.md`,
      status: input.status ?? 'active',
      source: input.source ?? 'human',
    });

    await this.indexLinks(finalSlug, body, links);

    const note = await this.getNote(finalSlug);
    return { note, recommendations: emptyRecommendations() };
  }

  async captureNote(input: { text: string; type?: string; tags?: string[]; status?: string; source?: string }): Promise<NoteMutationResult> {
    const text = input.text.trim();
    if (!text) throw new Error('Capture text cannot be empty.');
    const firstLine = text.split('\n')[0] ?? 'Untitled';
    const title = firstLine.length > 60 ? firstLine.slice(0, 60).trim() + '...' : firstLine;
    return this.createNote({
      title,
      type: input.type,
      body: text + '\n',
      tags: input.tags,
      status: input.status,
      source: input.source,
    });
  }

  async updateNote(slug: string, input: UpdateNoteInput): Promise<NoteMutationResult> {
    const config = await this.getConfig();
    const indexed = await this.db.getNote(slug);
    if (!indexed) throw new Error(`Note not found: ${slug}`);

    const typeConfig = config.note_types[indexed.type];
    const folder = resolveTypeFolder(indexed.type, typeConfig?.folder);

    const content = await this.storage.readNote(folder, slug);
    const { frontmatter, body: existingBody } = parseFrontmatter(content);
    let body = existingBody;

    if (input.title !== undefined) frontmatter.title = input.title;
    if (input.tags && input.tags.length > 0) {
      const existing = new Set(frontmatter.tags as string[] ?? []);
      for (const t of input.tags) existing.add(t.trim());
      frontmatter.tags = [...existing];
    }
    if (input.aliases && input.aliases.length > 0) {
      const existing = new Set(frontmatter.aliases as string[] ?? []);
      for (const a of input.aliases) existing.add(a.trim());
      frontmatter.aliases = [...existing];
    }
    if (input.status !== undefined) frontmatter.status = input.status;
    if (input.source !== undefined) frontmatter.source = input.source;
    if (input.body !== undefined) body = input.body.endsWith('\n') ? input.body : input.body + '\n';
    if (input.append !== undefined) body = body.trimEnd() + '\n' + input.append + '\n';

    frontmatter.modified = new Date().toISOString();

    const newContent = serializeFrontmatter(frontmatter, body);
    await this.storage.writeNote(folder, slug, newContent);

    await this.db.upsertNote({
      slug,
      id: String(frontmatter.id),
      title: String(frontmatter.title),
      type: indexed.type,
      created: String(frontmatter.created),
      modified: String(frontmatter.modified),
      tags: JSON.stringify(frontmatter.tags),
      aliases: JSON.stringify(frontmatter.aliases),
      body,
      filepath: `${folder}/${slug}.md`,
      status: String(frontmatter.status),
      source: String(frontmatter.source),
    });

    await this.indexLinks(slug, body);

    const note = await this.getNote(slug);
    return { note, recommendations: emptyRecommendations() };
  }

  async readVaultConfigRaw(): Promise<string> {
    return this.storage.readConfig();
  }

  async readNoteMarkdown(slug: string): Promise<string> {
    const config = await this.getConfig();
    const indexed = await this.db.getNote(slug);
    if (!indexed) throw new Error(`Note not found: ${slug}`);
    const typeConfig = config.note_types[indexed.type];
    const folder = resolveTypeFolder(indexed.type, typeConfig?.folder);
    return this.storage.readNote(folder, slug);
  }

  private async indexLinks(slug: string, body: string, links?: WikiLink[]): Promise<void> {
    const wikilinks = links ?? parseWikilinks(body);
    const allNotes = await this.db.getAllNotesMeta();
    const bodyLines = body.split('\n');
    const indexedLinks = wikilinks.map(link => {
      const targetSlug = slugify(link.target);
      const found = allNotes.find(n =>
        n.slug === targetSlug || n.title.toLowerCase() === link.target.toLowerCase(),
      );
      const contextLine = bodyLines.find(l => l.includes(link.raw)) ?? '';
      return {
        target_slug: found?.slug ?? null,
        target_raw: link.target,
        context: contextLine.trim(),
      };
    });
    await this.db.setLinks(slug, indexedLinks);
  }

  private toNoteSummary(n: { slug: string; title: string; type: string; created: string; modified: string; tags: string; aliases: string; status: string; source: string; filepath: string }): NoteSummary {
    return {
      slug: n.slug,
      title: n.title,
      type: n.type,
      created: n.created,
      modified: n.modified,
      tags: parseJsonArray(n.tags),
      aliases: parseJsonArray(n.aliases),
      status: n.status,
      source: n.source,
      filepath: n.filepath,
      resource_uri: `granite://notes/${encodeURIComponent(n.slug)}`,
    };
  }
}

function emptyRecommendations(): NoteRecommendations {
  return { additions: [], links: [], tags: [], next_steps: [] };
}

function getDefaultConfig(): GraniteConfig {
  const defaultType = (folder: string, desc: string, opts: Partial<NoteTypeConfig> = {}): NoteTypeConfig => ({
    folder, description: desc, template: '', line_limit: 200, warn_only: false, ...opts,
  });

  return {
    vault_name: 'My Vault',
    version: 1,
    note_types: Object.fromEntries(
      Object.entries(DEFAULT_TYPE_FOLDERS).map(([type, folder]) => {
        const descriptions: Record<string, string> = {
          fleeting: 'Quick captures', permanent: 'Refined notes', reference: 'External sources',
          person: 'People', meeting: 'Meetings', project: 'Projects', decision: 'Decisions',
        };
        const extra: Partial<NoteTypeConfig> = {};
        if (type === 'fleeting') { extra.slug_format = 'date'; extra.line_limit = 50; extra.warn_only = true; }
        if (type === 'reference') { extra.line_limit = 300; extra.warn_only = true; }
        return [type, defaultType(folder, descriptions[type] ?? type, extra)];
      }),
    ),
    defaults: { note_type: 'fleeting', editor: '$EDITOR' },
    index: { auto_rebuild: true },
  };
}
