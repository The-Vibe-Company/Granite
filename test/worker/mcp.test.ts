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

  it('returns markdown tool content', async () => {
    const overview = await client.callTool({
      name: 'granite_get_vault_overview',
      arguments: {},
    });
    const note = await client.callTool({
      name: 'granite_get_note',
      arguments: { slug: 'worker-note' },
    });

    const overviewText = extractTextContent(overview);
    const noteText = extractTextContent(note);

    expect(overviewText).toContain('# Vault Overview');
    expect(overviewText.trim().startsWith('{')).toBe(false);
    expect(noteText).toContain('# Worker Note');
    expect(noteText).toContain('## Body');
    expect(noteText).toContain('Worker note body');
    expect(noteText).toContain('worker-note');
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

    const listText = extractTextContent(listNotes);
    const createdText = extractTextContent(createNote);

    expect(listText).toContain('# Notes');
    expect(listText).toContain('worker-note');
    expect(createdText).toContain('# Created Note');
    expect(createdText).toContain('fresh-worker-note');
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

function extractTextContent(result: Awaited<ReturnType<Client['callTool']>>) {
  const textContent = result.content.find(item => item.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('Tool result did not include text content.');
  }
  return textContent.text;
}
