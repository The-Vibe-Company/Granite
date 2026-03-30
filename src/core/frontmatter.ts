import matter from 'gray-matter';
import type { NoteFrontmatter } from './types.js';

export function parseFrontmatter(content: string): { frontmatter: NoteFrontmatter; body: string } {
  const { data, content: body } = matter(content);
  const fm: NoteFrontmatter = {
    id: toFrontmatterString(data.id),
    title: toFrontmatterString(data.title),
    type: toFrontmatterString(data.type),
    created: toFrontmatterString(data.created),
    modified: toFrontmatterString(data.modified),
    tags: data.tags ?? [],
    aliases: data.aliases ?? [],
    status: data.status ?? 'active',
    source: data.source ?? 'human',
  };
  // Preserve any extra type-specific fields
  for (const [key, value] of Object.entries(data)) {
    if (!(key in fm)) {
      fm[key] = value;
    }
  }
  return { frontmatter: fm, body };
}

export function serializeFrontmatter(fm: NoteFrontmatter, body: string): string {
  return matter.stringify(body, fm);
}

function toFrontmatterString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
