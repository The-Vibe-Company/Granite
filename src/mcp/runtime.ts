import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { attachAsset, assetResourceUri, completeAssetFiles, readAssetResource, type AttachedAsset } from '../core/assets.js';
import { CONFIG_FILENAME, loadConfig } from '../core/config.js';
import { runDoctor } from '../core/doctor.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { importDocument as importDocumentToVault } from '../core/import-document.js';
import { openDatabase, rebuildIndex, syncNoteInIndex } from '../core/index-db.js';
import { findNoteBySlug, listNotes, createNote, readNote } from '../core/note.js';
import { getRecommendations } from '../core/recommendations.js';
import { searchNotes } from '../core/search.js';
import { suggestLinks } from '../core/suggest.js';
import type {
  BacklinkEntry,
  DoctorIssue,
  Durability,
  GraniteConfig,
  Note,
  NoteFrontmatter,
  NoteSource,
  NoteStatus,
  ReviewState,
  SearchResult,
  WikiLink,
} from '../core/types.js';
import { parseWikilinks, resolveWikilinks } from '../core/wikilinks.js';
import { getBacklinks } from '../core/backlinks.js';
import {
  validateDurability,
  validateReviewState,
  validateSource,
  validateStatus,
} from '../core/json-output.js';

interface VaultSignature {
  noteCount: number;
  latestMutationMs: number;
  configMtimeMs: number;
}

export interface GraniteMcpRuntimeOptions {
  indexCheckIntervalMs?: number;
}

export interface NoteSummary {
  slug: string;
  title: string;
  type: string;
  created: string;
  modified: string;
  tags: string[];
  aliases: string[];
  status: NoteStatus;
  source: NoteSource;
  review_state: ReviewState;
  durability: Durability;
  derived_from: string[];
  filepath: string;
  resource_uri: string;
}

export interface NoteDetails extends NoteSummary {
  body: string;
  frontmatter: NoteFrontmatter;
  outgoing_links: WikiLink[];
}

export interface NoteTypeInfo {
  name: string;
  description: string;
  folder: string;
  line_limit: number;
  warn_only: boolean;
  slug_format: 'title' | 'date';
  instructions?: string;
  fields?: GraniteConfig['note_types'][string]['fields'];
}

export interface VaultOverview {
  vault_root: string;
  vault_name: string;
  default_type: string;
  auto_rebuild: boolean;
  index_last_rebuild?: string;
  note_count: number;
  notes_by_type: Record<string, number>;
  recent_notes: NoteSummary[];
}

export interface NoteRecommendations {
  additions: Array<{ text: string }>;
  links: Array<{ slug: string; title: string; type: string; reason: string; source: 'mention' | 'search' }>;
  tags: Array<{ tag: string; weight: number; source_slugs: string[] }>;
  next_steps: Array<{ type: string; title_hint?: string; reason: string }>;
}

export interface NoteUnderstanding {
  note: NoteDetails;
  backlinks: BacklinkEntry[];
  link_suggestions: Array<{ target_slug: string; target_title: string; mentions: number }>;
  recommendations: NoteRecommendations;
  graph_role: {
    role: 'hub' | 'bridge' | 'reference' | 'isolated' | 'draft' | 'synthesis';
    reason: string;
    inbound_links: number;
    outbound_links: number;
    total_connections: number;
  };
}

export interface CreateNoteInput {
  title: string;
  type?: string;
  body?: string;
  tags?: string[];
  aliases?: string[];
  status?: NoteStatus;
  source?: NoteSource;
  review_state?: ReviewState;
  durability?: Durability;
  derived_from?: string[];
}

export interface CaptureNoteInput {
  text: string;
  type?: string;
  tags?: string[];
  aliases?: string[];
  status?: NoteStatus;
  source?: NoteSource;
  review_state?: ReviewState;
  durability?: Durability;
  derived_from?: string[];
}

export interface UpdateNoteInput {
  type?: string;
  title?: string;
  body?: string;
  append?: string;
  tags?: string[];
  aliases?: string[];
  status?: NoteStatus;
  source?: NoteSource;
  review_state?: ReviewState;
  durability?: Durability;
  derived_from?: string[];
}

export interface ListNotesInput {
  type?: string;
  status?: NoteStatus;
  source?: NoteSource;
  since?: string;
  limit?: number;
}

export interface NoteMutationResult {
  note: NoteDetails;
  recommendations: NoteRecommendations;
}

export interface ImportedDocumentAsset {
  file: string;
  path: string;
  relative_path: string;
  markdown: string;
  mime_type: string;
  sha256: string;
  resource_uri: string;
}

export interface ImportDocumentInput {
  file_path: string;
  content: string;
  title?: string;
  tags?: string[];
  aliases?: string[];
}

export interface ImportDocumentResult {
  note: NoteDetails;
  document: ImportedDocumentAsset;
  recommendations: NoteRecommendations;
}

export interface DisposeNoteResult {
  slug: string;
  mode: 'archive' | 'delete';
  backlinks_removed: number;
  derived_children: number;
  note: NoteDetails | null;
}

export class GraniteMcpRuntime {
  readonly vaultRoot: string;

  private config: GraniteConfig;
  private readonly db: Database.Database;
  private readonly indexCheckIntervalMs: number;
  private lastSignature?: VaultSignature;
  private lastIndexCheckAt = 0;

  constructor(vaultRoot: string, options: GraniteMcpRuntimeOptions = {}) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.config = loadConfig(this.vaultRoot);
    this.db = openDatabase(this.vaultRoot);
    this.indexCheckIntervalMs = options.indexCheckIntervalMs ?? 1500;
  }

  close(): void {
    this.db.close();
  }

  getVaultOverview(recentLimit = 10): VaultOverview {
    const notes = this.readAllNotes()
      .sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));
    const byType: Record<string, number> = {};

    for (const note of notes) {
      byType[note.frontmatter.type] = (byType[note.frontmatter.type] ?? 0) + 1;
    }

    return {
      vault_root: this.vaultRoot,
      vault_name: this.config.vault_name,
      default_type: this.config.defaults.note_type,
      auto_rebuild: this.config.index.auto_rebuild,
      index_last_rebuild: this.getMetaValue('last_rebuild'),
      note_count: notes.length,
      notes_by_type: byType,
      recent_notes: notes.slice(0, clampLimit(recentLimit, 20)).map(note => this.toNoteSummary(note)),
    };
  }

  listNoteTypes(): NoteTypeInfo[] {
    return Object.entries(this.config.note_types).map(([name, typeConfig]) => ({
      name,
      description: typeConfig.description,
      folder: typeConfig.folder,
      line_limit: typeConfig.line_limit,
      warn_only: typeConfig.warn_only,
      slug_format: typeConfig.slug_format ?? 'title',
      instructions: typeConfig.instructions,
      fields: typeConfig.fields,
    }));
  }

  getDefaultNoteType(): string {
    return this.config.defaults.note_type;
  }

  listNotes(input: ListNotesInput = {}): NoteSummary[] {
    let notes = this.readAllNotes();

    if (input.type) {
      notes = notes.filter(note => note.frontmatter.type === input.type);
    }

    if (input.status) {
      notes = notes.filter(note => note.frontmatter.status === input.status);
    }

    if (input.source) {
      notes = notes.filter(note => note.frontmatter.source === input.source);
    }

    if (input.since) {
      const since = input.since;
      notes = notes.filter(note => note.frontmatter.modified >= since);
    }

    notes.sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));

    return notes
      .slice(0, clampLimit(input.limit ?? 25, 200))
      .map(note => this.toNoteSummary(note));
  }

  getNote(slug: string): NoteDetails {
    const note = this.requireNote(slug);
    const allNotes = this.readAllNotes();
    const outgoingLinks = resolveWikilinks(parseWikilinks(note.body), allNotes);

    return {
      ...this.toNoteSummary(note),
      body: note.body,
      frontmatter: note.frontmatter,
      outgoing_links: outgoingLinks,
    };
  }

  search(query: string, limit = 10): SearchResult[] {
    this.refreshIndex();
    return searchNotes(this.db, query, clampLimit(limit, 50));
  }

  getBacklinks(slug: string): BacklinkEntry[] {
    this.requireNote(slug);
    this.refreshIndex();
    return getBacklinks(this.db, slug);
  }

  suggestLinks(slug: string) {
    const note = this.requireNote(slug);
    this.refreshIndex();
    return suggestLinks(this.db, note);
  }

  recommend(slug: string): NoteRecommendations {
    const note = this.requireNote(slug);
    this.refreshIndex();
    return getRecommendations(this.db, note, this.config);
  }

  understandNote(slug: string): NoteUnderstanding {
    const note = this.getNote(slug);
    const backlinks = this.getBacklinks(slug);
    const linkSuggestions = this.suggestLinks(slug);
    const recommendations = this.recommend(slug);
    const outboundLinks = note.outgoing_links.filter(link => link.resolved).length;
    const inboundLinks = backlinks.length;
    const totalConnections = inboundLinks + outboundLinks;

    let role: NoteUnderstanding['graph_role']['role'] = 'isolated';
    let reason = 'This note is currently disconnected from the graph.';

    if (note.frontmatter.status === 'inbox') {
      role = 'draft';
      reason = 'This note is still in the inbox and should be refined before it compounds.';
    } else if (note.frontmatter.type === 'synthesis') {
      role = 'synthesis';
      reason = 'This synthesis connects multiple notes and should remain highly linked.';
    } else if (inboundLinks >= 3 && outboundLinks >= 3) {
      role = 'hub';
      reason = 'This note has strong inbound and outbound links, so it acts as a hub.';
    } else if (inboundLinks > 0 && outboundLinks > 0) {
      role = 'bridge';
      reason = 'This note both references other notes and is referenced back, so it bridges context.';
    } else if (inboundLinks > 0) {
      role = 'reference';
      reason = 'Other notes point here, but this note is not yet linking back into the graph much.';
    }

    return {
      note,
      backlinks,
      link_suggestions: linkSuggestions,
      recommendations,
      graph_role: {
        role,
        reason,
        inbound_links: inboundLinks,
        outbound_links: outboundLinks,
        total_connections: totalConnections,
      },
    };
  }

  runDoctor(): { issues: DoctorIssue[]; counts: { errors: number; warnings: number; info: number } } {
    this.refreshIndex();
    const issues = runDoctor(this.vaultRoot, this.config, this.db);

    return {
      counts: {
        errors: issues.filter(issue => issue.level === 'error').length,
        warnings: issues.filter(issue => issue.level === 'warning').length,
        info: issues.filter(issue => issue.level === 'info').length,
      },
      issues,
    };
  }

  wakeup(): {
    total: number;
    by_type: Record<string, number>;
    modified: string;
    clusters: Array<{ tag: string; slugs: string[]; hub: string | null }>;
    people: Array<{ slug: string; title: string }>;
    recent: Array<{ slug: string; age: string }>;
    stale: Array<{ slug: string; reason: string }>;
    aaak: string;
  } {
    this.refreshIndex();
    const notes = this.readAllNotes().filter(n => n.frontmatter.status !== 'archived');

    // Count connections
    const cx = new Map<string, number>();
    const linkRows = this.db.prepare(
      'SELECT source_slug, target_slug FROM links WHERE target_slug IS NOT NULL',
    ).all() as Array<{ source_slug: string; target_slug: string }>;
    for (const r of linkRows) {
      cx.set(r.source_slug, (cx.get(r.source_slug) ?? 0) + 1);
      cx.set(r.target_slug, (cx.get(r.target_slug) ?? 0) + 1);
    }

    // By type
    const byType: Record<string, number> = {};
    for (const n of notes) byType[n.frontmatter.type] = (byType[n.frontmatter.type] ?? 0) + 1;

    // Clusters by tag
    const tagNotes = new Map<string, Set<string>>();
    for (const n of notes) {
      for (const tag of n.frontmatter.tags ?? []) {
        if (!tagNotes.has(tag)) tagNotes.set(tag, new Set());
        tagNotes.get(tag)!.add(n.slug);
      }
    }
    const assigned = new Set<string>();
    const clusters: Array<{ tag: string; slugs: string[]; hub: string | null }> = [];
    const sortedTags = [...tagNotes.entries()]
      .filter(([, s]) => s.size >= 2)
      .sort((a, b) => b[1].size - a[1].size);
    for (const [tag, slugSet] of sortedTags) {
      const unassigned = [...slugSet].filter(s => !assigned.has(s));
      if (unassigned.length < 2) continue;
      let hub: string | null = null;
      let maxCx = 0;
      for (const s of unassigned) {
        const c = cx.get(s) ?? 0;
        if (c > maxCx) { maxCx = c; hub = s; }
      }
      clusters.push({ tag, slugs: unassigned, hub });
      for (const s of unassigned) assigned.add(s);
    }
    const misc = notes.filter(n => !assigned.has(n.slug)).map(n => n.slug);
    if (misc.length > 0) clusters.push({ tag: 'misc', slugs: misc, hub: null });

    // People
    const people = notes
      .filter(n => (n.frontmatter.tags ?? []).some(t => ['prospect', 'person', 'contact', 'founder', 'client'].includes(t)))
      .map(n => ({ slug: n.slug, title: n.frontmatter.title }));

    // Recent
    const sorted = [...notes].sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));
    const getAge = (d: string): string => {
      const diff = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
      if (diff === 0) return 'today';
      if (diff === 1) return 'yesterday';
      if (diff < 7) return `${diff}d`;
      if (diff < 30) return `${Math.floor(diff / 7)}w`;
      return `${Math.floor(diff / 30)}mo`;
    };
    const recent = sorted.slice(0, 5).map(n => ({ slug: n.slug, age: getAge(n.frontmatter.modified) }));

    // Stale
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    const stale = notes
      .filter(n => n.frontmatter.durability === 'working' && n.frontmatter.modified < twoWeeksAgo && (cx.get(n.slug) ?? 0) < 2)
      .map(n => ({ slug: n.slug, reason: 'working+stale+disconnected' }));

    // AAAK
    const typeBreak = Object.entries(byType).map(([t, c]) => `${c}${t.slice(0, 3)}`).join(',');
    const lastMod = sorted[0]?.frontmatter.modified?.slice(0, 10) ?? '';
    const lines = [`VAULT: ${notes.length}n (${typeBreak}) | modified:${lastMod}`, 'CLUSTERS:'];
    for (const cl of clusters) {
      const slugList = cl.slugs.map(s => {
        const c = cx.get(s) ?? 0;
        const n = notes.find(x => x.slug === s);
        const ann: string[] = [];
        if (s === cl.hub && c >= 5) ann.push('hub');
        if (n?.frontmatter.type === 'synthesis') ann.push('syn');
        if (n?.frontmatter.type === 'source') ann.push('src');
        if (n?.frontmatter.type === 'output') ann.push('out');
        if (c >= 5) ann.push(`${c}cx`);
        const short = s.length > 30 ? s.slice(0, 30) : s;
        return ann.length ? `${short}(${ann.join(',')})` : short;
      });
      lines.push(`  ${cl.tag.toUpperCase()}: ${slugList.join(' ')}`);
    }
    if (people.length) lines.push(`PEOPLE: ${people.map(p => p.title.slice(0, 20)).join(', ')}`);
    if (recent.length) lines.push(`RECENT: ${recent.slice(0, 5).map(r => `${r.slug.slice(0, 25)}(${r.age})`).join(' ')}`);
    const aaak = lines.join('\n');

    return { total: notes.length, by_type: byType, modified: sorted[0]?.frontmatter.modified ?? '', clusters, people, recent, stale, aaak };
  }

  attach(filePath: string, slug?: string): { file: string; path: string; markdown: string; slug: string | null } {
    const asset = attachAsset(this.vaultRoot, filePath);
    return { file: asset.file, path: asset.path, markdown: asset.markdown, slug: slug ?? null };
  }

  createNote(input: CreateNoteInput): NoteMutationResult {
    const resolvedType = input.type ?? this.config.defaults.note_type;
    const typeConfig = this.config.note_types[resolvedType];
    if (!typeConfig) {
      throw new Error(`Unknown note type: "${resolvedType}"`);
    }

    const bodyOverride = input.body !== undefined
      ? ensureTrailingNewline(input.body)
      : typeConfig.slug_format === 'date'
        ? ensureTrailingNewline(input.title)
        : undefined;

    const created = createNote(this.vaultRoot, this.config, resolvedType, input.title, bodyOverride);
    const metadataMutations = {
      tags: input.tags,
      aliases: input.aliases,
      status: input.status,
      source: input.source,
      review_state: input.review_state,
      durability: input.durability,
      derived_from: input.derived_from,
    };

    if (hasMetadataMutations(metadataMutations)) {
      this.applyMutations(created.filepath, metadataMutations);
    }

    return this.afterWrite(created.slug, true);
  }

  captureNote(input: CaptureNoteInput): NoteMutationResult {
    const content = input.text.trim();
    if (!content) {
      throw new Error('Capture text cannot be empty.');
    }

    const firstLine = content.split('\n')[0] ?? 'Untitled';
    const title = firstLine.length > 60 ? `${firstLine.slice(0, 60).trim()}...` : firstLine;

    return this.createNote({
      title,
      type: input.type,
      body: ensureTrailingNewline(content),
      tags: input.tags,
      aliases: input.aliases,
      status: input.status,
      source: input.source,
      review_state: input.review_state,
      durability: input.durability,
      derived_from: input.derived_from,
    });
  }

  importDocument(input: ImportDocumentInput): ImportDocumentResult {
    const imported = importDocumentToVault(this.vaultRoot, this.config, input.file_path, {
      content: input.content,
      title: input.title,
      tags: input.tags,
      aliases: input.aliases,
    });

    const result = this.afterWrite(imported.note.slug, true);
    return {
      note: result.note,
      recommendations: result.recommendations,
      document: this.toImportedDocumentAsset(imported.asset),
    };
  }

  updateNote(slug: string, input: UpdateNoteInput): NoteMutationResult {
    if (input.type !== undefined) {
      return this.reviseNote(slug, input);
    }

    const note = this.requireNote(slug);
    const needsFullRebuild = input.title !== undefined || (input.aliases?.length ?? 0) > 0;

    this.applyMutations(note.filepath, input);

    if (needsFullRebuild) {
      return this.afterWrite(slug, true);
    }

    this.refreshIndex();
    const updated = readNote(note.filepath);
    syncNoteInIndex(this.vaultRoot, this.config, this.db, updated);
    this.captureSignature();

    return {
      note: this.getNote(updated.slug),
      recommendations: getRecommendations(this.db, updated, this.config),
    };
  }

  reviseNote(slug: string, input: UpdateNoteInput): NoteMutationResult {
    const note = this.requireNote(slug);
    const raw = fs.readFileSync(note.filepath, 'utf-8');
    const { frontmatter, body: existingBody } = parseFrontmatter(raw);
    let body = existingBody;
    let nextFilepath = note.filepath;
    let movedType = false;

    if (input.type !== undefined) {
      const nextType = this.config.note_types[input.type];
      if (!nextType) {
        throw new Error(`Unknown note type: "${input.type}"`);
      }

      if (frontmatter.type !== input.type) {
        const targetFolder = path.join(this.vaultRoot, nextType.folder);
        fs.mkdirSync(targetFolder, { recursive: true });
        const candidatePath = path.join(targetFolder, `${slug}.md`);
        if (candidatePath !== note.filepath && fs.existsSync(candidatePath)) {
          throw new Error(`Cannot move "${slug}" to type "${input.type}" because ${candidatePath} already exists.`);
        }
        frontmatter.type = input.type;
        nextFilepath = candidatePath;
        movedType = true;
      }
    }

    if (input.title !== undefined) {
      frontmatter.title = input.title;
    }

    if (input.tags && input.tags.length > 0) {
      frontmatter.tags = mergeUnique(frontmatter.tags, input.tags);
    }

    if (input.aliases && input.aliases.length > 0) {
      frontmatter.aliases = mergeUnique(frontmatter.aliases, input.aliases);
    }

    if (input.status !== undefined) {
      validateStatus(input.status);
      frontmatter.status = input.status;
    }

    if (input.source !== undefined) {
      validateSource(input.source);
      frontmatter.source = input.source;
    }

    if (input.review_state !== undefined) {
      validateReviewState(input.review_state);
      frontmatter.review_state = input.review_state;
    }

    if (input.durability !== undefined) {
      validateDurability(input.durability);
      frontmatter.durability = input.durability;
    }

    if (input.derived_from !== undefined) {
      frontmatter.derived_from = [...input.derived_from];
    }

    if (input.body !== undefined) {
      body = ensureTrailingNewline(input.body);
    }

    if (input.append !== undefined) {
      body = `${body.trimEnd()}\n${input.append}\n`;
    }

    frontmatter.modified = new Date().toISOString();
    fs.writeFileSync(nextFilepath, serializeFrontmatter(frontmatter, body), 'utf-8');

    if (movedType && nextFilepath !== note.filepath && fs.existsSync(note.filepath)) {
      fs.unlinkSync(note.filepath);
    }

    return this.afterWrite(slug, movedType || input.title !== undefined || (input.aliases?.length ?? 0) > 0);
  }

  disposeNote(slug: string, mode: 'archive' | 'delete' = 'archive'): DisposeNoteResult {
    const note = this.requireNote(slug);
    const backlinks = this.getBacklinks(slug);
    const derivedChildren = this.readAllNotes().filter(candidate =>
      candidate.frontmatter.derived_from.includes(slug),
    ).length;

    if (mode === 'archive') {
      const revised = this.reviseNote(slug, { status: 'archived' });
      return {
        slug,
        mode,
        backlinks_removed: backlinks.length,
        derived_children: derivedChildren,
        note: revised.note,
      };
    }

    fs.unlinkSync(note.filepath);
    this.refreshIndex(true);

    return {
      slug,
      mode,
      backlinks_removed: backlinks.length,
      derived_children: derivedChildren,
      note: null,
    };
  }

  readVaultConfigRaw(): string {
    return fs.readFileSync(path.join(this.vaultRoot, CONFIG_FILENAME), 'utf-8');
  }

  readVaultTypesJson(): string {
    return JSON.stringify({
      default_type: this.config.defaults.note_type,
      note_types: this.listNoteTypes(),
    }, null, 2);
  }

  readVaultOverviewJson(): string {
    return JSON.stringify(this.getVaultOverview(), null, 2);
  }

  readNoteMarkdown(slug: string): string {
    const note = this.requireNote(slug);
    return fs.readFileSync(note.filepath, 'utf-8');
  }

  readAsset(fileName: string):
    | { uri: string; mimeType: string; text: string }
    | { uri: string; mimeType: string; blob: string } {
    return readAssetResource(this.vaultRoot, fileName);
  }

  completeSlugs(prefix = ''): string[] {
    const normalizedPrefix = prefix.toLowerCase();

    return this.readAllNotes()
      .sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified))
      .map(note => note.slug)
      .filter(slug => slug.toLowerCase().startsWith(normalizedPrefix))
      .slice(0, 25);
  }

  completeAssets(prefix = ''): string[] {
    return completeAssetFiles(this.vaultRoot, prefix);
  }

  getTypeInstructions(typeName: string): string | undefined {
    return this.config.note_types[typeName]?.instructions;
  }

  noteResourceUri(slug: string): string {
    return `granite://notes/${encodeURIComponent(slug)}`;
  }

  assetResourceUri(fileName: string): string {
    return assetResourceUri(fileName);
  }

  private refreshIndex(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastIndexCheckAt < this.indexCheckIntervalMs) {
      return;
    }

    const currentConfigMtimeMs = this.getConfigMtimeMs();
    if (!this.lastSignature || currentConfigMtimeMs !== this.lastSignature.configMtimeMs) {
      this.config = loadConfig(this.vaultRoot);
    }

    const signature = this.computeSignature();
    let shouldRebuild = false;

    if (force) {
      shouldRebuild = true;
    } else if (this.config.index.auto_rebuild) {
      if (!this.lastSignature) {
        shouldRebuild =
          signature.noteCount !== this.getIndexedNoteCount() ||
          signature.latestMutationMs > this.getLastRebuildMs();
      } else {
        shouldRebuild =
          signature.noteCount !== this.lastSignature.noteCount ||
          signature.latestMutationMs !== this.lastSignature.latestMutationMs ||
          signature.configMtimeMs !== this.lastSignature.configMtimeMs;
      }
    }

    if (shouldRebuild) {
      rebuildIndex(this.vaultRoot, this.config, this.db);
    }

    this.lastSignature = signature;
    this.lastIndexCheckAt = now;
  }

  private readAllNotes(): Note[] {
    return listNotes(this.vaultRoot, this.config);
  }

  private requireNote(slug: string): Note {
    const note = findNoteBySlug(this.vaultRoot, this.config, slug);
    if (!note) {
      throw new Error(`Note not found: ${slug}`);
    }
    return note;
  }

  private toNoteSummary(note: Note): NoteSummary {
    return {
      slug: note.slug,
      title: note.frontmatter.title,
      type: note.frontmatter.type,
      created: note.frontmatter.created,
      modified: note.frontmatter.modified,
      tags: note.frontmatter.tags,
      aliases: note.frontmatter.aliases,
      status: note.frontmatter.status,
      source: note.frontmatter.source,
      review_state: note.frontmatter.review_state,
      durability: note.frontmatter.durability,
      derived_from: note.frontmatter.derived_from,
      filepath: note.filepath,
      resource_uri: this.noteResourceUri(note.slug),
    };
  }

  private toImportedDocumentAsset(asset: AttachedAsset): ImportedDocumentAsset {
    return {
      file: asset.file,
      path: asset.path,
      relative_path: asset.relative_path,
      markdown: asset.markdown,
      mime_type: asset.mime_type,
      sha256: asset.sha256,
      resource_uri: asset.resource_uri,
    };
  }

  private applyMutations(filepath: string, input: Omit<UpdateNoteInput, 'append'> & { append?: string }): void {
    const raw = fs.readFileSync(filepath, 'utf-8');
    const { frontmatter, body: existingBody } = parseFrontmatter(raw);
    let body = existingBody;

    if (input.title !== undefined) {
      frontmatter.title = input.title;
    }

    if (input.tags && input.tags.length > 0) {
      frontmatter.tags = mergeUnique(frontmatter.tags, input.tags);
    }

    if (input.aliases && input.aliases.length > 0) {
      frontmatter.aliases = mergeUnique(frontmatter.aliases, input.aliases);
    }

    if (input.status !== undefined) {
      validateStatus(input.status);
      frontmatter.status = input.status;
    }

    if (input.source !== undefined) {
      validateSource(input.source);
      frontmatter.source = input.source;
    }

    if (input.review_state !== undefined) {
      validateReviewState(input.review_state);
      frontmatter.review_state = input.review_state;
    }

    if (input.durability !== undefined) {
      validateDurability(input.durability);
      frontmatter.durability = input.durability;
    }

    if (input.derived_from !== undefined) {
      frontmatter.derived_from = [...input.derived_from];
    }

    if (input.body !== undefined) {
      body = ensureTrailingNewline(input.body);
    }

    if (input.append !== undefined) {
      body = `${body.trimEnd()}\n${input.append}\n`;
    }

    frontmatter.modified = new Date().toISOString();
    fs.writeFileSync(filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
  }

  private afterWrite(slug: string, fullRebuild: boolean): NoteMutationResult {
    if (fullRebuild) {
      this.refreshIndex(true);
    } else {
      this.refreshIndex();
      const note = this.requireNote(slug);
      syncNoteInIndex(this.vaultRoot, this.config, this.db, note);
      this.captureSignature();
    }

    const note = this.requireNote(slug);

    return {
      note: this.getNote(note.slug),
      recommendations: getRecommendations(this.db, note, this.config),
    };
  }

  private captureSignature(): void {
    this.lastSignature = this.computeSignature();
    this.lastIndexCheckAt = Date.now();
  }

  private computeSignature(): VaultSignature {
    let noteCount = 0;
    let latestNoteMtimeMs = 0;

    for (const typeConfig of Object.values(this.config.note_types)) {
      const folder = path.join(this.vaultRoot, typeConfig.folder);
      if (!fs.existsSync(folder)) {
        continue;
      }

      for (const entry of fs.readdirSync(folder)) {
        if (!entry.endsWith('.md')) {
          continue;
        }

        noteCount += 1;
        const stat = fs.statSync(path.join(folder, entry));
        latestNoteMtimeMs = Math.max(latestNoteMtimeMs, stat.mtimeMs);
      }
    }

    const configMtimeMs = this.getConfigMtimeMs();

    return {
      noteCount,
      latestMutationMs: Math.max(latestNoteMtimeMs, configMtimeMs),
      configMtimeMs,
    };
  }

  private getConfigMtimeMs(): number {
    const configPath = path.join(this.vaultRoot, CONFIG_FILENAME);
    return fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
  }

  private getLastRebuildMs(): number {
    const value = this.getMetaValue('last_rebuild');
    return value ? Date.parse(value) || 0 : 0;
  }

  private getMetaValue(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private getIndexedNoteCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM notes').get() as { count: number };
    return row.count;
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(value, max));
}

function mergeUnique(existing: string[], incoming: string[]): string[] {
  const merged = new Set(existing);
  for (const value of incoming) {
    const trimmed = value.trim();
    if (trimmed) {
      merged.add(trimmed);
    }
  }
  return [...merged];
}

function hasMetadataMutations(
  input: Pick<CreateNoteInput, 'tags' | 'aliases' | 'status' | 'source' | 'review_state' | 'durability' | 'derived_from'>,
): boolean {
  return (
    (input.tags?.length ?? 0) > 0 ||
    (input.aliases?.length ?? 0) > 0 ||
    input.status !== undefined ||
    input.source !== undefined ||
    input.review_state !== undefined ||
    input.durability !== undefined ||
    (input.derived_from?.length ?? 0) > 0
  );
}
