import type Database from 'better-sqlite3';
import type { GraniteConfig } from './types.js';
import { getBacklinks } from './backlinks.js';
import { searchNotes } from './search.js';
import { runQuery } from './query.js';

export interface CompileContextInput {
  topic?: string;
  slug?: string;
  depth?: number;
  limit?: number;
}

export interface CompileContextResult {
  mode: 'topic' | 'slug';
  title: string;
  sections: CompiledSection[];
}

export interface CompiledSection {
  heading: string;
  entries: CompiledEntry[];
}

export interface CompiledEntry {
  slug: string;
  title: string;
  type: string;
  reason: string;
}

/**
 * Deterministic context compilation: walk the graph and type filters to produce
 * a typed brief. No LLM — pure filtering + ranking.
 */
export function compileContext(
  db: Database.Database,
  config: GraniteConfig,
  input: CompileContextInput,
): CompileContextResult {
  if (input.slug) return compileForSlug(db, config, input.slug, input.limit ?? 20);
  if (input.topic) return compileForTopic(db, config, input.topic, input.limit ?? 20);
  throw new Error('compile_context requires either topic or slug');
}

function compileForSlug(
  db: Database.Database,
  config: GraniteConfig,
  slug: string,
  limit: number,
): CompileContextResult {
  const note = db.prepare('SELECT slug, title, type FROM notes WHERE slug = ?').get(slug) as
    | { slug: string; title: string; type: string }
    | undefined;
  if (!note) throw new Error(`Note "${slug}" not found`);

  const sections: CompiledSection[] = [];

  if (note.type === 'organization' && config.note_types.person) {
    const peopleResults = runQuery(db, config, {
      type: 'person',
      where: { organization: slug },
      limit,
    });
    if (peopleResults.length > 0) {
      sections.push({
        heading: 'Team',
        entries: peopleResults.map(r => ({
          slug: r.slug,
          title: r.title,
          type: r.type,
          reason: `Member of ${note.title}`,
        })),
      });
    }
  }

  if (note.type === 'organization' && config.note_types.meeting) {
    const meetings = runQuery(db, config, {
      type: 'meeting',
      where: { organization: slug },
      sort: { field: 'date', dir: 'desc' },
      limit,
    });
    if (meetings.length > 0) {
      sections.push({
        heading: 'Recent meetings',
        entries: meetings.map(r => ({
          slug: r.slug,
          title: r.title,
          type: r.type,
          reason: `Meeting${r.fields.date ? ` on ${r.fields.date}` : ''}`,
        })),
      });
    }
  }

  const backlinks = getBacklinks(db, slug);
  if (backlinks.length > 0) {
    sections.push({
      heading: 'Backlinks',
      entries: backlinks.slice(0, limit).map(b => ({
        slug: b.source_slug,
        title: b.source_title,
        type: lookupType(db, b.source_slug) ?? 'note',
        reason: b.context || 'References this note',
      })),
    });
  }

  return { mode: 'slug', title: note.title, sections };
}

function compileForTopic(
  db: Database.Database,
  config: GraniteConfig,
  topic: string,
  limit: number,
): CompileContextResult {
  const searchResults = searchNotes(db, topic, limit);
  const byType = new Map<string, CompiledEntry[]>();
  for (const r of searchResults) {
    const type = lookupType(db, r.slug) ?? 'note';
    const list = byType.get(type) ?? [];
    list.push({
      slug: r.slug,
      title: r.title,
      type,
      reason: r.snippet || `Match for "${topic}"`,
    });
    byType.set(type, list);
  }

  const orderedTypes = ['source', 'learning', 'note', 'synthesis', 'output', 'meeting', 'person', 'organization'];
  const sections: CompiledSection[] = [];
  for (const t of orderedTypes) {
    const entries = byType.get(t);
    if (entries && entries.length > 0) {
      sections.push({ heading: capitalize(t) + 's', entries });
    }
  }
  for (const [t, entries] of byType.entries()) {
    if (orderedTypes.includes(t)) continue;
    sections.push({ heading: capitalize(t) + 's', entries });
  }

  return { mode: 'topic', title: topic, sections };
}

function lookupType(db: Database.Database, slug: string): string | undefined {
  const row = db.prepare('SELECT type FROM notes WHERE slug = ?').get(slug) as { type: string } | undefined;
  return row?.type;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
