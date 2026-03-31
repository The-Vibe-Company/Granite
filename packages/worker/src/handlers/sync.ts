import type { Context } from 'hono';
import matter from 'gray-matter';
import type { Env } from '../env.js';
import { R2NoteStorage } from '../storage/r2.js';
import { D1IndexDatabase } from '../storage/d1.js';
import { parseJsonArray } from '../lib/json.js';

interface SyncChange {
  note_id: string;
  operation: string;
  timestamp: string;
  checksum: string;
  slug: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
}

interface SyncPushPayload {
  device_id: string;
  last_server_seq: number;
  changes: SyncChange[];
}

function getVaultId(c: Context<{ Bindings: Env }>): string {
  return c.get('vaultId') as string;
}

export async function handleSyncPush(c: Context<{ Bindings: Env }>) {
  const vaultId = getVaultId(c);
  const storage = new R2NoteStorage(c.env.VAULT_BUCKET, vaultId);
  const db = new D1IndexDatabase(c.env.DB, vaultId);

  const payload = await c.req.json<SyncPushPayload>();
  let accepted = 0;

  for (const change of payload.changes) {
    if (change.operation === 'create' || change.operation === 'update') {
      if (!change.frontmatter || change.body === undefined) {
        // Skip unprocessable changes — don't record in changelog
        continue;
      }

      const typeFolder = getTypeFolder(change.frontmatter);
      const slug = change.slug || change.note_id;

      const content = matter.stringify(change.body, change.frontmatter);
      await storage.writeNote(typeFolder, slug, content);

      await db.upsertNote({
        slug,
        id: String(change.note_id),
        title: String(change.frontmatter.title ?? ''),
        type: String(change.frontmatter.type ?? 'fleeting'),
        created: String(change.frontmatter.created ?? ''),
        modified: String(change.frontmatter.modified ?? ''),
        tags: JSON.stringify(change.frontmatter.tags ?? []),
        aliases: JSON.stringify(change.frontmatter.aliases ?? []),
        body: change.body,
        filepath: `${typeFolder}/${slug}.md`,
        status: String(change.frontmatter.status ?? 'active'),
        source: String(change.frontmatter.source ?? 'human'),
      });
    } else if (change.operation === 'delete') {
      const indexed = await db.getNoteById(change.note_id);
      if (indexed) {
        const typeFolder = getTypeFolder({ type: indexed.type });
        await storage.deleteNote(typeFolder, indexed.slug);
        await db.deleteNoteBySlug(indexed.slug);
      }
    }

    await db.recordChange(
      change.note_id,
      change.operation,
      payload.device_id,
      change.checksum,
      change.slug || '',
    );

    accepted++;
  }

  await db.upsertDevice(payload.device_id, payload.device_id);
  const serverSeq = await db.getLatestSeq();
  await db.updateDeviceSeq(payload.device_id, serverSeq);

  return c.json({ server_seq: serverSeq, accepted });
}

export async function handleSyncPull(c: Context<{ Bindings: Env }>) {
  const vaultId = getVaultId(c);
  const db = new D1IndexDatabase(c.env.DB, vaultId);

  const sinceSeq = Number(c.req.query('since_seq') ?? '0');
  const deviceId = c.req.query('device_id') ?? '';

  const changelog = await db.getChangesSince(sinceSeq, deviceId);

  // Batch-fetch all note IDs we need (avoid N+1 queries)
  const noteIds = [...new Set(
    changelog.filter(e => e.operation !== 'delete').map(e => e.note_id),
  )];
  const notesMap = await db.getNotesByIds(noteIds);

  const changes: SyncChange[] = [];
  for (const entry of changelog) {
    if (entry.operation === 'delete') {
      changes.push({
        note_id: entry.note_id,
        operation: entry.operation,
        timestamp: entry.timestamp,
        checksum: entry.checksum,
        slug: entry.slug,
      });
      continue;
    }

    const indexed = notesMap.get(entry.note_id);
    if (!indexed) continue;

    changes.push({
      note_id: entry.note_id,
      operation: entry.operation,
      timestamp: entry.timestamp,
      checksum: entry.checksum,
      slug: indexed.slug,
      frontmatter: {
        id: indexed.id,
        title: indexed.title,
        type: indexed.type,
        created: indexed.created,
        modified: indexed.modified,
        tags: parseJsonArray(indexed.tags),
        aliases: parseJsonArray(indexed.aliases),
        status: indexed.status,
        source: indexed.source,
      },
      body: indexed.body,
    });
  }

  const serverSeq = await db.getLatestSeq();

  return c.json({ changes, server_seq: serverSeq });
}

export async function handleSyncDevices(c: Context<{ Bindings: Env }>) {
  const vaultId = getVaultId(c);
  const db = new D1IndexDatabase(c.env.DB, vaultId);
  const devices = await db.getDevices();

  return c.json(devices.map(d => ({
    device_id: d.device_id,
    device_name: d.device_name,
    last_seen: d.last_seen,
  })));
}

function getTypeFolder(frontmatter: Record<string, unknown>): string {
  const type = String(frontmatter.type ?? 'fleeting');
  const folderMap: Record<string, string> = {
    fleeting: 'notes/fleeting',
    permanent: 'notes/permanent',
    reference: 'notes/reference',
    person: 'notes/people',
    meeting: 'notes/meetings',
    project: 'notes/projects',
    decision: 'notes/decisions',
  };
  return folderMap[type] ?? `notes/${type}`;
}
