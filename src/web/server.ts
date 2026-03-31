import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import path from 'node:path';
import fs from 'node:fs';
import type { GraniteConfig } from '../core/types.js';
import { ensureIndex } from '../core/index-db.js';
import { createNote, findNoteBySlug, listNotes, readNote } from '../core/note.js';
import { searchNotes } from '../core/search.js';
import { getBacklinks } from '../core/backlinks.js';
import { parseWikilinks, resolveWikilinks } from '../core/wikilinks.js';
import { getSyncManager } from '../core/sync/manager.js';

export function createApp(vaultRoot: string, config: GraniteConfig) {
  const app = new Hono();

  // API routes
  app.get('/api/notes', (c) => {
    const db = ensureIndex(vaultRoot, config);
    const typeFilter = c.req.query('type');
    let query = 'SELECT slug, title, type, created, modified, tags FROM notes';
    const params: string[] = [];
    if (typeFilter) {
      query += ' WHERE type = ?';
      params.push(typeFilter);
    }
    query += ' ORDER BY modified DESC';
    const notes = db.prepare(query).all(...params);
    db.close();
    return c.json({ notes });
  });

  app.get('/api/notes/:slug', (c) => {
    const slug = c.req.param('slug');
    const db = ensureIndex(vaultRoot, config);
    const allNotes = listNotes(vaultRoot, config);
    const note = findNoteBySlug(vaultRoot, config, slug);

    if (!note) {
      db.close();
      return c.json({ error: 'Note not found' }, 404);
    }

    const links = parseWikilinks(note.body);
    const resolvedLinks = resolveWikilinks(links, allNotes);
    const backlinks = getBacklinks(db, slug);
    db.close();

    return c.json({
      slug: note.slug,
      title: note.frontmatter.title,
      type: note.frontmatter.type,
      created: note.frontmatter.created,
      modified: note.frontmatter.modified,
      tags: note.frontmatter.tags,
      aliases: note.frontmatter.aliases,
      body: note.body,
      outgoing_links: resolvedLinks,
      backlinks,
    });
  });

  app.get('/api/search', (c) => {
    const q = c.req.query('q');
    if (!q) return c.json({ query: '', results: [] });

    const db = ensureIndex(vaultRoot, config);
    const results = searchNotes(db, q);
    db.close();

    return c.json({ query: q, results });
  });

  app.get('/api/backlinks/:slug', (c) => {
    const slug = c.req.param('slug');
    const db = ensureIndex(vaultRoot, config);
    const backlinks = getBacklinks(db, slug);
    db.close();
    return c.json({ slug, backlinks });
  });

  app.get('/api/types', (c) => {
    return c.json({ types: config.note_types });
  });

  // Create a new note
  app.post('/api/notes', async (c) => {
    const body = await c.req.json();
    const { type, title, body: noteBody } = body;

    if (!type || !title) {
      return c.json({ error: 'type and title are required' }, 400);
    }

    try {
      const note = createNote(vaultRoot, config, type, title, noteBody || undefined);

      // Transparent sync
      const sync = getSyncManager(vaultRoot, config);
      sync?.trackAndPush(note, 'create');

      return c.json({
        slug: note.slug,
        title: note.frontmatter.title,
        type: note.frontmatter.type,
        created: note.frontmatter.created,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // Graph data — all nodes and edges
  app.get('/api/graph', (c) => {
    const db = ensureIndex(vaultRoot, config);
    const nodes = db.prepare('SELECT slug, title, type FROM notes').all();
    const edges = db.prepare('SELECT source_slug AS source, target_slug AS target FROM links WHERE target_slug IS NOT NULL').all();
    db.close();
    return c.json({ nodes, edges });
  });

  // Static files — serve from the web/public directory
  // We need to resolve the path relative to where the source files are
  const publicDir = path.join(import.meta.dirname, 'public');

  app.get('/*', (c) => {
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const filePath = path.join(publicDir, reqPath);

    if (!fs.existsSync(filePath)) {
      // SPA fallback
      const indexPath = path.join(publicDir, 'index.html');
      const html = fs.readFileSync(indexPath, 'utf-8');
      return c.html(html);
    }

    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    return new Response(content, { headers: { 'Content-Type': contentType } });
  });

  return app;
}

export function startServer(vaultRoot: string, config: GraniteConfig, port: number) {
  const app = createApp(vaultRoot, config);

  console.log(`Granite — serving vault at http://localhost:${port}`);
  console.log(`Vault: ${vaultRoot}`);
  console.log('');

  serve({ fetch: app.fetch, port });
}
