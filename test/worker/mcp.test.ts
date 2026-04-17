import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type WorkerMcpRuntime } from '../../packages/worker/src/handlers/mcp.js';

describe('granite worker MCP server', () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;

  beforeEach(async () => {
    const runtime = createRuntimeStub();
    server = createMcpServer(runtime);
    client = new Client({ name: 'granite-worker-test-client', version: '1.0.0' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('returns markdown tool content while keeping structured content', async () => {
    const overview = await client.callTool({
      name: 'granite_get_vault_overview',
      arguments: {},
    });
    const note = await client.callTool({
      name: 'granite_get_note',
      arguments: { slug: 'worker-note' },
    });

    const overviewData = extractStructuredContent(overview) as { note_count: number };
    const noteData = extractStructuredContent(note) as { slug: string; body: string };

    expect(overviewData.note_count).toBe(1);
    expect(noteData.slug).toBe('worker-note');
    expect(noteData.body).toContain('Worker note body');
    expect(extractTextContent(overview)).toContain('# Vault Overview');
    expect(extractTextContent(overview).trim().startsWith('{')).toBe(false);
    expect(extractTextContent(note)).toContain('# Worker Note');
    expect(extractTextContent(note)).toContain('## Body');
  });

  it('serves vault overview as a markdown resource', async () => {
    const resource = await client.readResource({ uri: 'granite://vault/overview' });
    const content = resource.contents[0];

    expect(content && 'mimeType' in content ? content.mimeType : '').toBe('text/markdown');
    expect(content && 'text' in content ? content.text : '').toContain('# Vault Overview');
  });

  it('renders list and write tools as markdown', async () => {
    const listNotes = await client.callTool({
      name: 'granite_list_notes',
      arguments: {},
    });
    const createNote = await client.callTool({
      name: 'granite_create_note',
      arguments: {
        title: 'Fresh Worker Note',
      },
    });

    const listData = extractStructuredContent(listNotes) as { notes: Array<{ slug: string }> };
    const createdData = extractStructuredContent(createNote) as { note: { slug: string } };

    expect(listData.notes[0]?.slug).toBe('worker-note');
    expect(createdData.note.slug).toBe('fresh-worker-note');
    expect(extractTextContent(listNotes)).toContain('# Notes');
    expect(extractTextContent(createNote)).toContain('# Created Note');
  });
});

function createRuntimeStub(): WorkerMcpRuntime {
  const note = {
    slug: 'worker-note',
    title: 'Worker Note',
    type: 'note',
    created: '2026-04-10T08:00:00.000Z',
    modified: '2026-04-10T09:00:00.000Z',
    tags: ['granite'],
    aliases: ['Worker Alias'],
    status: 'active',
    source: 'human',
    filepath: 'notes/worker-note.md',
    resource_uri: 'granite://notes/worker-note',
  };

  const buildNote = (slug: string, title: string) => ({
    ...note,
    slug,
    title,
    resource_uri: `granite://notes/${slug}`,
    body: slug === 'worker-note' ? 'Worker note body.\n' : '',
    frontmatter: {
      id: slug === 'worker-note' ? 'worker-1' : 'worker-2',
      title,
      type: 'note',
      created: note.created,
      modified: note.modified,
      tags: slug === 'worker-note' ? note.tags : [],
      aliases: slug === 'worker-note' ? note.aliases : [],
      status: 'active',
      source: 'human',
    },
    outgoing_links: slug === 'worker-note'
      ? [{
          raw: '[[Linked Note]]',
          target: 'Linked Note',
          display: 'Linked Note',
          resolved: false,
        }]
      : [],
  });

  return {
    async getVaultOverview() {
      return {
        vault_name: 'Worker Vault',
        default_type: 'note',
        note_count: 1,
        notes_by_type: { note: 1 },
        recent_notes: [note],
      };
    },
    async listNoteTypes() {
      return [{
        name: 'note',
        description: 'Durable knowledge note',
        folder: 'notes',
        slug_format: 'title',
        instructions: 'Keep notes concise.',
      }];
    },
    async listNotes() {
      return [note];
    },
    async getNote(slug) {
      return buildNote(slug, slug === 'worker-note' ? 'Worker Note' : 'Fresh Worker Note');
    },
    async search() {
      return [{
        slug: note.slug,
        title: note.title,
        snippet: 'Worker note body.',
        score: 0.9,
      }];
    },
    async getBacklinks() {
      return [{
        source_slug: 'other-note',
        source_title: 'Other Note',
        context: 'Links to Worker Note.',
      }];
    },
    async suggestLinks() {
      return [{
        target_slug: 'linked-note',
        target_title: 'Linked Note',
        mentions: 2,
      }];
    },
    async createNote(input) {
      return {
        note: buildNote('fresh-worker-note', input.title),
        recommendations: emptyRecommendations(),
      };
    },
    async captureNote(input) {
      return {
        note: buildNote('fresh-worker-note', input.text),
        recommendations: emptyRecommendations(),
      };
    },
    async updateNote(slug) {
      return {
        note: buildNote(slug, slug === 'worker-note' ? 'Worker Note' : 'Fresh Worker Note'),
        recommendations: emptyRecommendations(),
      };
    },
    async readVaultConfigRaw() {
      return 'vault_name: Worker Vault\n';
    },
  };
}

function emptyRecommendations() {
  return {
    additions: [],
    links: [],
    tags: [],
    next_steps: [],
  };
}

function extractStructuredContent(result: Awaited<ReturnType<Client['callTool']>>) {
  if (!('structuredContent' in result) || !result.structuredContent) {
    throw new Error('Tool result did not include structuredContent.');
  }
  return result.structuredContent;
}

function extractTextContent(result: Awaited<ReturnType<Client['callTool']>>) {
  const textContent = result.content.find(item => item.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Tool result did not include text content.');
  }
  return textContent.text;
}
