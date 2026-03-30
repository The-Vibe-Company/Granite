import matter from 'gray-matter';
import type { NoteFrontmatter } from './types.js';

export function parseFrontmatter(content: string): { frontmatter: NoteFrontmatter; body: string } {
  const { data, content: body } = matter(content);
  const fm: NoteFrontmatter = {
    id: data.id ?? '',
    title: data.title ?? '',
    type: data.type ?? '',
    created: data.created ?? '',
    modified: data.modified ?? '',
    tags: data.tags ?? [],
    aliases: data.aliases ?? [],
  };
  return { frontmatter: fm, body };
}

export function serializeFrontmatter(fm: NoteFrontmatter, body: string): string {
  return matter.stringify(body, fm);
}
