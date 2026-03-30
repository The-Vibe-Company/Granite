import type Database from 'better-sqlite3';
import type { BacklinkEntry } from './types.js';

export function getBacklinks(db: Database.Database, slug: string): BacklinkEntry[] {
  const stmt = db.prepare(`
    SELECT
      l.source_slug,
      n.title as source_title,
      l.context
    FROM links l
    JOIN notes n ON n.slug = l.source_slug
    WHERE l.target_slug = ?
    ORDER BY n.title
  `);

  return stmt.all(slug) as BacklinkEntry[];
}
