import { loadConfig } from '../core/config.js';
import { requireVaultRoot } from '../core/vault.js';
import { listNotes } from '../core/note.js';
import { ensureIndex } from '../core/index-db.js';
import { getBacklinks } from '../core/backlinks.js';
import { jsonSuccess } from '../core/json-output.js';
import { computeTypeRegistrySignature } from '../core/validate.js';
import type { Note, GraniteConfig } from '../core/types.js';

interface Cluster {
  tag: string;
  slugs: string[];
  hub: string | null;
}

interface WakeupData {
  total: number;
  by_type: Record<string, number>;
  modified: string;
  clusters: Cluster[];
  people: Array<{ slug: string; title: string }>;
  recent: Array<{ slug: string; age: string }>;
  stale: Array<{ slug: string; reason: string }>;
  aaak: string;
}

/**
 * Build clusters by grouping notes that share tags.
 * Pick the tag that covers the most notes as the cluster label.
 */
function buildClusters(notes: Note[], connectionCounts: Map<string, number>): Cluster[] {
  // Count tag frequency
  const tagNotes = new Map<string, Set<string>>();
  for (const note of notes) {
    for (const tag of note.frontmatter.tags ?? []) {
      if (!tagNotes.has(tag)) tagNotes.set(tag, new Set());
      tagNotes.get(tag)!.add(note.slug);
    }
  }

  // Sort tags by coverage (most notes first)
  const sortedTags = [...tagNotes.entries()]
    .filter(([, slugs]) => slugs.size >= 2)
    .sort((a, b) => b[1].size - a[1].size);

  const assigned = new Set<string>();
  const clusters: Cluster[] = [];

  for (const [tag, slugSet] of sortedTags) {
    const unassigned = [...slugSet].filter(s => !assigned.has(s));
    if (unassigned.length < 2) continue;

    // Find hub: the note in this cluster with the most connections
    let hub: string | null = null;
    let maxCx = 0;
    for (const slug of unassigned) {
      const cx = connectionCounts.get(slug) ?? 0;
      if (cx > maxCx) {
        maxCx = cx;
        hub = slug;
      }
    }

    clusters.push({ tag, slugs: unassigned, hub });
    for (const s of unassigned) assigned.add(s);
  }

  // Unclustered notes go into "misc"
  const unclustered = notes.filter(n => !assigned.has(n.slug)).map(n => n.slug);
  if (unclustered.length > 0) {
    clusters.push({ tag: 'misc', slugs: unclustered, hub: null });
  }

  return clusters;
}

/**
 * Generate AAAK compressed format from vault data.
 */
function generateAaak(
  notes: Note[],
  byType: Record<string, number>,
  clusters: Cluster[],
  connectionCounts: Map<string, number>,
  people: Array<{ slug: string; title: string }>,
  recent: Array<{ slug: string; age: string }>,
  config: GraniteConfig,
): string {
  const lines: string[] = [];

  // Header
  const typeBreakdown = Object.entries(byType)
    .map(([t, c]) => `${c}${t.slice(0, 3)}`)
    .join(',');
  const lastModified = notes.reduce((max, n) =>
    n.frontmatter.modified > max ? n.frontmatter.modified : max, '');
  lines.push(`VAULT: ${notes.length}n (${typeBreakdown}) | modified:${lastModified.slice(0, 10)}`);

  // Types registry pointer — agents MUST read granite://vault/types before
  // writing to ensure frontmatter fields and body sections match the type contract.
  const typeCount = Object.keys(config.note_types).length;
  const typeSig = computeTypeRegistrySignature(config);
  lines.push(`TYPES: ${typeCount} (sig=${typeSig}) -> granite://vault/types`);

  // Clusters
  lines.push('CLUSTERS:');
  for (const cluster of clusters) {
    const slugList = cluster.slugs.map(s => {
      const cx = connectionCounts.get(s) ?? 0;
      const note = notes.find(n => n.slug === s);
      const type = note?.frontmatter.type;
      const annotations: string[] = [];
      if (s === cluster.hub && cx >= 5) annotations.push('hub');
      if (type === 'synthesis') annotations.push('syn');
      if (type === 'source') annotations.push('src');
      if (type === 'output') annotations.push('out');
      if (cx >= 5) annotations.push(`${cx}cx`);
      const ann = annotations.length > 0 ? `(${annotations.join(',')})` : '';
      // Shorten slug: take first 30 chars
      const short = s.length > 30 ? s.slice(0, 30) : s;
      return `${short}${ann}`;
    });
    lines.push(`  ${cluster.tag.toUpperCase()}: ${slugList.join(' ')}`);
  }

  // People
  if (people.length > 0) {
    const peopleLine = people.map(p => {
      const short = p.title.length > 20 ? p.title.slice(0, 20) : p.title;
      return short;
    }).join(', ');
    lines.push(`PEOPLE: ${peopleLine}`);
  }

  // Recent
  if (recent.length > 0) {
    const recentLine = recent.slice(0, 5).map(r => {
      const short = r.slug.length > 25 ? r.slug.slice(0, 25) : r.slug;
      return `${short}(${r.age})`;
    }).join(' ');
    lines.push(`RECENT: ${recentLine}`);
  }

  return lines.join('\n');
}

function getAge(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
  return `${Math.floor(diffDays / 30)}mo`;
}

export function wakeupCommand(options: { json?: boolean } = {}): void {
  const vaultRoot = requireVaultRoot();
  const config = loadConfig(vaultRoot);
  const notes = listNotes(vaultRoot, config)
    .filter(n => n.frontmatter.status !== 'archived');

  const db = ensureIndex(vaultRoot, config);

  // Count connections per note
  const connectionCounts = new Map<string, number>();
  const linkRows = db.prepare(`
    SELECT source_slug, target_slug FROM links WHERE target_slug IS NOT NULL
  `).all() as Array<{ source_slug: string; target_slug: string }>;

  for (const row of linkRows) {
    connectionCounts.set(row.source_slug, (connectionCounts.get(row.source_slug) ?? 0) + 1);
    connectionCounts.set(row.target_slug, (connectionCounts.get(row.target_slug) ?? 0) + 1);
  }

  // By type
  const byType: Record<string, number> = {};
  for (const note of notes) {
    byType[note.frontmatter.type] = (byType[note.frontmatter.type] ?? 0) + 1;
  }

  // Clusters
  const clusters = buildClusters(notes, connectionCounts);

  // People: notes with tags containing "prospect" or whose title suggests a person
  const people = notes
    .filter(n =>
      (n.frontmatter.tags ?? []).some(t => ['prospect', 'person', 'contact', 'founder', 'client'].includes(t))
    )
    .map(n => ({ slug: n.slug, title: n.frontmatter.title }));

  // Recent: last 5 modified
  const sortedByModified = [...notes]
    .sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));
  const recent = sortedByModified.slice(0, 5).map(n => ({
    slug: n.slug,
    age: getAge(n.frontmatter.modified),
  }));

  // Stale: working durability older than 2 weeks with few connections
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const stale = notes
    .filter(n =>
      n.frontmatter.durability === 'working' &&
      n.frontmatter.modified < twoWeeksAgo &&
      (connectionCounts.get(n.slug) ?? 0) < 2
    )
    .map(n => ({ slug: n.slug, reason: 'working+stale+disconnected' }));

  // Generate AAAK
  const aaak = generateAaak(notes, byType, clusters, connectionCounts, people, recent, config);

  db.close();

  const data: WakeupData = {
    total: notes.length,
    by_type: byType,
    modified: sortedByModified[0]?.frontmatter.modified ?? '',
    clusters,
    people,
    recent,
    stale,
    aaak,
  };

  if (options.json) {
    console.log(jsonSuccess(data));
    return;
  }

  // Human-readable output: just print the AAAK format
  console.log(aaak);
}
