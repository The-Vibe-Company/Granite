import type Database from 'better-sqlite3';
import type { SearchResult } from './types.js';

/**
 * Convert a natural language query into an FTS5 OR query.
 * "Cursor cost cognitive" → "Cursor OR cost OR cognitive"
 *
 * Preserves explicit FTS5 operators (AND, OR, NOT, NEAR, quotes, *)
 * so power users can still write raw FTS5 syntax.
 */
function toOrQuery(query: string): string {
  const trimmed = query.trim();

  // If the query already contains FTS5 operators, pass it through as-is
  if (/\b(AND|OR|NOT|NEAR)\b/.test(trimmed) || trimmed.includes('"') || trimmed.includes('*')) {
    return trimmed;
  }

  // Split into words, filter empties, join with OR
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= 1) return trimmed;

  return words.join(' OR ');
}

export function searchNotes(db: Database.Database, query: string, limit = 20): SearchResult[] {
  const cappedLimit = Math.max(1, Math.min(limit, 100));
  const ftsQuery = toOrQuery(query);

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
    LIMIT ?
  `);

  try {
    const rows = stmt.all(ftsQuery, cappedLimit) as Array<{
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
  } catch {
    // If the FTS query fails (bad syntax), fall back to a simple prefix search
    const fallback = db.prepare(`
      SELECT
        n.slug,
        n.title,
        substr(n.body, 1, 200) as snippet,
        0 as rank
      FROM notes n
      WHERE n.title LIKE ? OR n.body LIKE ?
      LIMIT ?
    `);
    const pattern = `%${query}%`;
    const rows = fallback.all(pattern, pattern, cappedLimit) as Array<{
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
}
