interface WikiLink {
  raw: string;
  target: string;
  display: string;
  resolved: boolean;
  resolved_slug?: string;
}

interface NoteMeta {
  slug: string;
  title: string;
}

export function slugify(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'untitled';
}

/**
 * Parse [[wikilinks]] from a note body, stripping code blocks and inline code.
 */
export function parseWikilinks(body: string): WikiLink[] {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');

  const links: WikiLink[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(cleaned)) !== null) {
    const inner = match[1];
    const pipeIndex = inner.indexOf('|');
    const target = pipeIndex >= 0 ? inner.slice(0, pipeIndex).trim() : inner.trim();
    const display = pipeIndex >= 0 ? inner.slice(pipeIndex + 1).trim() : inner.trim();

    links.push({
      raw: match[0],
      target,
      display,
      resolved: false,
    });
  }

  return links;
}

/**
 * Resolve wikilinks against a list of known notes and return resolved links.
 */
export function resolveWikilinks(
  links: WikiLink[],
  allNotes: NoteMeta[],
): WikiLink[] {
  return links.map(link => {
    const targetSlug = slugify(link.target);
    const found = allNotes.find(n =>
      n.slug === targetSlug ||
      n.title.toLowerCase() === link.target.toLowerCase(),
    );
    return { ...link, resolved: !!found, resolved_slug: found?.slug };
  });
}

/**
 * Parse wikilinks from body, resolve against all notes, and persist to D1 links table.
 */
export async function indexLinks(
  db: {
    getAllNotesMeta(): Promise<NoteMeta[]>;
    setLinks(sourceSlug: string, links: Array<{ target_slug: string | null; target_raw: string; context: string }>): Promise<void>;
  },
  slug: string,
  body: string,
  preParsedLinks?: WikiLink[],
  preloadedNotes?: NoteMeta[],
): Promise<void> {
  const wikilinks = preParsedLinks ?? parseWikilinks(body);
  const allNotes = preloadedNotes ?? await db.getAllNotesMeta();
  const bodyLines = body.split('\n');

  const indexedLinks = wikilinks.map(link => {
    const targetSlug = slugify(link.target);
    const found = allNotes.find(n =>
      n.slug === targetSlug || n.title.toLowerCase() === link.target.toLowerCase(),
    );
    const contextLine = bodyLines.find(l => l.includes(link.raw)) ?? '';
    return {
      target_slug: found?.slug ?? null,
      target_raw: link.target,
      context: contextLine.trim(),
    };
  });

  await db.setLinks(slug, indexedLinks);
}
