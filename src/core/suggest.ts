import type Database from 'better-sqlite3';
import type { Note } from './types.js';
import { parseWikilinks } from './wikilinks.js';

export interface LinkSuggestion {
  target_slug: string;
  target_title: string;
  mentions: number;
}

export function suggestLinks(db: Database.Database, note: Note): LinkSuggestion[] {
  // Get all existing outgoing link targets
  const existingLinks = new Set(
    parseWikilinks(note.body).map(l => l.target.toLowerCase())
  );

  // Get all other notes
  const allNotes = db.prepare('SELECT slug, title, aliases FROM notes WHERE slug != ?').all(note.slug) as Array<{
    slug: string;
    title: string;
    aliases: string;
  }>;

  const bodyLower = note.body.toLowerCase();
  const suggestions: LinkSuggestion[] = [];

  for (const other of allNotes) {
    // Check title
    const titleLower = other.title.toLowerCase();
    if (existingLinks.has(titleLower) || existingLinks.has(other.slug)) continue;

    let mentions = 0;

    // Count title occurrences in body
    let idx = 0;
    while ((idx = bodyLower.indexOf(titleLower, idx)) !== -1) {
      mentions++;
      idx += titleLower.length;
    }

    // Check aliases
    const aliases: string[] = JSON.parse(other.aliases || '[]');
    for (const alias of aliases) {
      const aliasLower = alias.toLowerCase();
      if (existingLinks.has(aliasLower)) continue;
      let aidx = 0;
      while ((aidx = bodyLower.indexOf(aliasLower, aidx)) !== -1) {
        mentions++;
        aidx += aliasLower.length;
      }
    }

    if (mentions > 0) {
      suggestions.push({
        target_slug: other.slug,
        target_title: other.title,
        mentions,
      });
    }
  }

  return suggestions.sort((a, b) => b.mentions - a.mentions);
}
