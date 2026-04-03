import type Database from 'better-sqlite3';
import type { GraniteConfig, Note } from './types.js';
import { ensureIndex, openDatabase, syncNoteInIndex } from './index-db.js';
import { suggestLinks } from './suggest.js';
import { parseWikilinks } from './wikilinks.js';

const MAX_LINK_RECOMMENDATIONS = 3;
const MAX_TAG_RECOMMENDATIONS = 3;
const MAX_ADDITION_RECOMMENDATIONS = 3;

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'about', 'your', 'have', 'will', 'them',
  'they', 'what', 'when', 'where', 'which', 'their', 'there', 'here', 'then', 'than', 'also', 'just',
  'should', 'could', 'would', 'into', 'over', 'under', 'after', 'before', 'using', 'used', 'make',
  'made', 'more', 'most', 'some', 'such', 'each', 'many', 'only', 'through', 'between', 'within',
  'write', 'notes', 'note', 'links', 'link', 'summary', 'details', 'source', 'date', 'role', 'context',
  'contact', 'attendees', 'agenda', 'decisions', 'actions', 'goal', 'status', 'people', 'rationale',
  'decision', 'options', 'considered', 'active', 'points', 'take', 'idea', 'ideas', 'project', 'meeting',
  'person', 'reference', 'note', 'how', 'know', 'work', 'works', 'what', 'prompted',
  'them', 'what', 'plus', 'latest', 'recent', 'capture', 'record', 'refine', 'later', 'local', 'first',
  'short', 'clear', 'split', 'related', 'relevant', 'title', 'titles',
]);

interface NoteMetadata {
  slug: string;
  title: string;
  type: string;
  tags: string[];
}

export interface LinkRecommendation {
  slug: string;
  title: string;
  type: string;
  reason: string;
  source: 'mention' | 'search';
}

export interface TagRecommendation {
  tag: string;
  weight: number;
  source_slugs: string[];
}

export interface NextNoteRecommendation {
  type: string;
  title_hint?: string;
  reason: string;
}

export interface AdditionRecommendation {
  text: string;
}

export interface NoteRecommendations {
  additions: AdditionRecommendation[];
  links: LinkRecommendation[];
  tags: TagRecommendation[];
  next_steps: NextNoteRecommendation[];
}

interface RankedLinkRecommendation extends LinkRecommendation {
  tags: string[];
  rank: number;
}

interface SimilarRow {
  slug: string;
  title: string;
  type: string;
  tags: string;
  score: number;
}

interface RecommendNoteOptions {
  strategy?: 'rebuild' | 'incremental';
}

interface NearbyNote {
  slug: string;
  title: string;
  type: string;
  tags: string[];
  source: 'outgoing' | 'backlink' | 'mention' | 'search';
}

export function recommendNote(
  vaultRoot: string,
  config: GraniteConfig,
  note: Note,
  options: RecommendNoteOptions = {},
): NoteRecommendations {
  const strategy = options.strategy ?? 'rebuild';
  const db = strategy === 'incremental' ? openDatabase(vaultRoot) : ensureIndex(vaultRoot, config);

  try {
    if (strategy === 'incremental') {
      syncNoteInIndex(vaultRoot, config, db, note);
    }
    return getRecommendations(db, note, config);
  } finally {
    db.close();
  }
}

export function getRecommendations(db: Database.Database, note: Note, config?: GraniteConfig): NoteRecommendations {
  const nearbyNotes = getNearbyNotes(db, note);
  const existingTargets = getExistingTargets(db, note);
  const mentionLinks = getMentionRecommendations(db, note);
  const excludedSlugs = new Set(mentionLinks.map(link => link.slug));
  const similarLinks = getSearchRecommendations(db, note, existingTargets, excludedSlugs);
  const links = [...mentionLinks, ...similarLinks]
    .sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title))
    .slice(0, MAX_LINK_RECOMMENDATIONS);
  const allNearbyNotes = mergeNearbyNotes(nearbyNotes, links);

  return {
    additions: getAdditionRecommendations(note, config),
    links: links.map(({ tags: _tags, rank: _rank, ...link }) => link),
    tags: getTagRecommendations(note, allNearbyNotes),
    next_steps: getNextSteps(note, allNearbyNotes),
  };
}

export function formatRecommendations(recommendations: NoteRecommendations): string[] {
  const lines: string[] = [];

  if (
    recommendations.additions.length === 0 &&
    recommendations.links.length === 0 &&
    recommendations.tags.length === 0 &&
    recommendations.next_steps.length === 0
  ) {
    return lines;
  }

  if (recommendations.additions.length > 0) {
    lines.push('  Add now:');
    for (const item of recommendations.additions) {
      lines.push(`    ${item.text}`);
    }
  }

  if (recommendations.links.length > 0) {
    lines.push('  Link now:');
    for (const link of recommendations.links) {
      lines.push(`    [[${link.slug}]] — ${link.reason}`);
    }
  }

  if (recommendations.tags.length > 0) {
    lines.push('  Tag now:');
    for (const tag of recommendations.tags) {
      const notes = tag.source_slugs.length === 1 ? '1 nearby note' : `${tag.source_slugs.length} nearby notes`;
      lines.push(`    ${tag.tag} — seen on ${notes}`);
    }
  }

  if (recommendations.next_steps.length > 0) {
    lines.push('  Next note:');
    for (const step of recommendations.next_steps) {
      const hint = step.title_hint ? ` Title hint: ${step.title_hint}.` : '';
      lines.push(`    ${step.type} — ${step.reason}${hint}`);
    }
  }

  return lines;
}

function getExistingTargets(db: Database.Database, note: Note): Set<string> {
  const existing = new Set<string>();

  const rows = db.prepare(`
    SELECT target_slug, target_raw
    FROM links
    WHERE source_slug = ?
  `).all(note.slug) as Array<{ target_slug: string | null; target_raw: string }>;

  for (const row of rows) {
    existing.add(row.target_raw.toLowerCase());
    if (row.target_slug) {
      existing.add(row.target_slug.toLowerCase());
    }
  }

  return existing;
}

function getMentionRecommendations(db: Database.Database, note: Note): RankedLinkRecommendation[] {
  const raw = suggestLinks(db, note);
  const recommendations: RankedLinkRecommendation[] = [];

  for (const suggestion of raw) {
    const metadata = getNoteMetadata(db, suggestion.target_slug);
    if (!metadata) continue;

    recommendations.push({
      slug: metadata.slug,
      title: metadata.title,
      type: metadata.type,
      reason: `mentioned ${suggestion.mentions} time${suggestion.mentions === 1 ? '' : 's'}`,
      source: 'mention',
      tags: metadata.tags,
      rank: 100 + suggestion.mentions,
    });
  }

  return recommendations;
}

function getSearchRecommendations(
  db: Database.Database,
  note: Note,
  existingTargets: Set<string>,
  excludedSlugs: Set<string>,
): RankedLinkRecommendation[] {
  const query = buildSearchQuery(note);
  if (!query) return [];

  const rows = db.prepare(`
    SELECT
      n.slug,
      n.title,
      n.type,
      n.tags,
      bm25(notes_fts, 8.0, 1.5, 0.5) AS score
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ? AND n.slug != ?
    ORDER BY score
    LIMIT 12
  `).all(query, note.slug) as SimilarRow[];

  const out: RankedLinkRecommendation[] = [];

  for (const row of rows) {
    if (existingTargets.has(row.slug.toLowerCase()) || excludedSlugs.has(row.slug)) continue;

    out.push({
      slug: row.slug,
      title: row.title,
      type: row.type,
      reason: 'shared keywords',
      source: 'search',
      tags: parseJsonArray(row.tags),
      rank: Math.max(1, 40 - Math.round(row.score * 10)),
    });
  }

  return out;
}

function getTagRecommendations(note: Note, nearbyNotes: NearbyNote[]): TagRecommendation[] {
  const existingTags = new Set(note.frontmatter.tags.map(tag => tag.toLowerCase()));
  const noteTokens = new Set(tokenize(`${note.frontmatter.title} ${note.body}`));
  const counts = new Map<string, { weight: number; sourceSlugs: Set<string> }>();

  for (const nearby of nearbyNotes) {
    const weight = getNearbyWeight(nearby.source);

    for (const tag of nearby.tags) {
      const normalized = tag.trim().toLowerCase();
      if (!normalized || existingTags.has(normalized)) continue;

      const entry = counts.get(normalized) ?? { weight: 0, sourceSlugs: new Set<string>() };
      entry.weight += weight;
      if (tagMatchesNoteTokens(normalized, noteTokens)) {
        entry.weight += 2;
      }
      entry.sourceSlugs.add(nearby.slug);
      counts.set(normalized, entry);
    }
  }

  return [...counts.entries()]
    .map(([tag, info]) => ({
      tag,
      weight: info.weight,
      source_slugs: [...info.sourceSlugs],
    }))
    .sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag))
    .slice(0, MAX_TAG_RECOMMENDATIONS);
}

function getNextSteps(note: Note, nearbyNotes: NearbyNote[]): NextNoteRecommendation[] {
  const canonicalLink = nearbyNotes.find(link => link.type === 'note' || link.type === 'synthesis');

  switch (note.frontmatter.type) {
    case 'source':
      return [{
        type: 'synthesis',
        title_hint: `${note.frontmatter.title} synthesis`,
        reason: 'Compile the main ideas from this source into a durable synthesis.',
      }];
    case 'note':
      return [{
        type: canonicalLink ? 'synthesis' : 'source',
        title_hint: canonicalLink ? `${note.frontmatter.title} synthesis` : `${note.frontmatter.title} source`,
        reason: canonicalLink
          ? 'Compile this durable idea with adjacent notes into a reusable synthesis.'
          : 'Attach this durable idea to an explicit source or source note.',
      }];
    case 'synthesis':
      return [{
        type: 'output',
        title_hint: `${note.frontmatter.title} brief`,
        reason: 'Turn this durable synthesis into a situational output for a specific audience.',
      }];
    case 'output':
      return [{
        type: canonicalLink ? canonicalLink.type : 'synthesis',
        title_hint: canonicalLink ? canonicalLink.title : `${note.frontmatter.title} synthesis`,
        reason: canonicalLink
          ? 'Link this output back to the durable knowledge it should depend on.'
          : 'Promote durable insights from this output into a reusable synthesis.',
      }];
    default:
      return [];
  }
}

function getAdditionRecommendations(note: Note, config?: GraniteConfig): AdditionRecommendation[] {
  const recommendations: AdditionRecommendation[] = [];
  const body = note.body;
  const existingLinks = parseWikilinks(body);
  const templateBody = config?.note_types[note.frontmatter.type]?.template ?? '';

  switch (note.frontmatter.type) {
    case 'source':
      if (isSectionSparse(body, 'Summary', templateBody)) {
        recommendations.push({ text: 'Write a short summary so this source is understandable without rereading the whole document.' });
      }
      if (!hasMeaningfulBullets(body, 'Key Facts')) {
        recommendations.push({ text: 'Capture 2-3 concrete facts worth preserving from the source.' });
      }
      if (existingLinks.length === 0) {
        recommendations.push({ text: 'Link one note or synthesis that this source supports.' });
      }
      break;
    case 'note':
      if (isSectionSparse(body, 'Summary', templateBody)) {
        recommendations.push({ text: 'Write a one-line summary before expanding the idea.' });
      }
      if (existingLinks.length === 0) {
        recommendations.push({ text: 'Link one source, synthesis, or adjacent durable idea.' });
      }
      break;
    case 'synthesis':
      if (isSectionSparse(body, 'Scope', templateBody)) {
        recommendations.push({ text: 'Define the scope so this synthesis has a clear boundary.' });
      }
      if (isSectionSparse(body, 'Executive Summary', templateBody)) {
        recommendations.push({ text: 'Write a short executive summary before expanding the synthesis.' });
      }
      if (existingLinks.length === 0) {
        recommendations.push({ text: 'Link the notes or sources this synthesis pulls together.' });
      }
      break;
    case 'output':
      if (isSectionSparse(body, 'Goal', templateBody)) {
        recommendations.push({ text: 'State the goal so the output is grounded in a concrete need.' });
      }
      if (isSectionSparse(body, 'Audience', templateBody)) {
        recommendations.push({ text: 'Name the audience so the tone and content stay focused.' });
      }
      if (existingLinks.length === 0) {
        recommendations.push({ text: 'Link the source note or synthesis this output derives from.' });
      }
      break;
    default:
      break;
  }

  if (config) {
    const typeTemplate = config.note_types[note.frontmatter.type]?.template ?? '';
    if (body.trim() === typeTemplate.trim() && recommendations.length === 0) {
      recommendations.push({ text: 'Fill the main sections before asking for related notes.' });
    }
  }

  return recommendations.slice(0, MAX_ADDITION_RECOMMENDATIONS);
}

function buildSearchQuery(note: Note): string {
  const counts = new Map<string, number>();
  const titleTokens = tokenize(note.frontmatter.title);
  const bodyTokens = tokenize(note.body);

  for (const token of titleTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 3);
  }

  for (const token of bodyTokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const terms = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token]) => token)
    .slice(0, 8);

  return terms.map(token => `"${token}"`).join(' OR ');
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return matches.filter(token => !STOP_WORDS.has(token));
}

function tagMatchesNoteTokens(tag: string, noteTokens: Set<string>): boolean {
  const tagTokens = tokenize(tag.replace(/[-_]/g, ' '));
  return tagTokens.some(token => noteTokens.has(token));
}

function getNearbyNotes(db: Database.Database, note: Note): NearbyNote[] {
  const bySlug = new Map<string, NearbyNote>();

  const outgoingRows = db.prepare(`
    SELECT DISTINCT n.slug, n.title, n.type, n.tags
    FROM links l
    JOIN notes n ON n.slug = l.target_slug
    WHERE l.source_slug = ?
  `).all(note.slug) as Array<{ slug: string; title: string; type: string; tags: string }>;

  for (const row of outgoingRows) {
    bySlug.set(row.slug, {
      slug: row.slug,
      title: row.title,
      type: row.type,
      tags: parseJsonArray(row.tags),
      source: 'outgoing',
    });
  }

  const backlinkRows = db.prepare(`
    SELECT DISTINCT n.slug, n.title, n.type, n.tags
    FROM links l
    JOIN notes n ON n.slug = l.source_slug
    WHERE l.target_slug = ? AND n.slug != ?
  `).all(note.slug, note.slug) as Array<{ slug: string; title: string; type: string; tags: string }>;

  for (const row of backlinkRows) {
    if (bySlug.has(row.slug)) continue;
    bySlug.set(row.slug, {
      slug: row.slug,
      title: row.title,
      type: row.type,
      tags: parseJsonArray(row.tags),
      source: 'backlink',
    });
  }

  return [...bySlug.values()];
}

function mergeNearbyNotes(
  nearbyNotes: NearbyNote[],
  links: RankedLinkRecommendation[],
): NearbyNote[] {
  const merged = new Map<string, NearbyNote>();

  for (const nearby of nearbyNotes) {
    merged.set(nearby.slug, nearby);
  }

  for (const link of links) {
    if (merged.has(link.slug)) continue;
    merged.set(link.slug, {
      slug: link.slug,
      title: link.title,
      type: link.type,
      tags: link.tags,
      source: link.source,
    });
  }

  return [...merged.values()];
}

function getNearbyWeight(source: NearbyNote['source']): number {
  switch (source) {
    case 'outgoing':
    case 'mention':
      return 2;
    case 'backlink':
    case 'search':
    default:
      return 1;
  }
}

function isSectionSparse(body: string, heading: string, templateBody?: string): boolean {
  const section = getSectionContent(body, heading);
  if (!section) return true;
  const cleaned = section
    .replace(/^- \[ \]\s*$/gm, '')
    .replace(/^-\s*$/gm, '')
    .trim();
  const templateSection = templateBody ? getSectionContent(templateBody, heading).trim() : '';
  if (templateSection && cleaned === templateSection) {
    return true;
  }
  return cleaned.length < 8;
}

function hasMeaningfulBullets(body: string, heading: string): boolean {
  const section = getSectionContent(body, heading);
  if (!section) return false;
  return section
    .split('\n')
    .some(line => /^-/.test(line.trim()) && line.replace(/^-+\s*/, '').trim().length > 2);
}

function getSectionContent(body: string, heading: string): string {
  const lines = body.split('\n');
  const headingLine = `## ${heading}`;
  const startIndex = lines.findIndex(line => line.trim() === headingLine);

  if (startIndex === -1) return '';

  const collected: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index++) {
    if (lines[index].startsWith('## ')) break;
    collected.push(lines[index]);
  }

  return collected.join('\n');
}

function hasUrl(body: string): boolean {
  return /https?:\/\/\S+/i.test(body);
}

function hasAnyWikilinks(body: string): boolean {
  return parseWikilinks(body).length > 0;
}

function getNoteMetadata(db: Database.Database, slug: string | null | undefined): NoteMetadata | null {
  if (!slug) return null;

  const row = db.prepare(`
    SELECT slug, title, type, tags
    FROM notes
    WHERE slug = ?
  `).get(slug) as { slug: string; title: string; type: string; tags: string } | undefined;

  if (!row) return null;

  return {
    slug: row.slug,
    title: row.title,
    type: row.type,
    tags: parseJsonArray(row.tags),
  };
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];

  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
