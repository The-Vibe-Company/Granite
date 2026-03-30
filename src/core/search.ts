import type Database from 'better-sqlite3';
import type { SearchResult } from './types.js';

export function searchNotes(db: Database.Database, query: string): SearchResult[] {
  const stmt = db.prepare(`
    SELECT
      n.slug,
      n.title,
      snippet(notes_fts, 1, '>>>', '<<<', '...', 30) as snippet,
      rank
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ?
    ORDER BY rank
    LIMIT 20
  `);

  const rows = stmt.all(query) as Array<{
    slug: string;
    title: string;
    snippet: string;
    rank: number;
  }>;

  return rows.map(r => ({
    slug: r.slug,
    title: r.title,
    snippet: r.snippet,
    score: r.rank,
  }));
}
