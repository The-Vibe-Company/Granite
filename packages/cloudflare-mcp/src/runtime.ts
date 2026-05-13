import matter from 'gray-matter';
import yaml from 'js-yaml';
import { R2VaultStorage } from './storage/r2.js';
import { parseWikilinks, resolveWikilinks, slugify } from './lib/wikilinks.js';
import { DEFAULT_TYPE_FOLDERS, resolveTypeFolder } from './lib/config.js';
import { parseJsonArray } from './lib/json.js';
import type { CanonicalCloudMcpRuntime } from './mcp.js';

interface GraniteConfig {
  vault_name: string;
  version: number;
  note_types: Record<string, NoteTypeConfig>;
  defaults: { note_type: string; editor?: string };
  index?: { auto_rebuild: boolean };
}

interface NoteTypeConfig {
  folder: string;
  description: string;
  template?: string;
  line_limit?: number;
  warn_only?: boolean;
  slug_format?: 'title' | 'date';
  instructions?: string;
  fields?: Record<string, unknown>;
  frontmatter_defaults?: Record<string, unknown>;
}

interface IndexedNote {
  slug: string;
  id: string;
  title: string;
  type: string;
  created: string;
  modified: string;
  tags: string;
  aliases: string;
  body: string;
  filepath: string;
  status: string;
  source: string;
  review_state: string;
  durability: string;
  derived_from: string;
}

interface IndexedLink {
  source_slug: string;
  target_slug: string | null;
  target_raw: string;
  context: string;
}

const RESERVED_FRONTMATTER_KEYS = new Set([
  'id', 'title', 'type', 'created', 'modified',
  'tags', 'aliases', 'status', 'source',
  'review_state', 'durability', 'derived_from',
]);

export interface ImportPayload {
  config: string;
  notes: Array<{ path: string; content: string }>;
  assets?: Array<{ path: string; content_base64: string; content_type?: string }>;
}

export class CloudMcpRuntime implements CanonicalCloudMcpRuntime {
  private configCache: GraniteConfig | null = null;

  constructor(
    private vaultId: string,
    private storage: R2VaultStorage,
    private index: VaultSqlIndex,
  ) {}

  async importVault(payload: ImportPayload): Promise<{ note_count: number; asset_count: number }> {
    const parsedConfig = yaml.load(payload.config) as GraniteConfig;
    assertGraniteConfig(parsedConfig);

    const seenSlugs = new Set<string>();
    const seenPaths = new Set<string>(['granite.yml']);
    for (const note of payload.notes) {
      assertSafeNotePath(note.path);
      if (seenPaths.has(note.path)) throw new Error(`Duplicate import path: ${note.path}`);
      seenPaths.add(note.path);
      const slug = slugFromImportPath(note.path);
      if (seenSlugs.has(slug)) throw new Error(`Duplicate note slug in import: ${slug}`);
      seenSlugs.add(slug);
    }
    for (const asset of payload.assets ?? []) {
      assertSafeImportPath(asset.path);
      if (seenPaths.has(asset.path)) throw new Error(`Duplicate import path: ${asset.path}`);
      seenPaths.add(asset.path);
    }

    await this.index.initialize();
    await this.storage.writeText('granite.yml', payload.config, 'text/yaml');
    await this.index.clear();
    this.configCache = parsedConfig;

    for (const note of payload.notes) {
      await this.storage.writeText(note.path, note.content, 'text/markdown');
      const indexed = parseNoteContent(note.path, note.content);
      await this.index.upsertNote(indexed);
    }

    for (const asset of payload.assets ?? []) {
      const bytes = decodeBase64(asset.content_base64);
      await this.storage.writeBytes(asset.path, bytes, asset.content_type);
    }

    await this.rebuildLinks();
    return { note_count: payload.notes.length, asset_count: payload.assets?.length ?? 0 };
  }

  async listNotes(filters: { type?: string; status?: string; source?: string; since?: string } = {}): Promise<any[]> {
    await this.index.initialize();
    const notes = await this.index.listNotes({ ...filters, limit: 500 });
    return notes.map(toSummary);
  }

  async getNote(slug: string): Promise<any> {
    await this.index.initialize();
    return this.noteDetails(slug);
  }

  async graph(): Promise<{ nodes: Array<{ slug: string; title: string; type: string }>; edges: Array<{ source: string; target: string }> }> {
    await this.index.initialize();
    const notes = await this.index.listNotes({ limit: 1000 });
    const links = await this.index.listLinks();
    return {
      nodes: notes.map(n => ({ slug: n.slug, title: n.title, type: n.type })),
      edges: links
        .filter(link => link.target_slug)
        .map(link => ({ source: link.source_slug, target: link.target_slug! })),
    };
  }

  async wakeup(): Promise<any> {
    await this.index.initialize();
    const notes = await this.index.listNotes({ limit: 100 });
    const byType = countBy(notes, n => n.type);
    const modified = notes.reduce((latest, note) => note.modified > latest ? note.modified : latest, '');
    return {
      total: notes.length,
      by_type: byType,
      modified,
      clusters: [],
      people: [],
      recent: notes.slice(0, 10).map(note => ({ slug: note.slug, age: note.modified })),
      stale: [],
      aaak: `Granite cloud vault ${this.vaultId}: ${notes.length} note(s).`,
    };
  }

  async researchTopic(input: { query: string; limit?: number }): Promise<any[]> {
    await this.index.initialize();
    return this.index.search(input.query, clamp(input.limit, 10, 50));
  }

  async captureKnowledge(input: Parameters<CanonicalCloudMcpRuntime['captureKnowledge']>[0]): Promise<any> {
    await this.index.initialize();
    const config = await this.getConfig();
    const type = input.type ?? config.defaults.note_type;
    const typeConfig = config.note_types[type];
    if (!typeConfig) throw new Error(`Unknown note type: ${type}`);

    const title = input.title ?? deriveTitle(input.text ?? input.body ?? '');
    if (!title) throw new Error('granite_capture_knowledge requires either text, or title with body/text.');

    const slug = await this.allocateSlug(title, typeConfig);
    const now = new Date().toISOString();
    const body = normalizeBody(input.body ?? input.text ?? typeConfig.template ?? '');
    const frontmatter = {
      id: crypto.randomUUID(),
      title,
      type,
      created: now,
      modified: now,
      tags: input.tags ?? [],
      aliases: input.aliases ?? [],
      status: input.status ?? 'active',
      source: input.source ?? 'human',
      review_state: input.review_state ?? 'draft',
      durability: input.durability ?? String(typeConfig.frontmatter_defaults?.durability ?? 'working'),
      derived_from: input.derived_from ?? [],
      ...stripReservedFields(input.fields ?? {}),
    };
    const folder = resolveTypeFolder(type, typeConfig.folder);
    const filepath = `${folder}/${slug}.md`;
    const content = matter.stringify(body, frontmatter);

    await this.storage.writeText(filepath, content, 'text/markdown');
    await this.index.upsertNote(parseNoteContent(filepath, content));
    await this.indexLinksFor(slug, body);

    return { note: await this.noteDetails(slug), recommendations: emptyRecommendations() };
  }

  async understandNote(input: { slug: string }): Promise<any> {
    await this.index.initialize();
    const note = await this.noteDetails(input.slug);
    const backlinks = await this.index.backlinks(input.slug);
    return {
      note,
      backlinks,
      link_suggestions: [],
      recommendations: emptyRecommendations(),
      graph_role: {
        role: backlinks.length > 3 ? 'hub' : 'leaf',
        reason: 'Computed from deterministic cloud index links.',
        inbound_links: backlinks.length,
        outbound_links: note.outgoing_links.length,
        total_connections: backlinks.length + note.outgoing_links.length,
      },
    };
  }

  async reviseNote(input: Parameters<CanonicalCloudMcpRuntime['reviseNote']>[0]): Promise<any> {
    await this.index.initialize();
    const indexed = await this.index.getNote(input.slug);
    if (!indexed) throw new Error(`Note not found: ${input.slug}`);

    const raw = await this.storage.readText(indexed.filepath);
    const parsed = matter(raw);
    const frontmatter = { ...parsed.data };
    let body = parsed.content;

    if (input.title !== undefined) frontmatter.title = input.title;
    if (input.tags) frontmatter.tags = mergeStrings(frontmatter.tags, input.tags);
    if (input.aliases) frontmatter.aliases = mergeStrings(frontmatter.aliases, input.aliases);
    if (input.status !== undefined) frontmatter.status = input.status;
    if (input.source !== undefined) frontmatter.source = input.source;
    if (input.review_state !== undefined) frontmatter.review_state = input.review_state;
    if (input.durability !== undefined) frontmatter.durability = input.durability;
    if (input.derived_from !== undefined) frontmatter.derived_from = input.derived_from;
    if (input.fields) Object.assign(frontmatter, stripReservedFields(input.fields));
    if (input.body !== undefined) body = normalizeBody(input.body);
    if (input.append !== undefined) body = `${body.trimEnd()}\n${input.append}\n`;
    frontmatter.modified = new Date().toISOString();

    const content = matter.stringify(body, frontmatter);
    await this.storage.writeText(indexed.filepath, content, 'text/markdown');
    await this.index.upsertNote(parseNoteContent(indexed.filepath, content));
    await this.indexLinksFor(input.slug, body);

    return { note: await this.noteDetails(input.slug), recommendations: emptyRecommendations() };
  }

  async query(input: Parameters<CanonicalCloudMcpRuntime['query']>[0]): Promise<any[]> {
    await this.index.initialize();
    const rows = await this.index.listNotes({
      type: input.type,
      limit: clamp(input.limit, 25, 200),
      status: stringWhere(input.where, 'status'),
      source: stringWhere(input.where, 'source'),
      sortField: input.sort_field,
      sortDir: input.sort_dir,
    });
    return rows.map(note => ({ ...toSummary(note), fields: {} }));
  }

  async compileContext(input: Parameters<CanonicalCloudMcpRuntime['compileContext']>[0]): Promise<any[]> {
    await this.index.initialize();
    if (input.slug) {
      const note = await this.index.getNote(input.slug);
      return note ? [{ ...toSummary(note), fields: {} }] : [];
    }
    if (input.topic) {
      const results = await this.researchTopic({ query: input.topic, limit: input.limit });
      return results.map(result => ({
        slug: result.slug,
        title: result.title,
        type: 'note',
        modified: '',
        fields: { snippet: result.snippet },
      }));
    }
    return this.query({ limit: input.limit });
  }

  async planGarden(input: { anchor_slug?: string; limit?: number }): Promise<any> {
    await this.index.initialize();
    const notes = await this.index.listNotes({ limit: 1000 });
    return {
      scope: {
        kind: input.anchor_slug ? 'anchor' : 'vault',
        anchor_slug: input.anchor_slug,
        generated_at: new Date().toISOString(),
        notes_considered: notes.length,
        clusters_considered: 0,
      },
      operator_hint: 'Cloud V1 returns deterministic empty garden plans until the full local garden planner is ported.',
      opportunities: [],
    };
  }

  async disposeNote(input: { slug: string; mode?: 'archive' | 'delete' }): Promise<any> {
    await this.index.initialize();
    const note = await this.index.getNote(input.slug);
    if (!note) throw new Error(`Note not found: ${input.slug}`);

    if (input.mode === 'delete') {
      await this.storage.delete(note.filepath);
      await this.index.deleteNote(input.slug);
      return { slug: input.slug, mode: 'delete', backlinks_removed: 0, derived_children: 0, note: null };
    }

    const result = await this.reviseNote({ slug: input.slug, status: 'archived' });
    return { slug: input.slug, mode: 'archive', backlinks_removed: 0, derived_children: 0, note: result.note };
  }

  private async getConfig(): Promise<GraniteConfig> {
    if (this.configCache) return this.configCache;
    if (!await this.storage.exists('granite.yml')) {
      this.configCache = defaultConfig();
      await this.storage.writeText('granite.yml', yaml.dump(this.configCache), 'text/yaml');
    } else {
      this.configCache = yaml.load(await this.storage.readText('granite.yml')) as GraniteConfig;
      assertGraniteConfig(this.configCache);
    }
    return this.configCache;
  }

  private async noteDetails(slug: string): Promise<any> {
    const indexed = await this.index.getNote(slug);
    if (!indexed) throw new Error(`Note not found: ${slug}`);
    const raw = await this.storage.readText(indexed.filepath);
    const parsed = matter(raw);
    const allNotes = await this.index.listNotes({ limit: 5000 });
    return {
      ...toSummary(indexed),
      body: parsed.content,
      frontmatter: parsed.data,
      outgoing_links: resolveWikilinks(parseWikilinks(parsed.content), allNotes),
    };
  }

  private async allocateSlug(title: string, typeConfig: NoteTypeConfig): Promise<string> {
    const base = typeConfig.slug_format === 'date'
      ? `${new Date().toISOString().slice(0, 10)}-${slugify(title)}`
      : slugify(title);
    let slug = base || 'untitled';
    let counter = 2;
    while (await this.index.getNote(slug)) {
      slug = `${base}-${counter++}`;
    }
    return slug;
  }

  private async rebuildLinks(): Promise<void> {
    const notes = await this.index.listNotes({ limit: 5000 });
    for (const note of notes) {
      await this.indexLinksFor(note.slug, note.body, notes);
    }
  }

  private async indexLinksFor(slug: string, body: string, indexedNotes?: IndexedNote[]): Promise<void> {
    const notes = indexedNotes ?? await this.index.listNotes({ limit: 5000 });
    const links = resolveWikilinks(parseWikilinks(body), notes).map(link => ({
      source_slug: slug,
      target_slug: link.resolved_slug ?? null,
      target_raw: link.target,
      context: body.split('\n').find(line => line.includes(link.raw))?.trim() ?? '',
    }));
    await this.index.setLinks(slug, links);
  }
}

export class VaultSqlIndex {
  constructor(private sqlStorage: DurableObjectStorage) {}

  async initialize(): Promise<void> {
    const sql = this.sqlStorage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        slug TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        tags TEXT NOT NULL,
        aliases TEXT NOT NULL,
        body TEXT NOT NULL,
        filepath TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        review_state TEXT NOT NULL,
        durability TEXT NOT NULL,
        derived_from TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS links (
        source_slug TEXT NOT NULL,
        target_slug TEXT,
        target_raw TEXT NOT NULL,
        context TEXT NOT NULL
      )
    `);
    sql.exec('CREATE INDEX IF NOT EXISTS idx_notes_modified ON notes(modified)');
    sql.exec('CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_slug)');
  }

  async clear(): Promise<void> {
    this.sqlStorage.sql.exec('DELETE FROM links');
    this.sqlStorage.sql.exec('DELETE FROM notes');
  }

  async upsertNote(note: IndexedNote): Promise<void> {
    this.sqlStorage.sql.exec(`
      INSERT INTO notes (
        slug, id, title, type, created, modified, tags, aliases, body, filepath,
        status, source, review_state, durability, derived_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        id = excluded.id,
        title = excluded.title,
        type = excluded.type,
        created = excluded.created,
        modified = excluded.modified,
        tags = excluded.tags,
        aliases = excluded.aliases,
        body = excluded.body,
        filepath = excluded.filepath,
        status = excluded.status,
        source = excluded.source,
        review_state = excluded.review_state,
        durability = excluded.durability,
        derived_from = excluded.derived_from
    `, note.slug, note.id, note.title, note.type, note.created, note.modified, note.tags, note.aliases, note.body,
      note.filepath, note.status, note.source, note.review_state, note.durability, note.derived_from);
  }

  async deleteNote(slug: string): Promise<void> {
    this.sqlStorage.sql.exec('DELETE FROM links WHERE source_slug = ? OR target_slug = ?', slug, slug);
    this.sqlStorage.sql.exec('DELETE FROM notes WHERE slug = ?', slug);
  }

  async getNote(slug: string): Promise<IndexedNote | null> {
    return this.rows<IndexedNote>('SELECT * FROM notes WHERE slug = ?', slug)[0] ?? null;
  }

  async listNotes(options: {
    type?: string;
    status?: string;
    source?: string;
    since?: string;
    limit?: number;
    sortField?: string;
    sortDir?: 'asc' | 'desc';
  } = {}): Promise<IndexedNote[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.type) { clauses.push('type = ?'); params.push(options.type); }
    if (options.status) { clauses.push('status = ?'); params.push(options.status); }
    if (options.source) { clauses.push('source = ?'); params.push(options.source); }
    if (options.since) { clauses.push('modified >= ?'); params.push(options.since); }
    const sortField = ['title', 'type', 'created', 'modified', 'status', 'source'].includes(options.sortField ?? '')
      ? options.sortField
      : 'modified';
    const sortDir = options.sortDir === 'asc' ? 'ASC' : 'DESC';
    params.push(clamp(options.limit, 25, 1000));
    return this.rows<IndexedNote>(
      `SELECT * FROM notes${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${sortField} ${sortDir} LIMIT ?`,
      ...params,
    );
  }

  async search(query: string, limit: number): Promise<any[]> {
    const needle = query.toLowerCase();
    const rows = await this.listNotes({ limit: 1000 });
    return rows
      .filter(row => `${row.title}\n${row.body}\n${row.tags}`.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(row => ({
        slug: row.slug,
        title: row.title,
        snippet: snippet(row.body, needle),
        score: 1,
      }));
  }

  async setLinks(sourceSlug: string, links: IndexedLink[]): Promise<void> {
    this.sqlStorage.sql.exec('DELETE FROM links WHERE source_slug = ?', sourceSlug);
    for (const link of links) {
      this.sqlStorage.sql.exec(
        'INSERT INTO links (source_slug, target_slug, target_raw, context) VALUES (?, ?, ?, ?)',
        link.source_slug, link.target_slug, link.target_raw, link.context,
      );
    }
  }

  async listLinks(): Promise<IndexedLink[]> {
    return this.rows<IndexedLink>('SELECT * FROM links');
  }

  async backlinks(slug: string): Promise<any[]> {
    return this.rows<{ source_slug: string; source_title: string; context: string }>(`
      SELECT l.source_slug, n.title AS source_title, l.context
      FROM links l
      JOIN notes n ON n.slug = l.source_slug
      WHERE l.target_slug = ?
      ORDER BY n.title
    `, slug);
  }

  private rows<T>(query: string, ...params: unknown[]): T[] {
    return [...this.sqlStorage.sql.exec<T>(query, ...params)];
  }
}

function parseNoteContent(filepath: string, content: string): IndexedNote {
  const parsed = matter(content);
  const data = parsed.data;
  const slug = filepath.split('/').pop()?.replace(/\.md$/, '') || slugify(String(data.title ?? 'untitled'));
  return {
    slug,
    id: String(data.id ?? crypto.randomUUID()),
    title: String(data.title ?? slug),
    type: String(data.type ?? 'note'),
    created: toIso(data.created),
    modified: toIso(data.modified),
    tags: JSON.stringify(arrayOfStrings(data.tags)),
    aliases: JSON.stringify(arrayOfStrings(data.aliases)),
    body: parsed.content,
    filepath,
    status: String(data.status ?? 'active'),
    source: String(data.source ?? 'human'),
    review_state: String(data.review_state ?? 'draft'),
    durability: String(data.durability ?? 'working'),
    derived_from: JSON.stringify(arrayOfStrings(data.derived_from)),
  };
}

function toSummary(note: IndexedNote): any {
  return {
    slug: note.slug,
    title: note.title,
    type: note.type,
    created: note.created,
    modified: note.modified,
    tags: parseJsonArray(note.tags),
    aliases: parseJsonArray(note.aliases),
    status: note.status,
    source: note.source,
    review_state: note.review_state,
    durability: note.durability,
    derived_from: parseJsonArray(note.derived_from),
    filepath: note.filepath,
    resource_uri: `granite://notes/${encodeURIComponent(note.slug)}`,
  };
}

function defaultConfig(): GraniteConfig {
  return {
    vault_name: 'Cloud Vault',
    version: 1,
    note_types: Object.fromEntries(Object.entries(DEFAULT_TYPE_FOLDERS).map(([type, folder]) => [type, {
      folder,
      description: `${type} note`,
      template: '',
      line_limit: 300,
      warn_only: true,
      slug_format: 'title',
    }])),
    defaults: { note_type: 'note', editor: '$EDITOR' },
    index: { auto_rebuild: true },
  };
}

function assertGraniteConfig(value: unknown): asserts value is GraniteConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid Granite config.');
  const config = value as Partial<GraniteConfig>;
  if (!config.defaults?.note_type || !config.note_types || typeof config.note_types !== 'object') {
    throw new Error('Invalid Granite config.');
  }
  if (!config.note_types[config.defaults.note_type]) {
    throw new Error('Invalid Granite config.');
  }
}

function assertSafeNotePath(path: string): void {
  assertSafeImportPath(path);
  if (!path.endsWith('.md') || path === 'granite.yml' || !slugFromImportPath(path)) {
    throw new Error(`Invalid note import path: ${path}`);
  }
}

function assertSafeImportPath(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').includes('..') ||
    path === 'granite.yml'
  ) {
    throw new Error(`Invalid import path: ${path}`);
  }
}

function slugFromImportPath(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? '';
}

function normalizeBody(body: string): string {
  return body.endsWith('\n') ? body : `${body}\n`;
}

function stripReservedFields(fields: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!RESERVED_FRONTMATTER_KEYS.has(key)) sanitized[key] = value;
  }
  return sanitized;
}

function deriveTitle(text: string): string {
  const firstLine = text.split('\n').find(line => line.trim())?.trim() ?? '';
  if (!firstLine) return '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 80).trim()}...` : firstLine;
}

function emptyRecommendations() {
  return { additions: [], links: [], tags: [], next_steps: [] };
}

function arrayOfStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string' && value) return [value];
  return [];
}

function mergeStrings(existing: unknown, next: string[]): string[] {
  return [...new Set([...arrayOfStrings(existing), ...next.map(item => item.trim()).filter(Boolean)])];
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) return value;
  return new Date().toISOString();
}

function countBy<T>(items: T[], fn: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) result[fn(item)] = (result[fn(item)] ?? 0) + 1;
  return result;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(value ?? fallback, max));
}

function stringWhere(where: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof where?.[key] === 'string' ? where[key] : undefined;
}

function snippet(body: string, needle: string): string {
  const lower = body.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return body.slice(0, 180);
  return body.slice(Math.max(0, idx - 60), idx + 120);
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
