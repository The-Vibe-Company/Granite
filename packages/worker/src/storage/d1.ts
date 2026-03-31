interface IndexedNote {
  slug: string;
  id: string;
  title: string;
  type: string;
  created: string;
  modified: string;
  tags: string;
  aliases: string;
  body: string;
  filepath: string;
  status: string;
  source: string;
}

interface IndexedLink {
  target_slug: string | null;
  target_raw: string;
  context: string;
}

interface SearchResult {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

interface BacklinkEntry {
  source_slug: string;
  source_title: string;
  context: string;
}

interface ChangelogRow {
  seq: number;
  vault_id: string;
  note_id: string;
  operation: string;
  timestamp: string;
  device_id: string;
  checksum: string;
  slug: string;
}

interface DeviceRow {
  device_id: string;
  vault_id: string;
  device_name: string;
  last_seen: string;
  last_seq: number;
}

export class D1IndexDatabase {
  constructor(
    private db: D1Database,
    private vaultId: string,
  ) {}

  // --- Notes ---

  async upsertNote(note: IndexedNote): Promise<void> {
    await this.db.prepare(`
      INSERT INTO notes (slug, id, title, type, created, modified, tags, aliases, body, filepath, status, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        id = excluded.id,
        title = excluded.title,
        type = excluded.type,
        created = excluded.created,
        modified = excluded.modified,
        tags = excluded.tags,
        aliases = excluded.aliases,
        body = excluded.body,
        filepath = excluded.filepath,
        status = excluded.status,
        source = excluded.source
    `).bind(
      note.slug, note.id, note.title, note.type,
      note.created, note.modified, note.tags, note.aliases,
      note.body, note.filepath, note.status, note.source,
    ).run();
  }

  async deleteNoteBySlug(slug: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM links WHERE source_slug = ?').bind(slug),
      this.db.prepare('DELETE FROM notes WHERE slug = ?').bind(slug),
    ]);
  }

  async getNote(slug: string): Promise<IndexedNote | null> {
    return this.db.prepare('SELECT * FROM notes WHERE slug = ?')
      .bind(slug)
      .first<IndexedNote>();
  }

  async getNoteById(noteId: string): Promise<IndexedNote | null> {
    return this.db.prepare('SELECT * FROM notes WHERE id = ?')
      .bind(noteId)
      .first<IndexedNote>();
  }

  async getAllNotes(): Promise<IndexedNote[]> {
    const result = await this.db.prepare('SELECT * FROM notes ORDER BY modified DESC').all<IndexedNote>();
    return result.results;
  }

  async countNotes(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) as c FROM notes').first<{ c: number }>();
    return row?.c ?? 0;
  }

  // --- Search (same FTS5 query as src/core/search.ts) ---

  async searchNotes(query: string, limit: number): Promise<SearchResult[]> {
    const cappedLimit = Math.max(1, Math.min(limit, 100));
    const result = await this.db.prepare(`
      SELECT
        n.slug,
        n.title,
        snippet(notes_fts, 1, '>>>', '<<<', '...', 30) as snippet,
        rank as score
      FROM notes_fts
      JOIN notes n ON n.rowid = notes_fts.rowid
      WHERE notes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).bind(query, cappedLimit).all<SearchResult>();
    return result.results;
  }

  // --- Links (same queries as src/core/backlinks.ts) ---

  async setLinks(sourceSlug: string, links: IndexedLink[]): Promise<void> {
    const stmts: D1PreparedStatement[] = [
      this.db.prepare('DELETE FROM links WHERE source_slug = ?').bind(sourceSlug),
    ];

    for (const link of links) {
      stmts.push(
        this.db.prepare(
          'INSERT INTO links (source_slug, target_slug, target_raw, context) VALUES (?, ?, ?, ?)'
        ).bind(sourceSlug, link.target_slug, link.target_raw, link.context),
      );
    }

    await this.db.batch(stmts);
  }

  async getBacklinks(slug: string): Promise<BacklinkEntry[]> {
    const result = await this.db.prepare(`
      SELECT
        l.source_slug,
        n.title as source_title,
        l.context
      FROM links l
      JOIN notes n ON n.slug = l.source_slug
      WHERE l.target_slug = ?
      ORDER BY n.title
    `).bind(slug).all<BacklinkEntry>();
    return result.results;
  }

  async getOutgoingLinks(slug: string): Promise<Array<{ target_slug: string | null; target_raw: string }>> {
    const result = await this.db.prepare(
      'SELECT target_slug, target_raw FROM links WHERE source_slug = ?'
    ).bind(slug).all<{ target_slug: string | null; target_raw: string }>();
    return result.results;
  }

  // --- Meta ---

  async getMeta(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT value FROM meta WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .bind(key, value)
      .run();
  }

  // --- Rebuild ---

  async rebuildFromNotes(entries: Array<{ note: IndexedNote; links: IndexedLink[] }>): Promise<void> {
    const stmts: D1PreparedStatement[] = [
      this.db.prepare('DELETE FROM links'),
      this.db.prepare('DELETE FROM notes'),
      this.db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')"),
    ];

    for (const entry of entries) {
      const n = entry.note;
      stmts.push(
        this.db.prepare(`
          INSERT INTO notes (slug, id, title, type, created, modified, tags, aliases, body, filepath, status, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          n.slug, n.id, n.title, n.type,
          n.created, n.modified, n.tags, n.aliases,
          n.body, n.filepath, n.status, n.source,
        ),
      );

      for (const link of entry.links) {
        stmts.push(
          this.db.prepare(
            'INSERT INTO links (source_slug, target_slug, target_raw, context) VALUES (?, ?, ?, ?)'
          ).bind(n.slug, link.target_slug, link.target_raw, link.context),
        );
      }
    }

    stmts.push(
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_rebuild', ?)")
        .bind(new Date().toISOString()),
    );

    await this.db.batch(stmts);
  }

  // --- Sync Changelog ---

  async recordChange(
    noteId: string,
    operation: string,
    deviceId: string,
    checksum: string,
    slug: string,
  ): Promise<number> {
    const result = await this.db.prepare(`
      INSERT INTO sync_changelog (vault_id, note_id, operation, timestamp, device_id, checksum, slug)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      this.vaultId, noteId, operation,
      new Date().toISOString(), deviceId, checksum, slug,
    ).run();
    return result.meta.last_row_id;
  }

  async getChangesSince(sinceSeq: number, excludeDeviceId: string): Promise<ChangelogRow[]> {
    const result = await this.db.prepare(`
      SELECT * FROM sync_changelog
      WHERE vault_id = ? AND seq > ? AND device_id != ?
      ORDER BY seq ASC
    `).bind(this.vaultId, sinceSeq, excludeDeviceId).all<ChangelogRow>();
    return result.results;
  }

  async getLatestSeq(): Promise<number> {
    const row = await this.db.prepare(
      'SELECT MAX(seq) as max_seq FROM sync_changelog WHERE vault_id = ?'
    ).bind(this.vaultId).first<{ max_seq: number | null }>();
    return row?.max_seq ?? 0;
  }

  // --- Devices ---

  async upsertDevice(deviceId: string, deviceName: string): Promise<void> {
    await this.db.prepare(`
      INSERT INTO devices (device_id, vault_id, device_name, last_seen, last_seq)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(device_id) DO UPDATE SET
        device_name = excluded.device_name,
        last_seen = excluded.last_seen
    `).bind(deviceId, this.vaultId, deviceName, new Date().toISOString()).run();
  }

  async getDevices(): Promise<DeviceRow[]> {
    const result = await this.db.prepare(
      'SELECT * FROM devices WHERE vault_id = ?'
    ).bind(this.vaultId).all<DeviceRow>();
    return result.results;
  }

  async updateDeviceSeq(deviceId: string, seq: number): Promise<void> {
    await this.db.prepare(
      'UPDATE devices SET last_seq = ?, last_seen = ? WHERE device_id = ?'
    ).bind(seq, new Date().toISOString(), deviceId).run();
  }
}
